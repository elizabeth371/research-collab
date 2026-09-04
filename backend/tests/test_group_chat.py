"""
Agent 会话复用测试 (严格串行单节点模式)
=======================================
覆盖: 同一 session_id 多次 invoke 时, 消息历史在同一线程内累积。
串行契约 (任务 D): 每次 invoke 只执行 agent_type 指定的那一个 Agent,
追加一条消息 —— 无 research -> writer -> supervisor 自动串联。
"""

import asyncio
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from main import app


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture
def demo_doc_id() -> str:
    return "00000000-0000-4000-8000-0000000000a1"


async def _invoke(client: AsyncClient, doc_id: str, session_id: str | None, instruction: str) -> str:
    resp = await client.post(
        "/api/agents/invoke",
        json={
            "doc_id": doc_id,
            "agent_type": "research",
            "instruction": instruction,
            **({"session_id": session_id} if session_id else {}),
        },
    )
    assert resp.status_code == 202, resp.text
    return resp.json()["session_id"]


async def _wait_for_messages(
    client: AsyncClient, session_id: str, expected_total: int, timeout: float = 60.0
) -> dict:
    """轮询会话消息直至达到期望条数 (invoke 返回 202, 编排在后台任务中执行)"""
    deadline = asyncio.get_running_loop().time() + timeout
    body: dict = {"total": -1}
    while asyncio.get_running_loop().time() < deadline:
        body = (await client.get(f"/api/agents/sessions/{session_id}/messages")).json()
        if body["total"] >= expected_total:
            return body
        await asyncio.sleep(0.05)
    raise AssertionError(
        f"会话 {session_id} 消息在 {timeout}s 内未达到 {expected_total} 条 "
        f"(当前 {body.get('total')})"
    )


@pytest.mark.asyncio
async def test_invoke_without_session_creates_new(client, demo_doc_id, monkeypatch):
    # 清空 API Key: 保证 Writer 走确定性规则模板 (真实 LLM 链路
    # 由 test_watermark_resample 的 key-gated 端到端单独覆盖, 避免本套件
    # 依赖网络且结果不确定)
    monkeypatch.setattr("services.llm_client.settings.LLM_API_KEY", "")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    s1 = await _invoke(client, demo_doc_id, None, "检索水印文献")
    s2 = await _invoke(client, demo_doc_id, None, "检索协同编辑文献")
    assert s1 != s2  # 未传 session_id 各自新建会话


@pytest.mark.asyncio
async def test_session_reuse_accumulates_history(client, demo_doc_id, monkeypatch):
    monkeypatch.setattr("services.llm_client.settings.LLM_API_KEY", "")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    # 第一轮: 新建会话 (单节点图: 只跑 research, 追加一条消息)
    sid = await _invoke(client, demo_doc_id, None, "检索 AI 水印文献")
    msgs1 = await _wait_for_messages(client, sid, 1)
    assert msgs1["total"] == 1
    assert msgs1["messages"][0]["agentType"] == "research"

    # 第二轮: 复用同一 session_id -> 消息历史在同一线程内追加
    sid2 = await _invoke(client, demo_doc_id, sid, "再检索 CRDT 协同文献")
    assert sid2 == sid  # 复用同一会话

    msgs2 = await _wait_for_messages(client, sid, 2)
    assert msgs2["total"] == 2  # 1 + 1, 历史不丢失
    agents2 = [m["agentType"] for m in msgs2["messages"]]
    assert agents2 == ["research", "research"]
    # 第一轮的研究结论仍在历史中
    assert "【文献检索结果" in msgs2["messages"][0]["content"]

    # 第三轮: 会话在服务器重启前持续有效
    sid3 = await _invoke(client, demo_doc_id, sid, "总结以上两轮结果")
    assert sid3 == sid
    msgs3 = await _wait_for_messages(client, sid, 3)
    assert msgs3["total"] == 3
