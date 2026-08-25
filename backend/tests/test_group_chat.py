"""
Agent 群聊会话测试
==================
覆盖: 同一 session_id 多次 invoke 时, 消息历史在同一线程内累积
(多轮追问 -> 每轮 research/writer/supervisor 各追加一条, 历史不丢失)。
"""

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
    # 第一轮: 新建会话
    sid = await _invoke(client, demo_doc_id, None, "检索 AI 水印文献")
    msgs1 = (await client.get(f"/api/agents/sessions/{sid}/messages")).json()
    assert msgs1["total"] == 3  # research + writer + supervisor

    # 第二轮: 复用同一 session_id -> 消息历史在同一线程内追加
    sid2 = await _invoke(client, demo_doc_id, sid, "再检索 CRDT 协同文献")
    assert sid2 == sid  # 复用同一会话

    msgs2 = (await client.get(f"/api/agents/sessions/{sid}/messages")).json()
    assert msgs2["total"] == 6  # 3 + 3, 历史不丢失
    agents2 = [m["agentType"] for m in msgs2["messages"]]
    assert agents2 == ["research", "writer", "supervisor"] * 2
    # 第一轮的研究结论仍在历史中
    assert "【文献检索结果" in msgs2["messages"][0]["content"]

    # 第三轮: 会话在服务器重启前持续有效
    sid3 = await _invoke(client, demo_doc_id, sid, "总结以上两轮结果")
    assert sid3 == sid
    msgs3 = (await client.get(f"/api/agents/sessions/{sid}/messages")).json()
    assert msgs3["total"] == 9
