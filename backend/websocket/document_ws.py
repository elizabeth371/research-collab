"""
WebSocket 协同服务 (Yjs CRDT 实时同步)
=======================================
实现 `/ws/{doc_id}` 端点, 兼容 y-websocket 协议:

消息格式 (首字节为消息类型, 后续为 varUint 编码):
  0x00 SYNC      - CRDT 状态同步
  0x01 AWARENESS - 光标/在线状态 (多光标展示)
  0x02 AUTH      - 鉴权 (预留)

SYNC 子类型 (消息第二字节, varUint):
  0x00 SYNC_STEP1  - 一方发送状态向量, 请求增量
  0x01 SYNC_STEP2  - 响应: 返回增量更新 (diff update)
  0x02 SYNC_UPDATE - 任意方向: 广播增量更新

关键协议细节 (与 y-websocket 客户端保持一致):
  - update / state vector 以 varUint8Array 编码: [varUint(len), bytes...]
  - 空 update 必须编码为 [0x00] (长度 0), 不能是裸空字节

工作流程 (纯转发模式, 无服务端 YDoc):
  1. 客户端连接 -> 服务端接受 + 声明 subprotocol "yjs"
  2. 客户端发送 SYNC_STEP1 (自身状态向量)
  3. 服务端回复空 update (SYNC_STEP2), 客户端进入 synced 状态
  4. 客户端本地编辑 -> SYNC_UPDATE -> 服务端转发给房间内其他客户端
  5. awareness 消息原样转发 (光标/在线状态)
"""

import asyncio
import logging
from typing import Dict, List, Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)
# 开发调试: 显示模块 INFO 日志 (协议收发追踪)
logging.basicConfig(level=logging.INFO)

collaborative_router = APIRouter()

# ---------------------------------------------------------------------------
# y-websocket 协议常量
# ---------------------------------------------------------------------------
MSG_SYNC = 0
MSG_AWARENESS = 1
MSG_AUTH = 2

SYNC_STEP1 = 0
SYNC_STEP2 = 1
SYNC_UPDATE = 2

# 支持的 subprotocol (y-websocket 客户端探测)
SUPPORTED_SUBPROTOCOLS = ["yjs", "ycrdt,0.4.2"]


# ---------------------------------------------------------------------------
# varUint / varUint8Array 编解码 (与 y-protocols 编码一致)
# ---------------------------------------------------------------------------
def encode_var_uint(value: int) -> bytes:
    """LEB128 变长无符号整数编码"""
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)


def decode_var_uint(data: bytes, offset: int = 0):
    """
    LEB128 解码。
    Returns: (value, next_offset)
    """
    value = 0
    shift = 0
    while offset < len(data):
        b = data[offset]
        offset += 1
        value |= (b & 0x7F) << shift
        if not (b & 0x80):
            return value, offset
        shift += 7
    raise ValueError("varUint 解码失败: 数据不完整")


def encode_var_uint8_array(payload: bytes) -> bytes:
    """varUint8Array 编码: [varUint(len), bytes...]"""
    return encode_var_uint(len(payload)) + payload


def decode_var_uint8_array(data: bytes, offset: int = 0):
    """varUint8Array 解码。Returns: (payload, next_offset)"""
    length, offset = decode_var_uint(data, offset)
    if offset + length > len(data):
        raise ValueError("varUint8Array 解码失败: 数据不完整")
    return data[offset : offset + length], offset + length


# ---------------------------------------------------------------------------
# 房间管理器: 按文档维护连接 (纯转发模式, 不持有 YDoc 状态)
# ---------------------------------------------------------------------------
class RoomManager:
    """
    协作文档房间管理器。

    当前为纯转发模式: 服务端仅维护连接列表并转发 Yjs 更新,
    不维护 CRDT 状态 (客户端持有完整状态, CRDT 保证收敛一致)。
    """

    def __init__(self) -> None:
        self._connections: Dict[str, Set[WebSocket]] = {}

    # ---- 连接管理 ----
    async def connect(self, doc_id: str, ws: WebSocket) -> None:
        """注册一个连接"""
        await ws.accept(subprotocol="yjs")
        self._connections.setdefault(doc_id, set()).add(ws)

    def disconnect(self, doc_id: str, ws: WebSocket) -> None:
        """移除一个连接"""
        conns = self._connections.get(doc_id)
        if conns:
            conns.discard(ws)
            if not conns:
                self._connections.pop(doc_id, None)

    def room_connections(self, doc_id: str) -> List[WebSocket]:
        """获取房间内所有连接"""
        return list(self._connections.get(doc_id, set()))

    # ---- 消息广播 ----
    async def broadcast_update(
        self, doc_id: str, update: bytes, exclude: Optional[WebSocket] = None
    ) -> None:
        """
        向房间内所有客户端广播 Yjs 增量更新。

        Args:
            doc_id: 文档 ID
            update: 完整协议消息 (已含 MSG_SYNC + SYNC_UPDATE 头)
            exclude: 排除的发送者连接 (不 Echo 回去)
        """
        for ws in list(self._connections.get(doc_id, set())):
            if ws is exclude:
                continue
            try:
                await ws.send_bytes(update)
            except Exception:
                logger.warning("广播失败, 剔除连接: %s", ws)
                self.disconnect(doc_id, ws)


# 全局房间管理器 (单例)
room_manager = RoomManager()


