"""
核心服务包
=========================
- watermark_engine.py    : Kirchenbauer 水印嵌入/检测
- stream_buffer.py       : LLM 流式输出缓冲器 (原子写入 Yjs)
- agent_orchestrator.py  : LangGraph 多 Agent 编排
- oplog_chain.py         : 操作日志哈希链工具 (版权溯源)
"""