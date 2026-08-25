"""
审稿红牌 -> 自动重写闭环测试
=============================
覆盖:
  - RewriteEngine 规则重写: 引用编号重排 / 补齐参考文献 / 篇幅扩充 / 无红牌不改动
  - /api/agents/rewrite 端点 (含 404)
  - 编排器红牌循环: supervisor -> writer(修订) -> supervisor, 修订轮数上限
"""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from main import app
from services.academic_review import AcademicReviewEngine
from services.agent_orchestrator import (
    _MAX_REWRITE_ROUNDS,
    should_retry,
    supervisor_agent_node,
    writer_agent_node,
)
from services.rewrite_engine import RewriteEngine


# ---------------------------------------------------------------------------
# 引擎: 引用编号重排
# ---------------------------------------------------------------------------
def test_citation_gap_renumbered():
    text = "方案见文献[3]实现，具体细节详见[2]所述。"
    review = AcademicReviewEngine.review_document(text)
    assert review["red_cards"] >= 1  # 缺 [1] -> 红牌

    result = RewriteEngine.rewrite_document(text, review)
    body = result["text"].split("## 参考文献", 1)[0]
    nums = [int(m) for m in RewriteEngine.CITATION_RE.findall(body)]
    assert nums == sorted(nums) == [1, 2]  # 按出现顺序重排为连续编号
    assert any(c["type"] == "citation" for c in result["changes"])
    assert result["red_cards_after"] == 0  # 复检红牌清零


# ---------------------------------------------------------------------------
# 引擎: 补齐参考文献章节
# ---------------------------------------------------------------------------
def test_missing_ref_section_appended():
    text = (
        "本系统采用文献[1]提出的水印方案进行 AI 内容溯源，"
        "结合 Yjs 协同编辑与多 Agent 编排，在真实协作场景中应用广泛，"
        "能够有效标识生成内容并保障科研诚信，后续将开展大规模验证。"
    )
    result = RewriteEngine.rewrite_document(text)
    assert "## 参考文献" in result["text"]
    assert any(c["type"] == "references" for c in result["changes"])
    # 参考文献条目数 >= 最大引用编号, 复检通过
    assert result["red_cards_after"] == 0
    assert result["passed_after"] is True


# ---------------------------------------------------------------------------
# 引擎: 篇幅扩充
# ---------------------------------------------------------------------------
def test_short_text_expanded():
    text = "本文研究水印与溯源技术。"
    result = RewriteEngine.rewrite_document(text)
    stats = AcademicReviewEngine._collect_stats(result["text"])
    assert stats["chars"] >= 100
    assert stats["paragraphs"] >= 3  # 引言/方法/结论
    assert any(c["type"] == "length" for c in result["changes"])
    assert result["red_cards_after"] == 0


# ---------------------------------------------------------------------------
# 引擎: 无红牌 / 空文档 不改动
# ---------------------------------------------------------------------------
def test_clean_text_noop():
    text = (
        "本文提出一种用于科研诚信的 AI 内容溯源方案[1]，"
        "结合水印与协同编辑技术，在真实协作场景中表现良好，"
        "已适配主流协同系统，具备较强的工程可用性，"
        "后续将进一步开展大规模实验验证其有效性。\n\n"
        "## 参考文献\n"
        "[1] Kirchenbauer J. A Watermark for Large Language Models[J]. 2023."
    )
    review = AcademicReviewEngine.review_document(text)
    assert review["red_cards"] == 0

    result = RewriteEngine.rewrite_document(text, review)
    assert result["text"] == text
    assert result["changes"] == []
    assert result["red_cards_after"] == 0


def test_escaped_brackets_normalized():
    """
    编辑器 markdown 持久化会把 [n] 转义为 \\[n\\] (prosemirror-markdown),
    审查/重写前必须归一化, 否则引用编号/缺参考文献红牌被漏检。
    """
    text = "方案见文献\\[3\\]实现，具体细节详见\\[2\\]所述。"  # 即字面 \[3\] \[2\]
    review = AcademicReviewEngine.review_document(text)
    assert review["red_cards"] >= 2  # 跳号 + 缺参考文献均被识别

    result = RewriteEngine.rewrite_document(text, review)
    body = result["text"].split("## 参考文献", 1)[0]
    nums = [int(m) for m in RewriteEngine.CITATION_RE.findall(body)]
    assert nums == sorted(nums) == [1, 2]  # 归一化后按出现顺序重排
    assert result["red_cards_after"] == 0


