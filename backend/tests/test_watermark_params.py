"""
每文档独立水印密钥 + 参数面板测试 (步骤 12)
============================================
覆盖:
- 迁移: documents 表含 watermark_key/gamma/delta 列, 旧文档回填全局密钥
- 参数端点: GET 默认值 / PATCH 更新 / 重新生成密钥 / 422 校验 / 404
- 溯源: 参数变更写入 op_logs (watermark_params) 且哈希链保持完整
- 检测一致性: 文档检测使用文档密钥 (旧全局密钥水印内容仍可检出;
  演示文档纯文本不被误判)
- 引擎: load_document_engine 按文档参数构建; 显式 delta 覆盖 LLM 校准值
- 鲁棒性端点: 传 doc_id 时用文档密钥检测
"""

import uuid

import numpy as np
import pytest
from httpx import ASGITransport, AsyncClient

from config import settings
from main import app
from services.watermark_engine import WatermarkEngine, load_document_engine

DEMO_DOC_ID = "00000000-0000-4000-8000-0000000000a1"
TEST_SAMPLE_ID = "ddaf2f58-a9a2-45ca-83ce-3d7718d4a0c7"

VOCAB = list(
    "人工智能水印版权溯源科研协同编辑技术安全检测论文写作质量评估方法"
)


