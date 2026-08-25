"""
Kirchenbauer 水印引擎 (论文级实现)
===================================
实现 Kirchenbauer et al. (2023) "A Watermark for Large Language Models"
(ICML 2023, arXiv:2301.10226) 的绿名单/红名单 (green/red list) 水印方案。

算法依据
--------
- 绿名单生成: 以 大素数 hash_key × 前序 token 为 RNG 种子, 对词表做
  Fisher-Yates 洗牌 (randperm), 取前 gamma 比例为绿名单 —— 与论文官方
  实现 (github.com/jwkirchenbauer/lm-watermarking, Apache-2.0) 的
  `_seed_rng` / `_get_greenlist_ids` 一致。
- 检测统计: z-score = (green - gamma*T) / sqrt(T*gamma*(1-gamma)),
  p-value = 1 - Phi(z), 判定规则 z > z_threshold (论文 4-sigma 建议)。
- 安全检测: 支持 ignore_repeated_bigrams —— 对唯一 bigram 去重计数,
  避免文本中重复 n-gram 虚高 z 值 (论文 "On the Reliability of
  Watermarks" 的修正检测)。

许可声明
--------
本模块按论文方法重新实现, 算法结构与以下 Apache-2.0 项目一致:
  "A Watermark for Large Language Models", Copyright 2023 Authors of
  "A Watermark for Large Language Models"
  https://github.com/jwkirchenbauer/lm-watermarking (Apache License 2.0)
详见 THIRD_PARTY_NOTICES.md 与 THIRD_PARTY/LICENSE-lm-watermarking.txt。

运行说明
--------
- 默认字符级 tokenizer (Unicode BMP), 无模型即可演示完整闭环;
- 若安装 transformers, 可传入真实 tokenizer 做 token 级检测 (预留)。
"""

import hashlib
import math
import secrets
from typing import Dict, List, Optional, Tuple

import numpy as np

from config import settings


