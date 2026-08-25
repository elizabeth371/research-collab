"""
logprobs 重采样水印测试 (步骤 9: 真实 LLM key 接入)
=====================================================
覆盖:
- 合成候选流 (不触网): 重采样后文本可被 detect_watermark 检出 (z>4),
  delta=0 对照不检出 —— 证明水印由重采样注入而非文本本身
- 多字符 token 候选: 字符级对齐 (token 边界不影响检测)
- 候选过滤: 空 token / 代理区码点被剔除
- 确定性: 注入固定 rng 种子可复现 (测试友好 / 审计可复现)
- generate_watermarked 编排: 无候选返回 None (降级); 有候选产出文本
- 真实 DeepSeek 端到端 (有 key 时): 生成 -> 重采样 -> 检测 True
"""

import numpy as np
import pytest

from services.llm_client import llm_client
from services.watermark_engine import WatermarkEngine


# ---------------------------------------------------------------------------
# 合成候选流: 模拟一个在 30 字符词表上均匀采样的"模型"
# ---------------------------------------------------------------------------
VOCAB = list(
    "人工智能水印版权溯源科研协同编辑技术安全检测论文写作质量评估"
)
VOCAB_CODES = [ord(c) for c in VOCAB]


def _synthetic_candidates(
    n_positions: int = 200,
    n_top: int = 20,
    seed: int = 42,
) -> list:
    """每位置 n_top 个 (字符, logprob), logprob 呈近似真实分布 (首位高, 其余低)"""
    rng = np.random.default_rng(seed)
    candidates = []
    for _ in range(n_positions):
        idx = rng.choice(len(VOCAB), size=n_top, replace=False)
        # 首位 logprob ~ U(-1.5, 0), 其余 ~ U(-12, -3)
        lps = np.concatenate(
            [
                rng.uniform(-1.5, 0.0, size=1),
                rng.uniform(-12.0, -3.0, size=n_top - 1),
            ]
        )
        rng.shuffle(lps)
        candidates.append([(VOCAB[int(i)], float(lp)) for i, lp in zip(idx, lps)])
    return candidates


# ---------------------------------------------------------------------------
# 核心: 重采样注入水印, 检测端零改动即可检出
# ---------------------------------------------------------------------------
def test_resample_embeds_detectable_watermark():
    wm = WatermarkEngine()
    candidates = _synthetic_candidates()
    text = wm.resample_with_watermark(candidates, rng=np.random.default_rng(7))
    assert len(text) > 100
    result = wm.detect_watermark(text)
    assert result["is_ai_generated"] is True
    assert result["z_score"] > 4.0
    assert result["green_fraction"] > 0.6


def test_resample_delta_zero_is_not_watermarked():
    """对照: delta=0 等价于按模型原分布采样, 不应被误判为 AI 水印"""
    wm_zero = WatermarkEngine(delta=0.0)
    candidates = _synthetic_candidates()
    text = wm_zero.resample_with_watermark(candidates, rng=np.random.default_rng(7))
    result = wm_zero.detect_watermark(text)
    assert result["is_ai_generated"] is False
    assert result["z_score"] < 2.0
    assert 0.3 < result["green_fraction"] < 0.7


def test_resample_multichar_tokens_aligned():
    """
    多字符 BPE token (如 '技术在') 展开后逐字符计绿, 与检测端字符级
    bigram 完全对齐 —— token 边界不影响水印统计量。
    """
    rng = np.random.default_rng(3)
    vocab = list("人工智能水印版权溯源科研协同编辑技术安全检测论文写作质量评估")
    candidates = []
    # 模拟中文 BPE: 候选为随机长度 (1-4 字符) 子串, 词表多样
    for _ in range(160):
        toks = [
            "".join(vocab[int(i)] for i in rng.integers(0, len(vocab), size=k))
            for k in rng.integers(1, 5, size=12)
        ]
        lps = rng.uniform(-10.0, 0.0, size=12)
        candidates.append([(t, float(lp)) for t, lp in zip(toks, lps)])
    wm = WatermarkEngine(delta=3.0)
    text = wm.resample_with_watermark(candidates, rng=np.random.default_rng(5))
    result = wm.detect_watermark(text)
    assert result["is_ai_generated"] is True
    assert result["z_score"] > 4.0


