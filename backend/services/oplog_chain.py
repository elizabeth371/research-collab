"""
操作日志哈希链工具 (版权溯源核心)
==================================
日志链结构:
    current_hash = sha256(f"{prev_hash}|{operation_json}|{timestamp}|{salt}")

- 每条操作日志记录 prev_hash 与 current_hash 形成单向链表。
- 对任一历史日志的修改都会导致其后继日志 current_hash 校验失败。
- 服务端可遍历链并逐条校验，实现防篡改追溯。

该工具同时被:
- api/watermark.py 的 verify_provenance 端点使用
- 未来写入 OpLog 时用于生成哈希
"""

import asyncio
import hashlib
import json
import threading
import time
from datetime import datetime
from typing import Dict, Tuple

from config import settings

# ---------------------------------------------------------------------------
# 溯源链追加串行化 (缺陷 D1 修复, 见 docs/AI测试验收报告_20260820.md 第四节)
# ---------------------------------------------------------------------------
# op_logs.current_hash 列存在 UNIQUE 约束, 而追加日志是"读链尾 prev_hash ->
# 计算 current_hash -> 写入"的读后写流程。并发写入同一文档时, 多个请求会
# 读到相同的链尾, 在相同秒内 (SQLite CURRENT_TIMESTAMP 秒级精度) 算出相同
# current_hash, 违反 UNIQUE 约束 -> 500 Internal Server Error 且溯源链断裂。
#
# 修复: 按 doc_id 粒度的进程内 asyncio.Lock, 将"读文档/读链尾 -> 追加 ->
# 提交"整段串行化, 从根上消除读后写竞态。对已存在的 SQLite 库同样生效
# (无需迁移 schema —— 串行化后 UNIQUE 约束永不被并发触发)。
#
# 锁表回收: 表项 (锁, 最近取用时刻) 随访问过的文档数增长。取锁时若表
# 超过阈值, 回收闲置超过 _LOCK_IDLE_SECONDS 的表项 —— 闲置如此之久不可能是
# 在途请求刚取走的锁, 不会引入并发回退。
_oplog_append_locks: Dict[str, Tuple[asyncio.Lock, float]] = {}
_oplog_append_locks_guard = threading.Lock()
_MAX_LOCK_TABLE_SIZE = 1024
_LOCK_IDLE_SECONDS = 60.0


def oplog_append_lock(doc_id) -> asyncio.Lock:
    """获取指定文档的溯源链追加串行化锁 (按 doc_id 复用, 不同文档可并行)。

    调用方须以 `async with oplog_append_lock(doc_id):` 包住
    「读链尾 -> 写 OpLog -> commit」的完整事务, 锁在提交后释放。
    """
    key = str(doc_id)
    now = time.monotonic()
    with _oplog_append_locks_guard:
        entry = _oplog_append_locks.get(key)
        if entry is None:
            if len(_oplog_append_locks) >= _MAX_LOCK_TABLE_SIZE:
                stale = [
                    k
                    for k, (_, last_used) in _oplog_append_locks.items()
                    if now - last_used > _LOCK_IDLE_SECONDS
                ]
                for k in stale:
                    del _oplog_append_locks[k]
            entry = (asyncio.Lock(), now)
        else:
            entry = (entry[0], now)  # 刷新最近取用时刻
        _oplog_append_locks[key] = entry
        return entry[0]


class OpLogHashChain:
    """操作日志哈希链计算器"""

    @staticmethod
    def compute_hash(
        prev_hash: str,
        operation: dict | list,
        timestamp: float | datetime,
        *,
        salt: str | None = None,
    ) -> str:
        """
        计算单条日志的 current_hash。

        Args:
            prev_hash:   前一条日志的 current_hash (链首为 "")
            operation:   操作内容 (JSONB 内容，需稳定序列化)
            timestamp:   操作时间 (float 秒级时间戳 或 datetime)
            salt:        哈希盐，默认使用全局配置

        Returns:
            64 位十六进制 SHA256 哈希字符串
        """
        # 规范化时间戳
        if isinstance(timestamp, datetime):
            ts = timestamp.timestamp()
        else:
            ts = float(timestamp)

        # 稳定序列化 operation (ensure_ascii + 排序键)
        op_json = json.dumps(operation, ensure_ascii=False, sort_keys=True)

        salt_value = salt if salt is not None else settings.HASHCHAIN_SALT

        payload = f"{prev_hash}|{op_json}|{ts:.6f}|{salt_value}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    @staticmethod
    def verify_chain(entries: list["ChainEntry"]) -> bool:
        """
        校验整条哈希链。

        Args:
            entries: 按时间正序排列的链条目，
                     每条需包含字段:
                     - operation
                     - current_hash
                     - created_at (datetime 或 float)
                     (链首条目的 prev_hash 字段将被忽略，从 "" 开始计算)

        Returns:
            True 表示链完整且未被篡改
        """
        prev_hash = ""
        for entry in entries:
            expected = OpLogHashChain.compute_hash(
                prev_hash=prev_hash,
                operation=entry.get("operation"),
                timestamp=entry.get("created_at"),
            )
            if entry.get("current_hash") != expected:
                return False
            prev_hash = entry["current_hash"]
        return True


# 类型别名 (避免强依赖 SQLAlchemy 模型，供纯数据结构使用)
from typing import TypedDict, Union


class ChainEntry(TypedDict, total=False):
    """哈希链条目结构 (兼容 ORM 对象与普通字典)"""

    operation: Union[dict, list]
    current_hash: str
    created_at: Union[datetime, float]