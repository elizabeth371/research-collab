"""
Writer Agent 输入/输出契约测试 (任务 E)
=======================================
覆盖:
- 输入契约: writer_input = {user_topic, confirmed_literature,
  additional_requirements} 正确进入 writer_agent_node 与 writer_messages
- 输出契约: 结构化 Markdown (「# 标题」+「## 参考文献」[n] 编号 +「## 正文」)
- 兼容性: 无 writer_input 时退回 writing_task + literature_context;
  无文献时保持旧降级模板
- 与审稿红牌规则自洽: 降级产物不因引用编号/参考文献章节被判红牌
"""

import pytest

from services.academic_review import AcademicReviewEngine
from services.agent_orchestrator import writer_agent_node
from services.llm_client import llm_client

_REFS = [
    {
        "title": "Attention is All You Need",
        "authors": ["Vaswani, A.", "Shazeer, N."],
        "abstract": "We propose the Transformer, a new simple network architecture.",
        "url": "https://arxiv.org/abs/1706.03762",
        "source": "NeurIPS",
        "published_date": "2017-06-12",
    },
    {
        "title": "BERT: Pre-training of Deep Bidirectional Transformers",
        "authors": ["Devlin, J."],
        "abstract": "We introduce BERT, a new language representation model.",
        "url": "https://arxiv.org/abs/1810.04805",
        "source": "NAACL",
        "published_date": "2018-10-11",
    },
]

_TOPIC = "Transformer注意力机制研究进展"


def _disable_llm(monkeypatch):
    """强制规则路径 (不触网): 清空 Key"""
    monkeypatch.setattr("services.llm_client.settings.LLM_API_KEY", "")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


# ---------------------------------------------------------------------------
# 输入契约 -> prompt 映射
# ---------------------------------------------------------------------------
def test_writer_messages_maps_structured_input():
    msgs = llm_client.writer_messages(_TOPIC, _REFS, "正文不少于400字")
    assert msgs[0]["role"] == "system"
    prompt = msgs[1]["content"]
    # user_topic / additional_requirements 原样进入 prompt
    assert _TOPIC in prompt
    assert "正文不少于400字" in prompt
    # confirmed_literature 逐条编号展开 (标题/作者/链接)
    assert "[1]" in prompt and "[2]" in prompt
    assert "Attention is All You Need" in prompt
    assert "Vaswani, A." in prompt
    assert "https://arxiv.org/abs/1706.03762" in prompt


def test_writer_messages_extra_optional():
    prompt = llm_client.writer_messages(_TOPIC, _REFS)[1]["content"]
    assert "附加要求" not in prompt


# ---------------------------------------------------------------------------
# 输出契约: 结构化 Markdown (规则降级路径)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_writer_node_structured_output_from_writer_input(monkeypatch):
    _disable_llm(monkeypatch)
    state = {
        "writing_task": "旧指令文本 (应被 user_topic 覆盖)",
        "writer_input": {
            "user_topic": _TOPIC,
            "confirmed_literature": _REFS,
            "additional_requirements": "正文不少于400字",
        },
        "messages": [],
        "metadata": {},
    }
    out = await writer_agent_node(state)
    draft = out["draft"]
    # 结构三段: 一级标题 / 参考文献 / 正文
    assert draft.startswith("# ")
    assert f"# 文献综述：{_TOPIC}" in draft
    assert "## 参考文献" in draft
    assert "## 正文" in draft
    # 参考文献按 [n] 逐条编号, 标题完整保留
    assert "[1]" in draft and "[2]" in draft
    assert "Attention is All You Need" in draft
    # 正文中存在内文引用标注
    body = draft.split("## 正文", 1)[1]
    assert "[1]" in body or "[2]" in body
    # 附加要求留痕
    assert "附加要求" in draft
    # 元数据: 规则引擎 + 未加水印
    assert out["metadata"]["writer_engine"] == "rule"
    assert out["messages"][-1]["watermarked"] is False


@pytest.mark.asyncio
async def test_writer_node_writer_input_overrides_legacy_fields(monkeypatch):
    """writer_input.confirmed_literature 优先于 literature_context"""
    _disable_llm(monkeypatch)
    state = {
        "writing_task": "旧主题",
        "literature_context": [{"title": "不应出现的旧文献", "authors": ["X"]}],
        "writer_input": {"user_topic": _TOPIC, "confirmed_literature": _REFS},
        "messages": [],
        "metadata": {},
    }
    out = await writer_agent_node(state)
    assert "不应出现的旧文献" not in out["draft"]
    assert "Attention is All You Need" in out["draft"]


@pytest.mark.asyncio
async def test_writer_node_legacy_channel_still_works(monkeypatch):
    """无 writer_input 时退回 literature_context (向后兼容)"""
    _disable_llm(monkeypatch)
    state = {
        "writing_task": "兼容主题",
        "literature_context": _REFS[:1],
        "messages": [],
        "metadata": {},
    }
    out = await writer_agent_node(state)
    draft = out["draft"]
    assert "## 参考文献" in draft
    assert "Attention is All You Need" in draft
    assert "兼容主题" in draft


@pytest.mark.asyncio
async def test_writer_node_no_refs_keeps_old_template(monkeypatch):
    """无任何文献时保持旧降级模板 (不强行套结构)"""
    _disable_llm(monkeypatch)
    state = {
        "writing_task": "撰写引言",
        "research_output": "检索结果摘要。",
        "messages": [],
        "metadata": {},
    }
    out = await writer_agent_node(state)
    assert "模拟写作草稿 · 规则模式" in out["draft"]


# ---------------------------------------------------------------------------
# 与审稿红牌规则自洽 (引用连续性 / 参考文献章节)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_writer_structured_output_passes_review_red_cards(monkeypatch):
    _disable_llm(monkeypatch)
    state = {
        "writer_input": {"user_topic": _TOPIC, "confirmed_literature": _REFS},
        "messages": [],
        "metadata": {},
    }
    out = await writer_agent_node(state)
    result = AcademicReviewEngine.review_document(out["draft"])
    assert result["red_cards"] == 0, result["issues"]
