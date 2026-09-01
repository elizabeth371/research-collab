"""
绿名单哈希粒度模式测试 (词级/锚点级/双通道)
=============================================
覆盖 (hash_mode 参数, 论文「中文水印鲁棒性改进」的实验基座):
- 4 种模式 (char_bigram / word_bigram / unigram_anchor / dual_anchor)
  各自注入->检出自洽: z>4, 且 delta=0 对照不检出 (水印来自注入而非文本)
- unigram_anchor 对局部乱序严格不变: 纯置换不改字符多重集 -> z 逐位相等
- dual_anchor 在乱序后仍检出 (锚点通道 z 不变), 而 char_bigram 同文本
  乱序后失效 —— 这是论文「字符级对语序扰动敏感」痛点的直接证据
- word_bigram 与 char_bigram 是互斥通道: 字符通道注入的文本在词通道
  下 z≈0 (证明词级种子确实按词绑定, 而非悄悄回退字符级)
"""

import numpy as np
import pytest

from services.watermark_attack import WatermarkAttackSuite
from services.watermark_engine import WatermarkEngine

VOCAB = list(
    "人工智能水印版权溯源科研协同编辑技术安全检测论文写作质量评估"
)

# 常用汉字池 (200 字): 锚点模式按「唯一字符」去重计数, 小词表会把有效
# 样本数压到 ~30 导致统计功效不足 (真实中文文本唯一字符数 200+)
_COMMON_HANZI = (
    "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主"
    "发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力"
    "里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因其"
    "由些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么"
    "利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直"
    "题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山"
)
VOCAB_BIG = list(_COMMON_HANZI[:200])

ALL_MODES = ["char_bigram", "word_bigram", "unigram_anchor", "dual_anchor"]
ALL_MODES_DEFAULT_VOCAB = ["char_bigram", "word_bigram"]
ALL_MODES_BIG_VOCAB = ["unigram_anchor", "dual_anchor"]


def _synthetic_candidates(
    n_positions: int = 300, seed: int = 42, vocab: list | None = None
) -> list:
    """与 test_watermark_resample 同构的合成候选流 (不触网)。"""
    vocab = vocab or VOCAB
    rng = np.random.default_rng(seed)
    candidates = []
    for _ in range(n_positions):
        idx = rng.choice(len(vocab), size=20, replace=False)
        lps = np.concatenate(
            [rng.uniform(-1.5, 0.0, size=1), rng.uniform(-12.0, -3.0, size=19)]
        )
        rng.shuffle(lps)
        candidates.append([(vocab[int(i)], float(lp)) for i, lp in zip(idx, lps)])
    return candidates


# ---------------------------------------------------------------------------
# 1. 各模式自洽: 注入 -> 检出; delta=0 对照不检出
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("mode", ALL_MODES_DEFAULT_VOCAB)
def test_mode_embeds_and_detects(mode):
    wm = WatermarkEngine(hash_mode=mode)
    candidates = _synthetic_candidates()
    text = wm.resample_with_watermark(
        candidates, rng=np.random.default_rng(7), delta=4.0
    )
    assert len(text) > 100
    result = wm.detect_watermark(text)
    assert result["is_ai_generated"] is True, (
        f"[{mode}] 注入后未检出: z={result['z_score']}"
    )
    assert result["z_score"] > 4.0
    # 模式感知的引擎标识 (默认模式保持历史值)
    assert result["model_name"] == (
        "kirchenbauer-v1" if mode == "char_bigram" else f"kirchenbauer-{mode}"
    )


@pytest.mark.parametrize("mode", ALL_MODES_BIG_VOCAB)
def test_mode_embeds_and_detects_big_vocab(mode):
    """锚点系模式按唯一字符去重, 需真实规模词表才有统计功效。"""
    wm = WatermarkEngine(hash_mode=mode)
    candidates = _synthetic_candidates(vocab=VOCAB_BIG)
    text = wm.resample_with_watermark(
        candidates, rng=np.random.default_rng(7), delta=4.0
    )
    assert len(text) > 100
    result = wm.detect_watermark(text)
    assert result["is_ai_generated"] is True, (
        f"[{mode}] 注入后未检出: z={result['z_score']} "
        f"unique_chars={len(set(text))}"
    )
    assert result["z_score"] > 4.0
    assert result["model_name"] == f"kirchenbauer-{mode}"


