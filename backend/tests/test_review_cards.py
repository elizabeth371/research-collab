"""
审稿人红牌/黄牌分级测试
========================
覆盖: 红牌 (空文档 / 引用编号不连续 / 缺参考文献), 黄牌 (断言无引用支撑 /
口语化密度 / 段落过长), para_index 段落定位, 以及 /api/agents/polish 与
/api/agents/review 端点。
"""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from main import app
from services.academic_review import AcademicReviewEngine


# ---------------------------------------------------------------------------
# 引擎: 红牌 (error)
# ---------------------------------------------------------------------------
def test_empty_doc_red_card():
    result = AcademicReviewEngine.review_document("")
    assert result["passed"] is False
    assert result["red_cards"] == 1
    assert "为空" in result["issues"][0]["message"]


def test_discontinuous_citation_red_card():
    text = (
        "水印方案由 Kirchenbauer 提出[1]。\n"
        "协同编辑依赖 CRDT 技术[3]。\n"
        "参考文献\n"
        "[1] Kirchenbauer J.A Watermark for Large Language Models[J].2023.\n"
        "[2] Jahns P.Yjs: Real-Time Collaboration[J].2021.\n"
        "[3] Wang L.Multi-Agent Systems: A Survey[J].2024.\n"
    )
    result = AcademicReviewEngine.review_document(text)
    assert result["passed"] is False
    assert result["red_cards"] >= 1
    assert any("不连续" in i["message"] for i in result["issues"] if i["level"] == "error")


def test_citation_without_ref_section_red_card():
    text = "本文研究 AI 生成内容的溯源方案[1]。\n通过水印技术可追溯生成来源[2]。\n"
    result = AcademicReviewEngine.review_document(text)
    assert result["passed"] is False
    assert any("参考文献" in i["message"] for i in result["issues"] if i["level"] == "error")


# ---------------------------------------------------------------------------
# 引擎: 黄牌 (warning) + 段落定位
# ---------------------------------------------------------------------------
def test_assertion_without_citation_yellow():
    text = (
        "第一段介绍了研究背景与相关工作。\n"
        "\n"
        "实验表明该方法在精度上具有明显优势。\n"
    )
    result = AcademicReviewEngine.review_document(text)
    yellow = [i for i in result["issues"] if i["level"] == "warning"]
    assertion = [i for i in yellow if "断言" in i["message"]]
    assert len(assertion) == 1
    assert assertion[0]["para_index"] == 2


def test_colloquial_density_yellow():
    text = "这个方法很多地方都挺好的，效果非常不错。\n"
    result = AcademicReviewEngine.review_document(text)
    yellow = [i for i in result["issues"] if i["level"] == "warning"]
    colloquial = [i for i in yellow if "口语化" in i["message"]]
    assert len(colloquial) == 1
    assert colloquial[0]["para_index"] == 1


def test_overlong_paragraph_yellow():
    text = "本段落用于验证过长规则。" + "内容。" * 200
    result = AcademicReviewEngine.review_document(text)
    yellow = [i for i in result["issues"] if i["level"] == "warning"]
    overlong = [i for i in yellow if "过长" in i["message"]]
    assert len(overlong) == 1
    assert overlong[0]["para_index"] == 1


def test_well_formed_document_passes():
    text = (
        "引言: AI 生成内容带来学术诚信风险[1], 水印技术提供可信溯源[2]。\n"
        "\n"
        "方法: 系统融合 CRDT 实时协同与绿名单水印方案[3]。\n"
        "\n"
        "结论: 实验验证了溯源链的防篡改能力[3]。\n"
        "\n"
        "参考文献\n"
        "[1] Liu X.On the Risks of LLM-Generated Content[J].2024.\n"
        "[2] Moreau L.Provenance for the Web[M].2013.\n"
        "[3] Kirchenbauer J.A Watermark for Large Language Models[J].2023.\n"
    )
    result = AcademicReviewEngine.review_document(text)
    assert result["passed"] is True
    assert result["red_cards"] == 0


def test_assertion_with_citation_not_flagged():
    """断言所在段有引用支撑 -> 不触发黄牌"""
    text = "实验表明该方法有效[1]。\n\n参考文献\n[1] Kirchenbauer J[J].2023.\n"
    result = AcademicReviewEngine.review_document(text)
    assert not any("断言" in i["message"] for i in result["issues"])


# ---------------------------------------------------------------------------
# API 端点
# ---------------------------------------------------------------------------
@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def _create_doc(client: AsyncClient, content: str = "") -> str:
    resp = await client.post(
        "/api/documents",
        json={
            "title": f"测试文档-{uuid.uuid4().hex[:8]}",
            "owner_id": "00000000-0000-4000-8000-000000000001",
            "content": content,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_api_polish(client, monkeypatch):
    # 清空 API Key: 本测试断言规则引擎的确定性输出,
    # 避免真实 LLM 已配置时走网络 (结果不确定且产生调用费用)
    monkeypatch.setattr("services.llm_client.settings.LLM_API_KEY", "")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    doc_id = await _create_doc(client)
    resp = await client.post(
        "/api/agents/polish", json={"doc_id": doc_id, "text": "我们做了实验。"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "本研究开展了实验" in body["polished"]
    assert isinstance(body["changes"], list)
    assert body["stats"]["change_count"] == len(body["changes"])


@pytest.mark.asyncio
async def test_api_review(client):
    doc_id = await _create_doc(client, content="太短了。")
    resp = await client.post("/api/agents/review", json={"doc_id": doc_id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["doc_id"] == doc_id
    assert body["passed"] is False
    assert body["red_cards"] >= 1
    assert isinstance(body["issues"], list)


@pytest.mark.asyncio
async def test_api_review_missing_doc(client):
    resp = await client.post(
        "/api/agents/review", json={"doc_id": str(uuid.uuid4())}
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_api_polish_missing_doc(client):
    resp = await client.post(
        "/api/agents/polish",
        json={"doc_id": str(uuid.uuid4()), "text": "我们做了实验。"},
    )
    assert resp.status_code == 404
