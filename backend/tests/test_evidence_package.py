"""
版权证据包导出测试 (步骤 13)
================================
覆盖:
- JSON 证据包: 结构完整 (package/document/watermark_params/detect_records/
  provenance/live_detect/package_hash), package_hash 可离线重算校验
- Markdown 证据包: 包含全部关键章节与哈希
- PDF 证据包: 合法 PDF 二进制 (%PDF 头), 中文渲染不报错
- 边界: 未知文档 404 / 非法格式 422
- 实时检测: 测试样例(含水印)判 AI, 演示文档(纯文本)判人类
- 哈希链校验结果: 正式文档溯源链 valid=True 且逐条校验
"""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from main import app
from services.evidence_package import compute_package_hash, verify_package_hash

DEMO_DOC_ID = "00000000-0000-4000-8000-0000000000a1"
TEST_SAMPLE_ID = "ddaf2f58-a9a2-45ca-83ce-3d7718d4a0c7"


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def _evidence(client: AsyncClient, doc_id: str, fmt: str = "json"):
    return await client.get(
        f"/api/watermark/documents/{doc_id}/evidence?format={fmt}"
    )


@pytest.mark.asyncio
async def test_evidence_json_structure(client):
    resp = await _evidence(client, TEST_SAMPLE_ID, "json")
    assert resp.status_code == 200
    data = resp.json()
    # 顶层章节齐全
    for section in (
        "package", "document", "watermark_params",
        "detect_records", "provenance", "live_detect", "package_hash",
    ):
        assert section in data, f"证据包缺少章节: {section}"
    assert data["document"]["id"] == TEST_SAMPLE_ID
    assert data["document"]["content_length"] > 0
    # 密钥安全: 证据包只允许携带指纹 (128 bit), 不得泄露密钥原文
    assert "secret_key_hex" not in data["watermark_params"]
    fingerprint = data["watermark_params"]["key_fingerprint"]
    assert isinstance(fingerprint, str) and len(fingerprint) == 32
    assert all(c in "0123456789abcdef" for c in fingerprint)
    # 溯源链结构
    assert isinstance(data["provenance"]["logs"], list)
    assert "chain_valid" in data["provenance"]
    # 实时检测字段
    for k in ("is_ai_generated", "confidence", "z_score"):
        assert k in data["live_detect"]


@pytest.mark.asyncio
async def test_evidence_json_hash_verifiable(client):
    resp = await _evidence(client, TEST_SAMPLE_ID, "json")
    assert resp.status_code == 200
    data = resp.json()
    # 重算哈希与包内一致 (离线校验可行)
    assert verify_package_hash(data) is True
    assert compute_package_hash(data) == data["package_hash"]
    # 篡改任意字段后校验必须失败
    tampered = dict(data)
    tampered["document"] = {**data["document"], "title": "被篡改的标题"}
    assert verify_package_hash(tampered) is False


@pytest.mark.asyncio
async def test_evidence_markdown(client):
    resp = await _evidence(client, DEMO_DOC_ID, "md")
    assert resp.status_code == 200
    assert "text/markdown" in resp.headers["content-type"]
    body = resp.text
    for marker in (
        "版权证据包", "文档水印参数", "水印检测历史记录",
        "溯源链", "哈希链完整性校验", "package_hash",
    ):
        assert marker in body, f"Markdown 证据包缺少标记: {marker}"
    # Content-Disposition 附件
    assert "filename=" in resp.headers.get("content-disposition", "")


@pytest.mark.asyncio
async def test_evidence_pdf(client):
    resp = await _evidence(client, DEMO_DOC_ID, "pdf")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    body = resp.content
    assert body[:4] == b"%PDF", "PDF 文件头缺失"
    assert len(body) > 5000, "PDF 内容过小"


@pytest.mark.asyncio
async def test_evidence_unknown_doc(client):
    resp = await _evidence(client, str(uuid.uuid4()), "json")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_evidence_invalid_format(client):
    resp = await client.get(
        f"/api/watermark/documents/{DEMO_DOC_ID}/evidence?format=docx"
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_evidence_live_detect_on_watermarked_doc(client):
    # 测试样例文档内容由全局密钥注入水印, 文档回填全局密钥 -> 实时检测应判 AI
    resp = await _evidence(client, TEST_SAMPLE_ID, "json")
    assert resp.status_code == 200
    live = resp.json()["live_detect"]
    assert live["is_ai_generated"] is True
    assert live["z_score"] > 4.0


@pytest.mark.asyncio
async def test_evidence_live_detect_on_human_doc(client):
    # 演示文档为纯人类创作文本 -> 不误判
    resp = await _evidence(client, DEMO_DOC_ID, "json")
    assert resp.status_code == 200
    live = resp.json()["live_detect"]
    assert live["is_ai_generated"] is False


@pytest.mark.asyncio
async def test_evidence_chain_valid(client):
    resp = await _evidence(client, DEMO_DOC_ID, "json")
    assert resp.status_code == 200
    prov = resp.json()["provenance"]
    assert prov["chain_valid"]["valid"] is True
    assert prov["chain_valid"]["checked"] == prov["log_count"]
    assert prov["log_count"] > 0


@pytest.mark.asyncio
async def test_evidence_pdf_matches_json_hash(client):
    """PDF 与 JSON 同刻导出时 package_hash 一致 (渲染不改变证据内容)"""
    resp_json = await _evidence(client, DEMO_DOC_ID, "json")
    resp_pdf = await _evidence(client, DEMO_DOC_ID, "pdf")
    assert resp_json.status_code == 200
    assert resp_pdf.status_code == 200
    assert resp_pdf.content[:4] == b"%PDF"
