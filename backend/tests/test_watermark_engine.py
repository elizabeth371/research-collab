"""
水印引擎单元测试 (论文级实现)
=============================
覆盖: 短文本不可检测、人工文本判定为人类创作、
带水印嵌入的文本可被检出、论文式种子可复现绿名单、
z-score / p-value 统计量正确性。
"""

import math

import numpy as np

from services.watermark_engine import WatermarkEngine


def test_short_text_not_detectable():
    """文本过短 (< 2 字符) 时返回非 AI 判定"""
    engine = WatermarkEngine()
    r = engine.detect_watermark("A")
    assert r["is_ai_generated"] is False
    assert r["watermark_chars"] == 0
    assert r["num_tokens_scored"] == 0


def test_human_text_not_ai():
    """普通中文/英文文本不应被误判为 AI 生成"""
    engine = WatermarkEngine()
    text = "这是一段由人类作者撰写的科研论文引言，介绍了水印技术的基本概念与应用背景。" * 3
    r = engine.detect_watermark(text)
    assert r["is_ai_generated"] is False
    assert 0.0 <= r["confidence"] <= 1.0
    assert "model_name" in r
    # 论文级统计量齐全
    assert "z_score" in r and "p_value" in r and "green_fraction" in r
    # 人工文本 z-score 不应超过阈值
    assert r["z_score"] < engine.detection_threshold


def test_watermarked_text_detected():
    """全绿名单采样 (hard watermark) 的文本可被检出 AI 信号"""
    engine = WatermarkEngine(gamma=0.5, delta=2.0, secret_key=b"test-secret")
    vocab = 65536  # 与 detect_watermark 的字符级词表保持一致

    # 构造 Kirchenbauer"硬水印": 每一步都从当前绿名单中采样,
    # 使 (prev, cur) 对全部命中绿名单 -> z-score 显著高于阈值
    rng = np.random.default_rng(7)
    prev = 100
    tokens = []
    for _ in range(120):
        mask = engine._green_list_mask(prev, vocab)
        green_ids = np.flatnonzero(mask)
        # 排除 surrogate 区 (不可独立成字符串)
        valid = green_ids[(green_ids < 0xD800) | (green_ids > 0xDFFF)]
        token = int(rng.choice(valid))
        tokens.append(token)
        prev = token

    text = "".join(chr(c) for c in tokens)
    r = engine.detect_watermark(text)
    assert r["is_ai_generated"] is True, f"watermarked text should be flagged, got {r}"
    assert r["watermark_chars"] > 0
    # 论文式置信度 = 1 - p_value, 强信号下应接近 1
    assert r["confidence"] > 0.99


def test_paper_seeding_reproducible():
    """论文式种子: 相同 prev_token + secret_key 生成一致绿名单 (PRF 性质)"""
    engine = WatermarkEngine(secret_key=b"fixed-key")
    m1 = engine._green_list_mask(prev_token=42, vocab_size=1000)
    m2 = engine._green_list_mask(prev_token=42, vocab_size=1000)
    assert np.array_equal(m1, m2)
    assert abs(float(m1.mean()) - 0.5) < 0.05  # gamma 默认 0.5 (随机波动容差)

    # 不同 prev_token -> 不同掩码
    m3 = engine._green_list_mask(prev_token=43, vocab_size=1000)
    assert not np.array_equal(m1, m3)


def test_zscore_formula_matches_paper():
    """论文式 z-score: (green - gamma*T) / sqrt(T*gamma*(1-gamma))"""
    engine = WatermarkEngine(gamma=0.5)
    T, green = 200, 130
    expected = (green - 0.5 * T) / math.sqrt(T * 0.5 * 0.5)
    assert math.isclose(engine._compute_z_score(green, T, engine.gamma), expected)
    # p-value = 1 - Phi(z) 单调递减
    assert engine._compute_p_value(0.0) == 0.5
    assert engine._compute_p_value(1.0) < 0.5
    assert engine._compute_p_value(4.0) < 1e-4


def test_embed_adds_delta_to_green_list():
    """embed_watermark 只对绿名单 logits 增加 delta 偏移"""
    engine = WatermarkEngine(delta=2.0)
    logits = np.zeros(1000)
    prev = 7
    mask = engine._green_list_mask(prev, 1000)
    out = engine.embed_watermark(logits, prev_token=prev, vocab_size=1000)
    assert np.allclose(out[mask], 2.0)
    assert np.allclose(out[~mask], 0.0)


def test_watermarked_logits_biased_toward_green():
    """嵌入水印后, 绿名单 token 采样概率应高于红名单"""
    engine = WatermarkEngine(gamma=0.5, delta=2.0, secret_key=b"test-secret")
    vocab = 1024
    rng = np.random.default_rng(11)
    prev = 5
    logits = rng.standard_normal(vocab)
    wm_logits = engine.embed_watermark(logits, prev_token=prev, vocab_size=vocab)
    mask = engine._green_list_mask(prev, vocab)

    def prob_of(log):
        e = np.exp(log - log.max())
        return e / e.sum()

    p_green_plain = prob_of(logits)[mask].sum()
    p_green_wm = prob_of(wm_logits)[mask].sum()
    assert p_green_wm > p_green_plain



def test_green_list_reproducible():
    """相同 prev_token + secret_key 生成一致的绿名单掩码"""
    engine = WatermarkEngine(secret_key=b"fixed-key")
    m1 = engine._green_list_mask(prev_token=42, vocab_size=1000)
    m2 = engine._green_list_mask(prev_token=42, vocab_size=1000)
    assert np.array_equal(m1, m2)
    assert float(m1.mean()) == 0.5  # gamma 默认 0.5

    # 不同 prev_token -> 不同掩码
    m3 = engine._green_list_mask(prev_token=43, vocab_size=1000)
    assert not np.array_equal(m1, m3)


def test_embed_adds_delta_to_green_list():
    """embed_watermark 只对绿名单 logits 增加 delta 偏移"""
    engine = WatermarkEngine(delta=2.0)
    logits = np.zeros(1000)
    prev = 7
    mask = engine._green_list_mask(prev, 1000)
    out = engine.embed_watermark(logits, prev_token=prev, vocab_size=1000)
    assert np.allclose(out[mask], 2.0)
    assert np.allclose(out[~mask], 0.0)