def test_resample_filters_surrogate_and_empty():
    """空 token 与代理区码点候选不得进入结果 (否则无法编码/落库)"""
    wm = WatermarkEngine()
    candidates = [
        [("", -1.0), ("\ud800", -1.0), ("安", -0.2), ("水", -1.5)],
        [("\udfff", -1.0), ("\udfff", -0.5), ("印", -0.1)],
        [("全", -0.3), ("", -2.0)],
    ]
    text = wm.resample_with_watermark(candidates, rng=np.random.default_rng(1))
    assert len(text) == 3
    assert all(not (0xD800 <= ord(c) <= 0xDFFF) for c in text)
    assert all(c in "安水印全" for c in text)


def test_resample_deterministic_with_seed():
    """固定 rng 种子 -> 相同文本 (审计/测试可复现)"""
    wm = WatermarkEngine()
    candidates = _synthetic_candidates(seed=11)
    a = wm.resample_with_watermark(candidates, rng=np.random.default_rng(99))
    b = wm.resample_with_watermark(candidates, rng=np.random.default_rng(99))
    assert a == b and a != ""


# ---------------------------------------------------------------------------
# generate_watermarked 编排 (stub LLM, 不触网)
# ---------------------------------------------------------------------------
class _StubLLM:
    def __init__(self, result):
        self._result = result

    async def generate_with_logprobs(self, messages, **kwargs):
        return self._result


@pytest.mark.asyncio
async def test_generate_watermarked_none_without_candidates():
    wm = WatermarkEngine()
    result = await wm.generate_watermarked(_StubLLM(None), [{"role": "user", "content": "x"}])
    assert result is None


@pytest.mark.asyncio
async def test_generate_watermarked_roundtrip_with_stub():
    wm = WatermarkEngine()
    candidates = _synthetic_candidates(n_positions=200)
    text = await wm.generate_watermarked(
        _StubLLM(candidates),
        [{"role": "user", "content": "x"}],
        rng=np.random.default_rng(7),
    )
    assert text and len(text) > 100
    assert wm.detect_watermark(text)["is_ai_generated"] is True


# ---------------------------------------------------------------------------
# 真实 DeepSeek 端到端 (需配置 LLM_API_KEY; 无 key 自动跳过)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
@pytest.mark.skipif(
    not llm_client.is_available(),
    reason="未配置 LLM_API_KEY, 跳过真实 LLM 端到端测试",
)
async def test_real_deepseek_logprobs_resample_roundtrip():
    """
    真实链路: DeepSeek 逐位置返回 top-N logprobs -> 本地绿名单重采样
    -> detect_watermark 检出 (z>4)。这是「接入真实 LLM key 跑通水印」
    的核心验收。走生产路径 generate_watermarked (delta 取配置 4.0)。
    """
    wm = WatermarkEngine()
    messages = [
        {"role": "system", "content": "你是一位严谨的中文学术论文写作者。"},
        {
            "role": "user",
            "content": "请撰写一段约 300 字的中文介绍，说明 AI 生成内容水印对科研诚信的作用。",
        },
    ]
    # 400 token ≈ 400 字: z 随 sqrt(文本长度) 增长, 保证 delta=3 下稳定检出
    text = await wm.generate_watermarked(llm_client, messages, max_tokens=400)
    assert text, "DeepSeek logprobs 端到端生成失败"
    assert len(text) >= 100, "生成文本过短, 无法可靠检测"

    result = wm.detect_watermark(text)
    assert result["is_ai_generated"] is True, (
        f"真实 LLM 水印未被检出: z={result['z_score']}, "
        f"green_fraction={result['green_fraction']}, text={text[:80]}..."
    )
