"""
水印对抗鲁棒性实验测试 (步骤 11)
==================================
覆盖:
- 攻击算子正确性: 删除比例 / 截断 / 同义替换生效 / 噪声数量 / 乱序保序
- 攻击确定性: 同 seed 结果可复现 (论文实验可审计)
- 完整攻击矩阵: 基线 z>4 检出, 各攻击后统计量衰减但结构完整
- 汇总结构: 检出率 / 平均 z / 最小 z
- API 端点: POST /api/watermark/robustness 200 + 结构 + 422 校验
- 机器翻译回译 (stub, 不触网) 与真实 DeepSeek (有 key 时)
"""

import numpy as np
import pytest
from httpx import ASGITransport, AsyncClient

from main import app
from services.llm_client import llm_client
from services.watermark_attack import SYNONYM_MAP, WatermarkAttackSuite
from services.watermark_engine import WatermarkEngine


# ---------------------------------------------------------------------------
# 合成水印文本: 与 test_watermark_resample 同一套合成候选流, 保证 z 足够高
# ---------------------------------------------------------------------------
VOCAB = list(
    "人工智能水印版权溯源科研协同编辑技术安全检测论文写作质量评估方法"
)


def _watermarked_text(seed: int = 42, n_positions: int = 300) -> str:
    """构造一段可稳定检出 (z>4) 的合成水印文本, 长度 ~300 字"""
    rng = np.random.default_rng(seed)
    candidates = []
    for _ in range(n_positions):
        idx = rng.choice(len(VOCAB), size=20, replace=False)
        lps = np.concatenate(
            [rng.uniform(-1.5, 0.0, size=1), rng.uniform(-12.0, -3.0, size=19)]
        )
        rng.shuffle(lps)
        candidates.append([(VOCAB[int(i)], float(lp)) for i, lp in zip(idx, lps)])
    wm = WatermarkEngine(delta=2.0)
    return wm.resample_with_watermark(candidates, rng=np.random.default_rng(7))


# ---------------------------------------------------------------------------
# 攻击算子正确性
# ---------------------------------------------------------------------------
def test_delete_random_removes_approx_ratio():
    text = "水印技术可以用于科研内容的版权保护溯源。" * 20
    deleted = WatermarkAttackSuite.delete_random(text, 0.30, seed=2)
    kept = "".join(c for c in deleted if not c.isspace())
    total = "".join(c for c in text if not c.isspace())
    assert 0.66 < len(kept) / len(total) < 0.74, "删除比例应约为 30%"


def test_attacks_deterministic_with_seed():
    text = "水印技术可以用于科研内容的版权保护溯源。" * 20
    a = WatermarkAttackSuite.delete_random(text, 0.10, seed=1)
    b = WatermarkAttackSuite.delete_random(text, 0.10, seed=1)
    assert a == b
    assert WatermarkAttackSuite.reorder_local(text) == WatermarkAttackSuite.reorder_local(text)
    assert WatermarkAttackSuite.insert_noise(text) == WatermarkAttackSuite.insert_noise(text)


def test_truncate_tail_keeps_prefix():
    text = "水印技术可以用于科研内容的版权保护溯源。" * 20
    out = WatermarkAttackSuite.truncate_tail(text, 0.20)
    assert len(out) == max(1, int(len(text) * 0.80))
    assert out == text[: len(out)]  # 保留的是原文开头


def test_synonym_replace_actually_replaces():
    text = "水印技术可以用于内容溯源, 研究系统与数据检测。"
    out = WatermarkAttackSuite.synonym_replace(text)
    assert out != text
    assert "水印" not in out and "数字标记" in out
    # 双向检查: 词表里的词被替换为近义表达
    for src, dst in SYNONYM_MAP[:3]:
        assert src in text
        assert src not in out and dst in out