@pytest.mark.parametrize("mode", ALL_MODES)
def test_mode_delta_zero_not_detected(mode):
    """对照: delta=0 等价于按模型原分布采样, 任何模式都不应误判。"""
    vocab = VOCAB_BIG if mode in ALL_MODES_BIG_VOCAB else VOCAB
    wm = WatermarkEngine(hash_mode=mode)
    candidates = _synthetic_candidates(vocab=vocab)
    text = wm.resample_with_watermark(
        candidates, rng=np.random.default_rng(7), delta=0.0
    )
    result = wm.detect_watermark(text)
    assert result["is_ai_generated"] is False, (
        f"[{mode}] delta=0 被误判: z={result['z_score']}"
    )
    assert result["z_score"] < 2.0


# ---------------------------------------------------------------------------
# 2. 锚点模式: 局部乱序 (纯置换) 下 z 严格不变
# ---------------------------------------------------------------------------
def test_anchor_reorder_invariance():
    wm = WatermarkEngine(hash_mode="unigram_anchor")
    text = wm.resample_with_watermark(
        _synthetic_candidates(vocab=VOCAB_BIG),
        rng=np.random.default_rng(7),
        delta=4.0,
    )
    baseline = wm.detect_watermark(text)
    attacked = WatermarkAttackSuite.reorder_local(text, window=4, seed=1)
    after = wm.detect_watermark(attacked)
    # 置换不改字符多重集 -> 锚点绿名单命中数与总计数逐位相等
    assert after["z_score"] == baseline["z_score"]
    assert after["is_ai_generated"] is True


# ---------------------------------------------------------------------------
# 3. 双通道 vs 字符通道: 同一文本乱序后的对照实验 (论文核心表格的雏形)
# ---------------------------------------------------------------------------
def test_dual_survives_reorder_where_char_fails():
    candidates = _synthetic_candidates(vocab=VOCAB_BIG)
    rng_seed = np.random.default_rng(7)

    # 字符 bigram 注入: 乱序后失效 (痛点)
    char_wm = WatermarkEngine(hash_mode="char_bigram")
    char_text = char_wm.resample_with_watermark(candidates, rng=rng_seed, delta=4.0)
    char_base = char_wm.detect_watermark(char_text)
    char_attacked = char_wm.detect_watermark(
        WatermarkAttackSuite.reorder_local(char_text, window=4, seed=1)
    )
    assert char_base["is_ai_generated"] is True  # 乱序前正常检出
    assert char_attacked["is_ai_generated"] is False, (
        "预期字符 bigram 在窗口乱序后失效 (论文痛点)"
    )

    # 双通道注入: 乱序后锚点通道仍检出
    dual_wm = WatermarkEngine(hash_mode="dual_anchor")
    dual_text = dual_wm.resample_with_watermark(candidates, rng=rng_seed, delta=4.0)
    dual_attacked = dual_wm.detect_watermark(
        WatermarkAttackSuite.reorder_local(dual_text, window=4, seed=1)
    )
    assert dual_attacked["is_ai_generated"] is True
    assert dual_attacked["z_anchor"] > 4.0
    assert "z_char" in dual_attacked and "z_anchor" in dual_attacked


# ---------------------------------------------------------------------------
# 4. 词级与字符级是互斥通道 (词级种子确实按词绑定)
# ---------------------------------------------------------------------------
def test_word_mode_is_distinct_channel_from_char():
    candidates = _synthetic_candidates()
    char_text = WatermarkEngine(hash_mode="char_bigram").resample_with_watermark(
        candidates, rng=np.random.default_rng(7), delta=4.0
    )
    char_detect = WatermarkEngine(hash_mode="char_bigram").detect_watermark(char_text)
    assert char_detect["is_ai_generated"] is True

    # 同一文本用词级引擎检测: 词级种子与字符级偏置互不相关 -> z≈0
    word_detect = WatermarkEngine(hash_mode="word_bigram").detect_watermark(char_text)
    assert word_detect["is_ai_generated"] is False
    assert word_detect["z_score"] < 2.0
