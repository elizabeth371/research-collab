"""
Agent API
================
提供 Agent 的触发、状态查询、会话消息接口。
实际 LLM 调用与 LangGraph 编排位于 services/agent_orchestrator.py。
此文件仅负责 HTTP 层对接。
"""

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from services.agent_orchestrator import (
    AgentType,
    OrchestratorService,
)

router = APIRouter(prefix="/api/agents", tags=["agents"])

# 全局单例编排器 (跨请求保留会话, 供消息轮询接口查询)
orchestrator = OrchestratorService()


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------
class AgentInvokeRequest(BaseModel):
    """触发 Agent 请求体"""

    doc_id: uuid.UUID
    agent_type: AgentType
    instruction: str = Field(..., min_length=1, description="给 Agent 的具体指令")


class AgentStateOut(BaseModel):
    """Agent 状态响应"""

    type: AgentType
    status: str
    doc_id: Optional[uuid.UUID] = None
    current_step: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None


class AgentSessionOut(BaseModel):
    """Agent 会话摘要"""

    session_id: uuid.UUID
    doc_id: uuid.UUID
    status: str
    created_at: str


# ---------------------------------------------------------------------------
# API 端点
# ---------------------------------------------------------------------------
@router.post("/invoke", status_code=202)
async def invoke_agent(
    payload: AgentInvokeRequest,
) -> dict:
    """
    触发 ResearchAgent / WriterAgent / SupervisorAgent。

    返回 202 Accepted:
    任务在后台异步运行 (FastAPI BackgroundTasks),
    结果通过 WebSocket `/ws/{doc_id}` 实时推送至前端。
    """
    # TODO: 接入 FastAPI BackgroundTasks 或 Celery 任务队列
    # 骨架实现: 直接调用编排服务 (同步演示, 模拟耗时 <1s)
    session_id: str = await orchestrator.start_session(
        doc_id=str(payload.doc_id),
        agent_type=payload.agent_type,
        instruction=payload.instruction,
    )

    return {
        "accepted": True,
        "session_id": session_id,
        "message": f"{payload.agent_type} agent 已启动",
    }


@router.get("/sessions/{session_id}/state", response_model=AgentStateOut)
async def get_agent_state(
    session_id: uuid.UUID,
) -> dict:
    """查询 Agent 会话当前状态"""
    session = orchestrator.get_session(str(session_id))
    if session is None:
        return {
            "type": AgentType.SUPERVISOR,
            "status": "idle",
            "doc_id": None,
            "current_step": None,
            "started_at": None,
            "finished_at": None,
        }
    return {
        "type": session.get("agent_type", AgentType.SUPERVISOR),
        "status": session.get("status", "idle"),
        "doc_id": session.get("doc_id"),
        "current_step": None,
        "started_at": None,
        "finished_at": None,
    }


@router.get("/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: uuid.UUID,
    limit: int = 50,
) -> dict:
    """
    获取 Agent 会话历史消息 (用于前端回放流式输出)。
    将编排器内部消息映射为前端 AgentMessage 结构 (camelCase)。
    """
    session = orchestrator.get_session(str(session_id))
    raw = (session or {}).get("state", {}).get("messages", [])

    messages = [
        {
            "id": f"{session_id}-{i}",
            "sessionId": str(session_id),
            "agentType": m.get("agent", "supervisor"),
            "role": m.get("role", "agent"),
            "content": m.get("content", ""),
            "phase": "done",
            "createdAt": None,
        }
        for i, m in enumerate(raw)
    ][:limit]

    return {
        "session_id": str(session_id),
        "messages": messages,
        "total": len(messages),
    }