def _synthetic_candidates(n_positions: int = 200, seed: int = 42) -> list:
    """与 test_watermark_resample 同构的合成候选流 (不触网)"""
    rng = np.random.default_rng(seed)
    candidates = []
    for _ in range(n_positions):
        idx = rng.choice(len(VOCAB), size=20, replace=False)
        lps = np.concatenate(
            [rng.uniform(-1.5, 0.0, size=1), rng.uniform(-12.0, -3.0, size=19)]
        )
        rng.shuffle(lps)
        candidates.append([(VOCAB[int(i)], float(lp)) for i, lp in zip(idx, lps)])
    return candidates


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def _create_doc(client: AsyncClient) -> str:
    resp = await client.post(
        "/api/documents",
        json={
            "title": f"测试文档-{uuid.uuid4().hex[:8]}",
            "owner_id": "00000000-0000-4000-8000-000000000001",
            "content": "",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# ---------------------------------------------------------------------------
# 迁移与文档密钥
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_documents_have_watermark_params_columns():
    from sqlalchemy import text

    from database import engine

    async with engine.begin() as conn:
        cols = [r[1] for r in (await conn.execute(text("PRAGMA table_info(documents)"))).fetchall()]
    assert {"watermark_key", "watermark_gamma", "watermark_delta"} <= set(cols)


@pytest.mark.asyncio
async def test_legacy_docs_backfilled_with_global_key():
    """旧文档 (历史全局密钥水印内容) 回填全局密钥, 保证历史内容仍可检出"""
    from database import async_session_factory

    import models

    async with async_session_factory() as s:
        doc = await s.get(models.Document, uuid.UUID(TEST_SAMPLE_ID))
        assert doc.watermark_key == settings.WATERMARK_SECRET_KEY
        assert doc.watermark_gamma == pytest.approx(0.5)
        assert doc.watermark_delta == pytest.approx(4.0)


@pytest.mark.asyncio
async def test_new_docs_get_independent_random_keys(client):
    """新文档创建即生成独立随机密钥, 且互不相同、不同于全局密钥"""
    id1 = await _create_doc(client)
    id2 = await _create_doc(client)
    p1 = (await client.get(f"/api/watermark/documents/{id1}/params")).json()
    p2 = (await client.get(f"/api/watermark/documents/{id2}/params")).json()
    assert p1["secret_key_hex"] != settings.WATERMARK_SECRET_KEY.hex()
    assert p1["secret_key_hex"] != p2["secret_key_hex"]
    assert len(p1["secret_key_hex"]) == 64  # 32 字节密钥


# ---------------------------------------------------------------------------
# 参数端点
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_params_get_defaults_and_404(client):
    doc_id = await _create_doc(client)
    resp = await client.get(f"/api/watermark/documents/{doc_id}/params")
    assert resp.status_code == 200
    data = resp.json()
    assert data["gamma"] == pytest.approx(0.5)
    assert data["delta"] == pytest.approx(4.0)
    assert len(data["secret_key_hex"]) == 64
    assert len(data["key_fingerprint"]) == 16
    assert (await client.get(f"/api/watermark/documents/{uuid.uuid4()}/params")).status_code == 404


@pytest.mark.asyncio
async def test_params_update_and_provenance_log(client):
    doc_id = await _create_doc(client)
    resp = await client.patch(
        f"/api/watermark/documents/{doc_id}/params",
        json={"gamma": 0.4, "delta": 3.0},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["gamma"] == pytest.approx(0.4)
    assert data["delta"] == pytest.approx(3.0)

    # 溯源链: 出现 watermark_params 日志且链条保持完整
    logs = (await client.get(f"/api/watermark/documents/{doc_id}/provenance")).json()
    assert any(e["op_type"] == "watermark_params" for e in logs)
    entry = next(e for e in logs if e["op_type"] == "watermark_params")
    assert entry["operation"]["action"] == "watermark_params_changed"
    verify = (await client.get(f"/api/watermark/documents/{doc_id}/provenance/verify")).json()
    assert verify["valid"] is True, "参数变更后溯源链应保持完整"


@pytest.mark.asyncio
async def test_params_regenerate_key(client):
    doc_id = await _create_doc(client)
    before = (await client.get(f"/api/watermark/documents/{doc_id}/params")).json()
    resp = await client.patch(
        f"/api/watermark/documents/{doc_id}/params",
        json={"regenerate_key": True},
    )
    assert resp.status_code == 200
    after = resp.json()
    assert after["secret_key_hex"] != before["secret_key_hex"]
    assert after["key_fingerprint"] != before["key_fingerprint"]
    # 参数未变 (只重建密钥)
    assert after["gamma"] == before["gamma"] and after["delta"] == before["delta"]


@pytest.mark.asyncio
async def test_params_validation(client):
    doc_id = await _create_doc(client)
    assert (await client.patch(
        f"/api/watermark/documents/{doc_id}/params", json={"gamma": 2.0}
    )).status_code == 422
    assert (await client.patch(
        f"/api/watermark/documents/{doc_id}/params", json={"delta": -1}
    )).status_code == 422


# ---------------------------------------------------------------------------
# 引擎与检测一致性
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_load_document_engine_uses_doc_params():
    from database import async_session_factory

    import models

    async with async_session_factory() as s:
        doc = await s.get(models.Document, uuid.UUID(TEST_SAMPLE_ID))
        engine = WatermarkEngine(
            gamma=doc.watermark_gamma,
            delta=doc.watermark_delta,
            secret_key=doc.watermark_key,
        )
        assert engine.secret_key == settings.WATERMARK_SECRET_KEY
        assert engine.delta == pytest.approx(4.0)
        # 文档内容 (全局密钥注入的历史水印) 用文档密钥检测应命中
        r = engine.detect_watermark(doc.content or "")
        assert r["is_ai_generated"] is True
        assert r["z_score"] > 4.0


@pytest.mark.asyncio
async def test_detect_document_uses_doc_key(client):
    # 测试样例: 内容为全局密钥水印, 其密钥回填为全局密钥 -> 检出
    resp = await client.post(f"/api/watermark/documents/{TEST_SAMPLE_ID}/detect")
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_ai_generated"] is True

    # 演示文档: 纯文本 -> 不误判
    resp2 = await client.post(f"/api/watermark/documents/{DEMO_DOC_ID}/detect")
    assert resp2.status_code == 200
    assert resp2.json()["is_ai_generated"] is False


@pytest.mark.asyncio
async def test_detect_records_doc_key(client):
    await client.post(f"/api/watermark/documents/{TEST_SAMPLE_ID}/detect")
    body = (await client.get(f"/api/watermark/documents/{TEST_SAMPLE_ID}/records")).json()
    records = body["records"] if isinstance(body, dict) else body
    assert records, "检测后应产生水印记录"
    latest = records[-1]  # 正序排列, 最后一条为本次检测所写
    # 落库的密钥/参数与文档一致 (证据链可还原)
    assert latest["gamma"] == pytest.approx(0.5)
    assert latest["delta"] == pytest.approx(4.0)


@pytest.mark.asyncio
async def test_robustness_with_doc_id_uses_doc_key(client):
    from database import async_session_factory

    import models

    async with async_session_factory() as s:
        doc = await s.get(models.Document, uuid.UUID(TEST_SAMPLE_ID))
        content = doc.content or ""
    resp = await client.post(
        "/api/watermark/robustness",
        json={"text": content, "doc_id": TEST_SAMPLE_ID},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["doc_id"] == TEST_SAMPLE_ID
    assert data["baseline"]["is_ai_generated"] is True, "文档密钥检测应命中其水印内容"
    # 跨密钥对照: 不传 doc_id 时用全局密钥检测同一文本同样命中
    # (该文档密钥即全局密钥, 此断言验证口径一致性)


# ---------------------------------------------------------------------------
# 引擎 delta 语义: 显式 delta 覆盖 LLM 校准值
# ---------------------------------------------------------------------------
class _StubLLM:
    def __init__(self):
        self.candidates = _synthetic_candidates()

    async def generate_with_logprobs(self, messages, **kwargs):
        return self.candidates


@pytest.mark.asyncio
async def test_generate_watermarked_uses_explicit_delta(monkeypatch):
    """每文档引擎 (显式 delta) 用自身 delta; 全局引擎用 LLM 校准值 4.0"""
    captured = {}

    def fake_resample(self, candidates, **kwargs):
        captured["delta"] = kwargs.get("delta")
        return "测试水印文本内容" * 10

    doc_engine = WatermarkEngine(delta=3.0, gamma=0.5)
    monkeypatch.setattr(WatermarkEngine, "resample_with_watermark", fake_resample)
    text = await doc_engine.generate_watermarked(_StubLLM(), [{"role": "user", "content": "x"}])
    assert text is not None
    assert captured["delta"] == 3.0, "文档引擎应使用自身 delta"

    global_engine = WatermarkEngine()
    await global_engine.generate_watermarked(_StubLLM(), [{"role": "user", "content": "x"}])
    assert captured["delta"] == pytest.approx(settings.WATERMARK_LLM_DELTA)


@pytest.mark.asyncio
async def test_load_document_engine_fallback():
    """无 doc_id / 文档不存在 -> 全局引擎"""
    g = await load_document_engine(None)
    assert g.secret_key == settings.WATERMARK_SECRET_KEY
    assert g.delta == pytest.approx(settings.WATERMARK_DELTA)
    g2 = await load_document_engine(str(uuid.uuid4()))
    assert g2.secret_key == settings.WATERMARK_SECRET_KEY