def test_empty_text_noop():
    result = RewriteEngine.rewrite_document("")
    assert result["text"] == ""
    assert result["changes"] == []


# ---------------------------------------------------------------------------
# 编排器: 红牌 -> 重写循环
# ---------------------------------------------------------------------------
async def _review_rewrite_review():
    """模拟一轮 supervisor -> writer(修订) -> supervisor, 返回最终 state"""
    state = {
        "messages": [],
        "draft": "方案见文献[3]实现，具体细节详见[2]所述。",
        "review_rounds": 0,
        "rewrite_log": [],
    }
    state.update(await supervisor_agent_node(state))
    return state


@pytest.mark.asyncio
async def test_rewrite_loop_clears_red_cards():
    state = await _review_rewrite_review()
    # 首轮审查发现红牌 -> 应路由回 writer 修订
    assert should_retry(state) == "writer"

    state.update(await writer_agent_node(state))   # 修订
    assert state["review_rounds"] == 1
    assert any("审稿修订" in m["content"] for m in state["messages"])
    assert any("重排" in m["content"] for m in state["messages"])

    state.update(await supervisor_agent_node(state))  # 复检
    # 红牌清零 -> 结束
    assert should_retry(state) == "supervisor"
    assert state["review_result"]["red_cards"] == 0


@pytest.mark.asyncio
async def test_rewrite_rounds_capped():
    # 达到轮数上限时即使仍有红牌也停止重写 (防死循环)
    state = {
        "messages": [],
        "draft": "只有一句话。",
        "review_rounds": _MAX_REWRITE_ROUNDS,
        "review_result": {"red_cards": 1},
        "rewrite_log": [],
    }
    assert should_retry(state) == "supervisor"


@pytest.mark.asyncio
async def test_empty_draft_no_rewrite_loop():
    # 空文档无法重写 -> 不进入循环
    state = {
        "messages": [],
        "draft": "",
        "review_rounds": 0,
        "review_result": {"red_cards": 1},
        "rewrite_log": [],
    }
    assert should_retry(state) == "supervisor"


# ---------------------------------------------------------------------------
# API: /api/agents/rewrite
# ---------------------------------------------------------------------------
@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def _create_doc(client: AsyncClient) -> str:
    resp = await client.post(
        "/api/documents",
        json={
            "title": f"重写测试-{uuid.uuid4().hex[:8]}",
            "owner_id": "00000000-0000-4000-8000-000000000001",
            "content": "",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_api_rewrite_red_card_doc(client):
    doc_id = await _create_doc(client)
    # 写入含红牌 (缺 [1]) 的内容
    bad = "方案见文献[3]实现，具体细节详见[2]所述。"
    resp = await client.patch(
        f"/api/documents/{doc_id}",
        json={"content": bad, "operator_id": "00000000-0000-4000-8000-000000000001"},
    )
    assert resp.status_code == 200, resp.text

    resp = await client.post("/api/agents/rewrite", json={"doc_id": doc_id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rewritten"] != bad
    assert body["red_cards_before"] >= 1
    assert body["red_cards_after"] == 0
    assert body["passed_after"] is True
    assert body["engine"] == "rule"
    assert len(body["changes"]) >= 1

    # 清理测试文档
    resp = await client.delete(f"/api/documents/{doc_id}")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_api_rewrite_no_red_cards_noop(client):
    doc_id = await _create_doc(client)
    good = (
        "本文提出一种用于科研诚信的 AI 内容溯源方案[1]，"
        "结合水印与协同编辑技术，在真实协作场景中表现良好，"
        "已适配主流协同系统，具备较强的工程可用性，"
        "后续将进一步开展大规模实验验证其有效性。\n\n"
        "## 参考文献\n"
        "[1] Kirchenbauer J. A Watermark for Large Language Models[J]. 2023."
    )
    resp = await client.patch(
        f"/api/documents/{doc_id}",
        json={"content": good, "operator_id": "00000000-0000-4000-8000-000000000001"},
    )
    assert resp.status_code == 200

    resp = await client.post("/api/agents/rewrite", json={"doc_id": doc_id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rewritten"] == good
    assert body["engine"] == "noop"
    assert body["red_cards_before"] == 0

    resp = await client.delete(f"/api/documents/{doc_id}")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_api_rewrite_doc_not_found(client):
    resp = await client.post(
        "/api/agents/rewrite",
        json={"doc_id": str(uuid.uuid4())},
    )
    assert resp.status_code == 404