# ---------------------------------------------------------------------------
# WebSocket 端点的消息处理
# ---------------------------------------------------------------------------
async def handle_sync(
    ws: WebSocket,
    doc_id: str,
    message: bytes,
    room: RoomManager,
) -> None:
    """
    处理 SYNC 消息 (CRDT 状态同步)。

    消息格式: [SYNC_TYPE(varUint)] [payload(varUint8Array)]

    - SYNC_STEP1: 客户端发送状态向量 -> 服务端回复空 update
      (纯转发模式无服务端状态, 客户端随后会广播自己的完整状态)
    - SYNC_STEP2: 客户端回传补丁 update -> 转发给房间其他客户端
    - SYNC_UPDATE: 客户端广播 update -> 转发给房间其他客户端
    """
    if len(message) < 1:
        return

    sync_type = message[0]
    try:
        payload, _ = decode_var_uint8_array(message, 1) if len(message) > 1 else (b"", 1)
    except ValueError:
        logger.warning("SYNC 消息 payload 解码失败: %r", message[:16])
        return

    # ---- 同步步骤: 下发状态向量 (服务端主动发起) ----
    if sync_type == SYNC_STEP1:
        # 纯转发模式: 无服务端状态, 回复空 update
        # 客户端收到空 update 后完成初次同步 (进入 synced 状态)
        # 注意: Yjs 空 update 必须为 [0x00, 0x00] (delete 集与插入集长度均为 0),
        # 不能是 0 字节或单字节 [0x00], 否则客户端 applyUpdate 抛
        # "Unexpected end of array" (lib0 readVarUint 数据耗尽).
        empty_update = b"\x00\x00"
        await ws.send_bytes(
            bytes([MSG_SYNC, SYNC_STEP2]) + encode_var_uint8_array(empty_update)
        )

    # ---- 同步步骤: 客户端回传补丁 ----
    elif sync_type == SYNC_STEP2:
        if not payload:
            return
        # 转发给其他客户端: 以 SYNC_UPDATE 协议头广播
        await room.broadcast_update(
            doc_id,
            bytes([MSG_SYNC, SYNC_UPDATE]) + encode_var_uint8_array(payload),
            exclude=ws,
        )

    # ---- 同步更新: 客户端主动广播 ----
    elif sync_type == SYNC_UPDATE:
        if not payload:
            return
        await room.broadcast_update(
            doc_id,
            bytes([MSG_SYNC, SYNC_UPDATE]) + encode_var_uint8_array(payload),
            exclude=ws,
        )


async def handle_awareness(
    ws: WebSocket,
    doc_id: str,
    message: bytes,
    room: RoomManager,
) -> None:
    """
    处理 AWARENESS 消息 (光标/在线状态, 用于多光标渲染)。

    客户端发来 awareness update (实时光标位置/用户名/颜色),
    服务端原样转发给同房间其他客户端 (排除发送者)。
    """
    if len(message) < 1:
        return
    for peer in room.room_connections(doc_id):
        if peer is ws:
            continue  # 不回传给自己
        try:
            await peer.send_bytes(bytes([MSG_AWARENESS]) + message[1:])
        except Exception:
            room.disconnect(doc_id, peer)


async def handle_auth(ws: WebSocket, message: bytes) -> None:
    """处理 AUTH 消息 (鉴权, 预留)。当前骨架: 接受所有连接。"""
    try:
        token = message.decode("utf-8", errors="ignore")
        logger.debug("AUTH 消息: %s", token)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# WebSocket 端点
# ---------------------------------------------------------------------------
@collaborative_router.websocket("/ws/{doc_id}")
async def collaborative_endpoint(
    websocket: WebSocket,
    doc_id: str,
) -> None:
    """
    Yjs CRDT 实时协同端点。

    Args:
        websocket: WebSocket 连接
        doc_id:    目标文档 ID

    URL: /ws/{doc_id}
    """
    room = room_manager

    # 接受连接 (声明 yjs subprotocol)
    await room.connect(doc_id, websocket)

    logger.info(
        "客户端接入协作文档 %s (当前 %d 人)",
        doc_id,
        len(room.room_connections(doc_id)),
    )

    try:
        while True:
            # 等待客户端消息
            data = await websocket.receive_bytes()

            if not data:
                continue

            msg_type = data[0]

            if msg_type == MSG_SYNC:
                await handle_sync(websocket, doc_id, data[1:], room)

            elif msg_type == MSG_AWARENESS:
                await handle_awareness(websocket, doc_id, data, room)

            elif msg_type == MSG_AUTH:
                await handle_auth(websocket, data[1:])

            else:
                logger.warning("未知消息类型: %s", msg_type)

    except WebSocketDisconnect:
        logger.info("客户端断开: %s", doc_id)
    except Exception as exc:
        logger.error("WebSocket 异常: %s", exc)
    finally:
        room.disconnect(doc_id, websocket)


# ---------------------------------------------------------------------------
# 便捷方法: broadcast_state (供其他服务调用)
# ---------------------------------------------------------------------------
async def broadcast_state(doc_id: str, update: bytes) -> None:
    """
    将文档状态同步给该文档房间的所有客户端。

    供 AgentOrchestrator / StreamBufferService 在 AI 产出内容后调用,
    将 Yjs 更新实时推送到所有协作者。

    Args:
        doc_id: 目标文档 ID
        update: Yjs update message (不含协议头时自动包装)
    """
    # 包装为 SYNC_UPDATE 协议格式并广播
    await room_manager.broadcast_update(
        doc_id, bytes([MSG_SYNC, SYNC_UPDATE]) + encode_var_uint8_array(update)
    )
