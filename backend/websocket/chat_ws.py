"""
WebSocket 聊天服务 (步骤 16)
================================
实现 `/ws/chat/{doc_id}` JSON 协议, 支撑同文档房间内的师生/同伴实时讨论
(申报书「即时通讯」承诺项)。

协议 (JSON 文本帧):
  - 客户端 -> 服务端: {"type":"chat","content":"...","user_id":"...","username":"..."}
  - 服务端 -> 房间内所有连接 (含发送者, 前端不重复追加):
      {"type":"chat","id":"<消息ID>","content":"...","user_id":"...","username":"..."}
      (id 为服务端生成的消息 ID, 供前端去重; 持久化失败时缺失)

行为:
  - 连接按 doc_id 分组为房间, 断开自动移出;
  - 消息先持久化到 chat_messages 表 (供新成员加载历史), 再广播;
  - 持久化失败不阻断广播 (消息仍实时送达, 仅历史缺失)。
"""

import logging
import uuid
from typing import Dict, Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

chat_router = APIRouter()

# 房间表: {doc_id: set[WebSocket]}
_rooms: Dict[str, Set[WebSocket]] = {}


async def _persist_message(
    doc_id: str, user_id: str, username: str, content: str
) -> Optional[str]:
    """将聊天消息写入 chat_messages 表, 返回消息 ID (失败仅记录, 不阻断广播)"""
    from database import async_session_factory
    from models import ChatMessage

    try:
        msg_id = uuid.uuid4()
        async with async_session_factory() as db:
            db.add(
                ChatMessage(
                    id=msg_id,
                    doc_id=uuid.UUID(doc_id),
                    user_id=uuid.UUID(user_id) if user_id else None,
                    username=username,
                    content=content,
                )
            )
            await db.commit()
        return str(msg_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("聊天消息持久化失败 (仅广播): %s", exc)
        return None


@chat_router.websocket("/ws/chat/{doc_id}")
async def chat_endpoint(websocket: WebSocket, doc_id: str) -> None:
    await websocket.accept()
    room = _rooms.setdefault(doc_id, set())
    room.add(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            if not isinstance(data, dict) or data.get("type") != "chat":
                continue
            content = str(data.get("content") or "").strip()
            if not content or len(content) > 2000:
                continue
            user_id = str(data.get("user_id") or "")
            username = str(data.get("username") or "匿名")[:128]

            # 广播给房间内所有连接 (含发送者); id 供前端按 ID 去重
            msg_id = await _persist_message(doc_id, user_id, username, content)
            payload = {
                "type": "chat",
                "content": content,
                "user_id": user_id,
                "username": username,
            }
            if msg_id:
                payload["id"] = msg_id
            for conn in list(room):
                try:
                    await conn.send_json(payload)
                except Exception:  # noqa: BLE001
                    room.discard(conn)
    except WebSocketDisconnect:
        pass
    finally:
        room.discard(websocket)
        if not room:
            _rooms.pop(doc_id, None)
