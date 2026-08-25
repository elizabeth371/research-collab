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
from models import Document
from services.agent_orchestrator import (
    AgentType,
    OrchestratorService,
)
from services.academic_review import AcademicReviewEngine
from services.polish_engine import PolishEngine

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
    session_id: Optional[uuid.UUID] = Field(
        default=None,
        description="群聊会话 ID (可选): 传入时在同一会话线程内追加多轮消息",
    )


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
# 写稿人润色 / 审稿人红牌 (轻量端点, 不经过 LangGraph 流水线)
# ---------------------------------------------------------------------------
class PolishRequest(BaseModel):
    """润色请求体"""

    doc_id: uuid.UUID
    text: str = Field(..., min_length=1, max_length=20000, description="待润色文本 (选中文字或段落)")


class PolishChangeOut(BaseModel):
    """一条润色变更"""

    type: str    # phrasing / redundancy / punctuation / sentence
    before: str
    after: str


class PolishResponse(BaseModel):
    """润色结果"""

    polished: str
    changes: List[PolishChangeOut]
    stats: dict


class ReviewRequest(BaseModel):
    """审稿请求体"""

    doc_id: uuid.UUID


class ReviewIssueOut(BaseModel):
    """一条审稿问题 (红牌=error / 黄牌=warning)"""

    level: str
    message: str
    para_index: Optional[int] = None


class ReviewResponse(BaseModel):
    """审稿结果"""

    doc_id: str
    passed: bool
    issues: List[ReviewIssueOut]
    red_cards: int
    yellow_cards: int
    stats: dict


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
        session_id=str(payload.session_id) if payload.session_id else None,
    )

    return {
        "accepted": True,
        "session_id": session_id,
        "message": f"{payload.agent_type.value} agent 已启动",
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


# ---------------------------------------------------------------------------
# 写稿人润色 / 审稿人红牌端点
# ---------------------------------------------------------------------------
async def _ensure_doc_exists(db: AsyncSession, doc_id: uuid.UUID) -> Document:
    doc = await db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@router.post("/polish", response_model=PolishResponse)
async def polish_text(
    payload: PolishRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    写稿人润色: 对选中文本 / 段落执行学术化润色。

    优先 LLM 语义润色 (已配置 API Key 时), 失败或无 Key 自动降级到
    确定性规则引擎。stats.engine 标注实际生效模式 ('llm' / 'rule')。
    """
    await _ensure_doc_exists(db, payload.doc_id)

    from services.llm_client import llm_client

    if llm_client.is_available():
        result = await llm_client.polish_text(payload.text)
        if result is not None:
            result["stats"]["engine"] = "llm"
            return result

    result = PolishEngine.polish_text(payload.text)
    result["stats"]["engine"] = "rule"
    return result


@router.post("/review", response_model=ReviewResponse)
async def review_document(
    payload: ReviewRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    审稿人红牌检查: 对文档当前全文执行红牌/黄牌分级审查。

    读取数据库中的最新内容 (Markdown 文本), 按段落 (1 起) 定位问题,
    返回红牌 (error) / 黄牌 (warning) 计数与明细。
    """
    doc = await _ensure_doc_exists(db, payload.doc_id)
    result = AcademicReviewEngine.review_document(doc.content or "")
    return {
        "doc_id": str(payload.doc_id),
        "passed": result["passed"],
        "issues": result["issues"],
        "red_cards": result["red_cards"],
        "yellow_cards": result["yellow_cards"],
        "stats": result["stats"],
    }