class WatermarkEngine:
    """
    Kirchenbauer 水印引擎。

    参数 (来自配置):
      gamma:      绿名单 token 比例 (默认 0.5)
      delta:      logits 偏移量 (默认 2.0)
      secret_key: 哈希密钥 (参与 RNG 种子混合, 保证绿名单不可被他人预测)
      hash_key:   论文式 RNG 种子素数 (官方默认 15485863)
    """

    def __init__(
        self,
        gamma: float | None = None,
        delta: float | None = None,
        secret_key: bytes | None = None,
        hash_key: int | None = None,
    ) -> None:
        self.gamma: float = gamma if gamma is not None else settings.WATERMARK_GAMMA
        self.delta: float = delta if delta is not None else settings.WATERMARK_DELTA
        self.secret_key: bytes = (
            secret_key if secret_key is not None else settings.WATERMARK_SECRET_KEY
        )
        # 论文式种子素数 (与官方实现一致)
        self.hash_key: int = hash_key if hash_key is not None else 15485863
        # 检测阈值: z-score > 4.0 判定为含水印 (论文建议的 5-sigma 近似)
        self.detection_threshold: float = 4.0

    # ------------------------------------------------------------------
    # 核心: 论文式绿名单生成 (seeding = hash_key * prev_token)
    # ------------------------------------------------------------------
    def _seed_rng(self, prev_token: int) -> np.random.Generator:
        """
        论文式 RNG 种子: seed = hash_key * prev_token (官方 _seed_rng 逻辑),
        并与 secret_key 的哈希混合, 使绿名单依赖密钥而不可预测。

        Args:
            prev_token: 前一个 token 的整数 ID (>= 1 字符可作种子)

        Returns:
            确定性 RNG 实例 (相同 prev_token + secret_key 得到相同绿名单)
        """
        base_seed = self.hash_key * max(prev_token, 1)
        key_digest = int.from_bytes(
            hashlib.sha256(self.secret_key).digest()[:8], "big"
        )
        return np.random.default_rng((base_seed ^ key_digest) % (2**63))

    def _green_list_mask(
        self, prev_token: int, vocab_size: int
    ) -> np.ndarray:
        """
        根据前一个 token 生成绿名单布尔掩码。

        与论文官方实现一致: 以种子 RNG 对词表做均匀洗牌 (randperm),
        取前 gamma 比例为绿名单。

        Args:
            prev_token: 前一个 token 的整数 ID
            vocab_size: 词表大小

        Returns:
            np.ndarray[bool] 形状 (vocab_size,), True 表示属于绿名单
        """
        rng = self._seed_rng(prev_token)
        permutation = rng.permutation(vocab_size)
        green_count = int(vocab_size * self.gamma)
        mask = np.zeros(vocab_size, dtype=bool)
        mask[permutation[:green_count]] = True
        return mask

    # ------------------------------------------------------------------
    # 嵌入水印
    # ------------------------------------------------------------------
    def embed_watermark(
        self,
        logits: np.ndarray,
        prev_token: int,
        *,
        vocab_size: Optional[int] = None,
    ) -> np.ndarray:
        """
        对单步 logits 注入水印 (修改 logits 偏向绿名单)。

        Args:
            logits:    形状 (vocab_size,) 的模型输出 logits
            prev_token: 前一个已生成 token 的 ID
            vocab_size: 词表大小 (默认取 len(logits))

        Returns:
            修改后的 logits (绿名单 token 增加 self.delta 偏移)
        """
        vocab_size = vocab_size if vocab_size is not None else len(logits)
        mask = self._green_list_mask(prev_token, vocab_size)

        # Kirchenbauer 算法: 仅对绿名单 logits 加 delta
        watermarked_logits = logits.copy()
        watermarked_logits[mask] += self.delta

        # TODO: 有偏采样 (bias sampling) 模式:
        #   若需严格输出绿名单 token，可在此对红名单 logits 置 -inf
        # watermarked_logits[~mask] = -np.inf

        return watermarked_logits

    # ------------------------------------------------------------------
    # 文本令牌化 (默认字符级; 预留真实 tokenizer 接入点)
    # ------------------------------------------------------------------
    def _tokenize(self, text: str) -> List[int]:
        """
        简易 tokenization: 将字符映射为整数 ID (Unicode BMP 范围)。

        TODO: 生产环境接入真实 tokenizer (如 tiktoken / transformers
        AutoTokenizer), 与生成时使用的 tokenizer 保持一致, 否则检测失效。
        """
        return [ord(ch) for ch in text]

    # ------------------------------------------------------------------
    # 检测统计: 论文式 z-score 与 p-value
    # ------------------------------------------------------------------
    @staticmethod
    def _compute_z_score(green_count: int, total: int, gamma: float) -> float:
        """
        论文式 z-score: (观测绿名单数 - 期望绿名单数) / 标准误。
        z = (green - gamma*T) / sqrt(T * gamma * (1 - gamma))
        """
        if total <= 0:
            return 0.0
        numer = green_count - gamma * total
        denom = math.sqrt(total * gamma * (1 - gamma))
        return float(numer / denom) if denom > 0 else 0.0

    @staticmethod
    def _compute_p_value(z: float) -> float:
        """单侧正态尾概率 p = 1 - Phi(z) (论文官方用 scipy.stats.norm.sf)"""
        if z > 1e308:
            return 0.0
        # 用互补误差函数精确计算标准正态上尾概率, 不依赖 scipy
        return 0.5 * math.erfc(z / math.sqrt(2.0))

    def _score_sequence(
        self,
        tokens: List[int],
        ignore_repeated_bigrams: bool = True,
    ) -> Dict[str, float]:
        """
        对 token 序列评分 (检测核心)。

        两种模式:
        - 标准模式: 以第 1 个 token 为种子, 逐对检查 (prev, cur) 命中绿名单;
        - ignore_repeated_bigrams: 对唯一 bigram 去重计数, 每个 bigram
          只计一次 (论文可靠性修正), 防止重复文本虚高统计量。
        """
        vocab_size = 65536  # 字符级 tokenizer 的词表 (Unicode BMP 范围)

        if ignore_repeated_bigrams:
            bigram_table: Dict[Tuple[int, int], bool] = {}
            for i in range(1, len(tokens)):
                bigram = (tokens[i - 1], tokens[i])
                if bigram in bigram_table:
                    continue
                mask = self._green_list_mask(bigram[0], vocab_size)
                bigram_table[bigram] = bool(mask[bigram[1] % vocab_size])
            green_count = sum(bigram_table.values())
            total = len(bigram_table)
        else:
            green_count = 0
            for i in range(1, len(tokens)):
                prev_token, cur_token = tokens[i - 1], tokens[i]
                mask = self._green_list_mask(prev_token, vocab_size)
                if mask[cur_token % vocab_size]:
                    green_count += 1
            total = len(tokens) - 1

        z_score = self._compute_z_score(green_count, total, self.gamma)
        return {
            "num_tokens_scored": total,
            "num_green_tokens": green_count,
            "green_fraction": green_count / total if total > 0 else 0.0,
            "z_score": round(z_score, 4),
            "p_value": round(self._compute_p_value(z_score), 10),
        }

    # ------------------------------------------------------------------
    # 检测水印
    # ------------------------------------------------------------------
    def detect_watermark(self, text: str) -> Dict[str, object]:
        """
        检测文本中是否包含 Kirchenbauer 水印 (论文级统计检验)。

        Args:
            text: 待检测文本

        Returns:
            {
                "is_ai_generated": bool,   # z > threshold 判定为 AI 生成
                "confidence": float,        # 置信度 = 1 - p_value
                "watermark_chars": int,     # 绿名单命中字符数
                "z_score": float,           # 论文式 z 统计量
                "p_value": float,           # 单侧尾概率
                "green_fraction": float,    # 绿名单命中比例
                "num_tokens_scored": int,   # 参与评分的 token 对数
                "model_name": str,          # 引擎标识
            }
        """
        tokens = self._tokenize(text)
        if len(tokens) < 2:
            # 文本过短无法检测 (需至少 1 个前缀 token 做种子)
            return {
                "is_ai_generated": False,
                "confidence": 0.0,
                "watermark_chars": 0,
                "z_score": 0.0,
                "p_value": 1.0,
                "green_fraction": 0.0,
                "num_tokens_scored": 0,
                "model_name": "kirchenbauer-v1",
            }

        stats = self._score_sequence(tokens)

        is_ai = stats["z_score"] > self.detection_threshold
        # 置信度: 论文官方定义为 1 - p_value (正判定时才有意义)
        confidence = round(1.0 - stats["p_value"], 6) if is_ai else 0.0

        return {
            "is_ai_generated": is_ai,
            "confidence": confidence,
            "watermark_chars": stats["num_green_tokens"],
            "z_score": stats["z_score"],
            "p_value": stats["p_value"],
            "green_fraction": stats["green_fraction"],
            "num_tokens_scored": stats["num_tokens_scored"],
            "model_name": "kirchenbauer-v1",
        }

    # ------------------------------------------------------------------
    # 便捷示例: 生成一段带水印文本 (内部测试用)
    # ------------------------------------------------------------------
    def demo_generate(self, seed_text: str, length: int = 32) -> str:
        """
        演示: 从种子文本出发，逐字符注入水印并采样。
        (不依赖真实 LLM, 用于验证 embed / detect 闭环)

        Args:
            seed_text: 起始文本 (提供 prev_token)
            length:    生成字符数
        """
        vocab_size = 65536
        rng = np.random.default_rng()
        generated = list(seed_text)
        last = ord(seed_text[-1]) if seed_text else 0

        for _ in range(length):
            # 模拟模型 logits: 随机分布 (近似均匀)
            logits = rng.standard_normal(vocab_size)
            watermarked = self.embed_watermark(
                logits, prev_token=last, vocab_size=vocab_size
            )
            # 屏蔽 Unicode 代理区 (U+D800-U+DFFF): 这些码点不是合法字符,
            # chr() 产生孤立代理, 无法 UTF-8 编码 / 写入数据库 (会抛异常)
            watermarked[0xD800 : 0xDFFF + 1] = -np.inf
            # softmax 采样
            probs = np.exp(watermarked - watermarked.max())
            probs /= probs.sum()
            next_id = int(rng.choice(vocab_size, p=probs))
            generated.append(chr(next_id))
            last = next_id

        return "".join(generated)


# 工具函数: 随机生成密钥 (用于创建新文档水印)
def generate_secret_key() -> bytes:
    """生成随机水印密钥 (32 字节)"""
    return secrets.token_bytes(32)