def test_insert_noise_adds_expected_count():
    text = "水印技术可以用于科研内容的版权保护溯源。" * 20  # 340 字符
    out = WatermarkAttackSuite.insert_noise(text, per_100=2)
    expected = max(1, len(text) * 2 // 100)
    assert len(out) == len(text) + expected


def test_reorder_local_preserves_character_multiset():
    """局部乱序不增删字符, 仅改变顺序 (模拟语序扰动)"""
    text = "水印技术可以用于科研内容的版权保护溯源。" * 20
    out = WatermarkAttackSuite.reorder_local(text)
    assert sorted(out) == sorted(text)
    assert out != text  # 确实发生了乱序


# ---------------------------------------------------------------------------
# 攻击矩阵检测衰减 (合成水印文本)
# ---------------------------------------------------------------------------
def test_suite_baseline_detected_and_attacks_decay():
    text = _watermarked_text()
    suite = WatermarkAttackSuite()
    result = suite.run(text)

    baseline = result["baseline"]
    assert baseline["is_ai_generated"] is True
    assert baseline["z_score"] > 4.0

    attacks = {a["name"]: a for a in result["attacks"]}
    assert set(attacks) == {
        "no_attack", "delete_10", "delete_30", "truncate_20",
        "synonym_replace", "noise_insert", "reorder_local",
    }

    # 每个攻击行携带完整统计量
    for name, row in attacks.items():
        for field in ("z_score", "green_fraction", "is_ai_generated",
                      "num_tokens_scored", "chars_after", "chars_retained"):
            assert field in row, f"{name} 缺少字段 {field}"

    # 保留率与攻击强度一致
    assert 0.85 < attacks["delete_10"]["chars_retained"] < 0.95
    assert 0.65 < attacks["delete_30"]["chars_retained"] < 0.75
    assert 0.75 < attacks["truncate_20"]["chars_retained"] < 0.85
    assert attacks["noise_insert"]["chars_retained"] > 1.0

    # 检测衰减: 强攻击 (局部乱序破坏相邻字符绿名单) 后 z 显著低于基线
    assert attacks["reorder_local"]["z_score"] < baseline["z_score"] * 0.8

    # 汇总结构
    summary = result["summary"]
    assert summary["attacked"] == 6
    assert 0 <= summary["detected"] <= summary["attacked"]
    assert 0.0 <= summary["detected_ratio"] <= 1.0
    assert summary["avg_z"] > 0
    assert summary["min_z"] == min(a["z_score"] for a in attacks.values() if a["name"] != "no_attack")


def test_suite_summary_empty_attacks():
    """无攻击行时汇总兜底, 不除零"""
    summary = WatermarkAttackSuite._summarize([])
    assert summary["attacked"] == 0 and summary["detected_ratio"] == 0.0


# ---------------------------------------------------------------------------
# API 端点
# ---------------------------------------------------------------------------
@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_robustness_endpoint_structure(client):
    text = _watermarked_text()
    resp = await client.post("/api/watermark/robustness", json={"text": text})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["engine"] == "kirchenbauer-v1"
    assert data["text_len"] == len(text)
    assert data["baseline"]["is_ai_generated"] is True
    assert len(data["attacks"]) == 7  # 含基线行
    assert data["summary"]["attacked"] == 6
    assert data["translation_failed"] is False


@pytest.mark.asyncio
async def test_robustness_endpoint_validation(client):
    resp = await client.post("/api/watermark/robustness", json={"text": ""})
    assert resp.status_code == 422  # min_length=1 校验


# ---------------------------------------------------------------------------
# 机器翻译回译 (stub 不触网; 真实 DeepSeek 有 key 时)
# ---------------------------------------------------------------------------
class _StubTranslateLLM:
    """chat() 返回固定英文/中文, 模拟翻译 LLM"""

    def __init__(self) -> None:
        self.calls = 0

    def is_available(self) -> bool:
        return True

    async def chat(self, messages, **kwargs):
        self.calls += 1
        if self.calls == 1:
            return "Watermark technology can protect copyright of research content."
        return "水印技术可以保护科研内容的版权。"


@pytest.mark.asyncio
async def test_translate_roundtrip_with_stub():
    suite = WatermarkAttackSuite()
    stub = _StubTranslateLLM()
    out = await suite.translate_roundtrip(stub, "水印技术可以保护科研内容的版权。")
    assert out == "水印技术可以保护科研内容的版权。"
    assert stub.calls == 2  # zh->en, en->zh 各一次


@pytest.mark.asyncio
async def test_run_async_appends_translation_row():
    suite = WatermarkAttackSuite()
    stub = _StubTranslateLLM()
    result = await suite.run_async(
        _watermarked_text(), include_translation=True, llm_client=stub
    )
    names = [a["name"] for a in result["attacks"]]
    assert "translate_roundtrip" in names
    assert result["summary"]["attacked"] == 7
    assert result["translation_failed"] is False


@pytest.mark.asyncio
async def test_run_async_translation_failed_marked():
    """翻译失败 (返回 None) 时 attacks 不含该行, 并标记 failed"""
    class _BrokenLLM:
        def is_available(self) -> bool:
            return True

        async def chat(self, messages, **kwargs):
            return None

    suite = WatermarkAttackSuite()
    result = await suite.run_async(
        _watermarked_text(), include_translation=True, llm_client=_BrokenLLM()
    )
    names = [a["name"] for a in result["attacks"]]
    assert "translate_roundtrip" not in names
    assert result["summary"]["attacked"] == 6
    assert result["translation_failed"] is True


@pytest.mark.asyncio
@pytest.mark.skipif(
    not llm_client.is_available(),
    reason="未配置 LLM_API_KEY, 跳过真实翻译回译测试",
)
async def test_real_deepseek_translate_roundtrip():
    """
    真实链路: DeepSeek 中文->英文->中文回译。
    校验: 回译成功且输出为中文 (CJK 占比 > 50%), 不短于原文一半;
    完整攻击矩阵含该行且统计量非 NaN。
    """
    suite = WatermarkAttackSuite()
    zh = await suite.translate_roundtrip(
        llm_client, "水印技术可以保护科研内容的版权。该技术通过绿名单重采样实现。"
    )
    assert zh, "真实回译失败, 请检查 LLM_API_KEY"
    cjk = sum(1 for c in zh if "\u4e00" <= c <= "\u9fff")
    assert cjk / max(1, len(zh)) > 0.5, f"回译结果不是中文: {zh[:60]}"
    assert len(zh) > 10

    result = await suite.run_async(
        _watermarked_text(), include_translation=True, llm_client=llm_client
    )
    row = next(
        (a for a in result["attacks"] if a["name"] == "translate_roundtrip"), None
    )
    assert row is not None, "攻击矩阵未包含回译行"
    assert row["num_tokens_scored"] > 0
    assert row["z_score"] == row["z_score"]  # 非 NaN
