"""
LLM 客户端可插拔降级测试
========================
覆盖:
- 无 Key: is_available()=False, chat()/polish_text()/write_draft() 返回 None (不触网)
- 有 Key (mock OpenAI 客户端): chat 返回真实内容, polish_text 规范化输出
- 容错 JSON 解析: 代码围栏 / 纯 JSON / 垃圾文本
- writer_agent_node: 无 Key 降级到【模拟写作草稿 · 规则模式】
- /api/agents/polish: 无 Key 走规则引擎 (stats.engine='rule'); mock LLM 时走
  LLM (stats.engine='llm') —— 可插拔切换不破坏响应结构
"""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from main import app
from services.agent_orchestrator import writer_agent_node
from services.llm_client import llm_client


# ---------------------------------------------------------------------------
# 无 Key 降级 (默认测试环境无 Key, 不触网)
# ---------------------------------------------------------------------------
def test_no_key_not_available(monkeypatch):
    monkeypatch.setattr("services.llm_client.settings.LLM_API_KEY", "")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert llm_client.is_available() is False
    assert llm_client.mode() == "rule"


@pytest.mark.asyncio
async def test_chat_returns_none_without_key(monkeypatch):
    monkeypatch.setattr("services.llm_client.settings.LLM_API_KEY", "")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    result = await llm_client.chat([{"role": "user", "content": "hi"}])
    assert result is None


@pytest.mark.asyncio
async def test_polish_returns_none_without_key(monkeypatch):
    monkeypatch.setattr("services.llm_client.settings.LLM_API_KEY", "")
    result = await llm_client.polish_text("我们做了实验。")
    assert result is None


# ---------------------------------------------------------------------------
# 容错 JSON 解析
# ---------------------------------------------------------------------------
def test_extract_json_fenced():
    text = '```json\n{"polished": "a", "changes": []}\n```'
    assert llm_client._extract_json(text) == {"polished": "a", "changes": []}


def test_extract_json_plain_with_prose():
    text = '好的，结果如下：{"polished": "b"} 希望有帮助'
    assert llm_client._extract_json(text) == {"polished": "b"}


def test_extract_json_garbage():
    assert llm_client._extract_json("抱歉，我无法完成该任务。") is None
    assert llm_client._extract_json("") is None
    assert llm_client._extract_json("[1,2,3]") is None


# ---------------------------------------------------------------------------
# mock OpenAI 兼容客户端 (不触网)
# ---------------------------------------------------------------------------
class _FakeMessage:
    content: str

    def __init__(self, content: str):
        self.content = content


class _FakeChoice:
    def __init__(self, content: str):
        self.message = _FakeMessage(content)


class _FakeResponse:
    def __init__(self, content: str):
        self.choices = [_FakeChoice(content)]


class _FakeCompletions:
    def __init__(self, content: str):
        self._content = content

    async def create(self, **kwargs):
        return _FakeResponse(self._content)


class _FakeChat:
    def __init__(self, content: str):
        self.completions = _FakeCompletions(content)


class _FakeOpenAI:
    def __init__(self, content: str):
        self.chat = _FakeChat(content)


def _enable_llm(monkeypatch, content: str):
    """模拟已配置 Key 且模型固定回复 content"""
    monkeypatch.setattr("services.llm_client.settings.LLM_API_KEY", "sk-test")
    monkeypatch.setattr("services.llm_client.settings.LLM_MODEL", "fake-model")
    monkeypatch.setattr(
        llm_client, "_get_client", lambda: _FakeOpenAI(content)
    )
    return content


@pytest.mark.asyncio
async def test_chat_with_mock_client(monkeypatch):
    _enable_llm(monkeypatch, "这是一段真实生成的研究草稿。")
    result = await llm_client.chat([{"role": "user", "content": "写一段"}])
    assert result == "这是一段真实生成的研究草稿。"


@pytest.mark.asyncio
async def test_write_draft_with_mock_client(monkeypatch):
    _enable_llm(monkeypatch, "本文提出一种面向科研诚信的多Agent协同溯源框架。")
    draft = await llm_client.write_draft("撰写引言", "检索结果: ...")
    assert draft.startswith("本文提出")


@pytest.mark.asyncio
async def test_polish_text_normalizes_llm_output(monkeypatch):
    _enable_llm(
        monkeypatch,
        '```json\n{"polished": "本研究开展了系统性实验。", "changes": '
        '[{"type": "phrasing", "before": "我们做了", "after": "本研究开展了"}]}\n```',
    )
    result = await llm_client.polish_text("我们做了实验。")
    assert result is not None
    assert result["polished"] == "本研究开展了系统性实验。"
    assert result["changes"][0]["type"] == "phrasing"
    assert result["stats"]["change_count"] == 1
    assert result["stats"]["chars_before"] == len("我们做了实验。")


@pytest.mark.asyncio
async def test_polish_text_falls_back_when_llm_garbage(monkeypatch):
    _enable_llm(monkeypatch, "抱歉，我无法输出 JSON。")
    result = await llm_client.polish_text("我们做了实验。")
    assert result is None


# ---------------------------------------------------------------------------
# writer_agent_node: 无 Key 降级模板
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_writer_agent_node_fallback_template(monkeypatch):
    monkeypatch.setattr("services.llm_client.settings.LLM_API_KEY", "")
    state = {
        "research_output": "1. Kirchenbauer et al. (2023) 提出绿名单水印方案。",
        "writing_task": "撰写引言",
        "messages": [],
        "metadata": {},
    }
    out = await writer_agent_node(state)
    assert "模拟写作草稿 · 规则模式" in out["draft"]
    assert out["metadata"]["writer_engine"] == "rule"
    assert out["messages"][-1]["agent"] == "writer"


# ---------------------------------------------------------------------------
# /api/agents/polish: 可插拔切换 (规则 <-> LLM)
# ---------------------------------------------------------------------------
@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def _create_doc(client: AsyncClient, content: str = "") -> str:
    resp = await client.post(
        "/api/documents",
        json={
            "title": f"测试文档-LLM-{uuid.uuid4().hex[:8]}",
            "owner_id": "00000000-0000-4000-8000-000000000001",
            "content": content,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_api_polish_rule_engine_when_no_key(client, monkeypatch):
    monkeypatch.setattr("services.llm_client.settings.LLM_API_KEY", "")
    doc_id = await _create_doc(client)
    resp = await client.post(
        "/api/agents/polish", json={"doc_id": doc_id, "text": "我们做了实验。"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "本研究开展了实验" in body["polished"]
    assert body["stats"]["engine"] == "rule"


@pytest.mark.asyncio
async def test_api_polish_llm_mode_when_configured(client, monkeypatch):
    async def _fake_polish(text: str) -> dict:
        return {
            "original": text,
            "polished": "LLM 润色后的学术表述。",
            "changes": [
                {"type": "phrasing", "before": "原文", "after": "LLM 润色后的学术表述"}
            ],
            "stats": {
                "chars_before": len(text),
                "chars_after": len("LLM 润色后的学术表述。"),
                "change_count": 1,
            },
        }

    # 直接 patch 共享单例对象 (api.agents 通过同一实例导入, 函数内 import 亦可生效)
    monkeypatch.setattr(llm_client, "is_available", lambda: True)
    monkeypatch.setattr(llm_client, "polish_text", _fake_polish)
    doc_id = await _create_doc(client)
    resp = await client.post(
        "/api/agents/polish", json={"doc_id": doc_id, "text": "原文"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["polished"] == "LLM 润色后的学术表述。"
    assert body["stats"]["engine"] == "llm"
    assert isinstance(body["changes"], list)
