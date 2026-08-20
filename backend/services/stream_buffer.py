"""
StreamBufferService: LLM 流式输出缓冲器
=========================================
功能:
1. 缓冲 LLM 分块 (chunk) 输出的文本
2. 在 flush() 时将整个缓冲区内容作为"原子操作"
   通过 Ypy (Python Yjs) 一次性插入文档
3. 支持水印预检测: flush 前可对文本调用 WatermarkEngine

设计要点:
- 原子性: 使用 Y.Map transact 包裹插入，保证同房间客户端
  要么看到完整段落，要么看不到 (避免半句话渲染)
- 作者属性: 使用 Yjs RichText/Text 属性 (author=ai_agent)
  使前端可按作者着色
- 缓冲策略: 定时 + 阈值双触发 (由调用方决定)
"""

import asyncio
import time
import uuid
from typing import List, Optional, Tuple

# Ypy: Python 端 Yjs 实现
try:
    from ypy import YDoc, YText, YMap
    _YPY_AVAILABLE = True
except ImportError:  # pragma: no cover
    _YPY_AVAILABLE = False
    YDoc = None  # type: ignore
    YText = None  # type: ignore
    YMap = None  # type: ignore

from config import settings
from services.watermark_engine import WatermarkEngine


class StreamBufferService:
    """
    LLM 流式输出缓冲器。

    用法示例:
        buffer = StreamBufferService(ydoc=ydoc, text_name="content")
        for chunk in llm_stream():
            buffer.append(chunk.text)
            if buffer.should_flush():
                await buffer.flush()
        await buffer.flush(force=True)
    """

    def __init__(
        self,
        ydoc,
        text_name: str = "content",
        *,
        session_id: Optional[str] = None,
        agent_id: str = "ai-agent",
        flush_interval: float = 0.5,
        max_buffered_chars: int = 200,
    ) -> None:
        """
        Args:
            ydoc:           Ypy YDoc 实例 (协作文档)
            text_name:      Yjs 文档中文本字段名 (默认 content)
            session_id:     Agent 会话 ID (用于审计)
            agent_id:       作者标识 (默认 ai-agent; 前端据此着色)
            flush_interval: 自动刷新间隔 (秒)
            max_buffered_chars: 缓冲字符数上限, 达到即自动 flush
        """
        self.ydoc = ydoc
        self.text_name = text_name
        self.session_id = session_id or str(uuid.uuid4())
        self.agent_id = agent_id
        self.flush_interval = flush_interval
        self.max_buffered_chars = max_buffered_chars

        self._buffer: List[str] = []
        self._last_flush_time: float = time.monotonic()
        self._lock = asyncio.Lock()  # 异步环境防并发 flush

        # 惰性初始化 Yjs 文本对象
        self._ytext: Optional[object] = None

        # 水印引擎 (可选: flush 前对缓冲文本做水印自检)
        self.watermark_engine = WatermarkEngine()

        if not _YPY_AVAILABLE:
            # 环境未安装 ypy 时的降级提示
            import warnings

            warnings.warn(
                "ypy 未安装，StreamBufferService 将运行在降级模式 "
                "(仅内存缓冲，不写入 Yjs 文档)。"
                "pip install ypy 以启用完整功能。",
                RuntimeWarning,
            )

    # ------------------------------------------------------------------
    # Yjs 文本访问 (惰性连接)
    # ------------------------------------------------------------------
    def _get_ytext(self):
        """获取或创建 Yjs 文本对象"""
        if _YPY_AVAILABLE and self._ytext is None:
            # 在 Yjs 文档事务中获取文本 Map
            with self.ydoc.begin_transaction() as txn:
                root_map = self.ydoc.get_map("root")  # type: ignore
                if self.text_name not in root_map:
                    root_map.set(txn, self.text_name, YText(""))
                self._ytext = root_map.get(self.text_name)
        return self._ytext

    # ------------------------------------------------------------------
    # 缓冲操作
    # ------------------------------------------------------------------
    def append(self, chunk: str) -> None:
        """
        追加一个 LLM 输出分块到缓冲区。

        Args:
            chunk: LLM 流式输出的文本片段
        """
        if not chunk:
            return
        self._buffer.append(chunk)

    def append_tokens(self, tokens: List[str]) -> None:
        """批量追加多个 token"""
        self._buffer.extend(t for t in tokens if t)

    def peek(self) -> str:
        """查看当前缓冲区内容 (不消费)"""
        return "".join(self._buffer)

    @property
    def buffered_chars(self) -> int:
        """当前缓冲字符数"""
        return sum(len(c) for c in self._buffer)

    def should_flush(self) -> bool:
        """
        判断是否应该触发 flush:
        - 缓冲字符数达到上限
        - 距离上次 flush 超过间隔
        """
        if self.buffered_chars >= self.max_buffered_chars:
            return True
        if not self._buffer:
            return False
        return (time.monotonic() - self._last_flush_time) >= self.flush_interval

    # ------------------------------------------------------------------
    # 原子写入 Yjs
    # ------------------------------------------------------------------
    async def flush(self, *, force: bool = False) -> Tuple[bool, str]:
        """
        将缓冲区内容作为原子操作写入 Yjs 文档。

        Args:
            force: 为 True 时即使缓冲为空也尝试执行

        Returns:
            (是否实际写入, 写入内容摘要信息)
        """
        async with self._lock:
            content = self.peek()
            if not content and not force:
                return False, "buffer empty, skipped"

            # 清理缓冲区 (先取出后清除, 避免异常时数据丢失)
            self._buffer.clear()
            self._last_flush_time = time.monotonic()

            if not _YPY_AVAILABLE or self.ydoc is None:
                # 降级模式: 仅记录日志
                print(f"[StreamBuffer] (fallback) flush {len(content)} chars")
                return False, "ypy unavailable, fallback mode"

            # ---- 原子插入 Yjs (可选水印自检) ----
            ytext = self._get_ytext()
            if ytext is None:
                return False, "ytext not initialized"

            # 水印自检 (研发阶段调试输出; 不影响写入)
            detect_result = self.watermark_engine.detect_watermark(content)
            if detect_result["is_ai_generated"]:
                print(
                    f"[StreamBuffer] 检测到水印: "
                    f"confidence={detect_result['confidence']:.2f}"
                )

            # 在 Yjs 事务中写入 (原子性保证)
            with self.ydoc.begin_transaction() as txn:
                # 使用 Author 属性 (若 YText 支持格式化属性)
                #   Ypy 的 YText 可携带 text attributes,
                #   以 author 区分 AI/人类输入
                try:
                    ytext.insert(
                        txn,
                        len(ytext),
                        content,
                        attributes={"author": self.agent_id},
                    )
                except TypeError:
                    # 旧版本 ypy 可能不支持 attributes 参数
                    ytext.insert(txn, len(ytext), content)

                # TODO: 记录 OpLog 哈希链条目
                #   - compute prev_hash / current_hash
                #   - 持久化到 op_logs 表 (doc_id, user_id=agent, op_type='ai_generate')

            return True, f"flushed {len(content)} chars"

    # ------------------------------------------------------------------
    # 状态查询
    # ------------------------------------------------------------------
    def get_stats(self) -> dict:
        """返回缓冲器统计信息"""
        return {
            "session_id": self.session_id,
            "agent_id": self.agent_id,
            "buffered_chars": self.buffered_chars,
            "last_flush_delta": round(
                time.monotonic() - self._last_flush_time, 3
            ),
            "len_buffer_chunks": len(self._buffer),
        }