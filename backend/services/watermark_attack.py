"""
水印对抗鲁棒性实验套件 (步骤 11)
===================================
对已注入水印的文本施加常见内容攻击, 度量检测统计量的衰减,
产出论文所需的鲁棒性实验数据 (攻击矩阵 -> z 值 / 检出率)。

支持的攻击 (全部字符级, 确定性可复现):
  no_attack            基线 (不攻击)
  delete_10 / delete_30  随机删除 10% / 30% 字符 (模拟内容删改)
  truncate_20          截断末尾 20% (模拟只引用开头部分)
  synonym_replace      中文同义替换 (模拟改写润色)
  noise_insert         插入噪声标点/空白 (模拟排版噪声)
  reorder_local        局部窗口乱序 (模拟错字/语序扰动)
  translate_roundtrip  机器翻译回译 zh->en->zh (真实 DeepSeek, 可选)

实现说明:
- 所有攻击带 seed 参数, 同 seed 结果可复现 (审计/论文实验需要);
- detect 复用 WatermarkEngine.detect_watermark, 统计量口径与生成侧一致。
"""

import random
from typing import Any, Dict, List, Optional

from services.watermark_engine import WatermarkEngine

# 中文同义词替换表 (确定性替换: 命中词被替换为其近义表达)
SYNONYM_MAP: List[tuple[str, str]] = [
    ("水印", "数字标记"),
    ("技术", "方法"),
    ("研究", "探讨"),
    ("系统", "平台"),
    ("论文", "文稿"),
    ("生成", "产出"),
    ("检测", "识别"),
    ("内容", "信息"),
    ("重要", "关键"),
    ("实现", "完成"),
    ("算法", "程序"),
    ("模型", "框架"),
    ("数据", "样本"),
    ("版权", "著作权"),
    ("溯源", "追踪"),
    ("协同", "协作"),
]

# 噪声字符池 (插入不会明显破坏阅读, 但会扰动字符级 bigram)
_NOISE_CHARS = [" ", "、", "，", "。", "：", ";", "x", "0"]


class WatermarkAttackSuite:
    """水印攻击矩阵执行器"""

    def __init__(self, engine: Optional[WatermarkEngine] = None) -> None:
        self.engine = engine or WatermarkEngine()

    # ------------------------------------------------------------------
    # 攻击算子 (静态, 确定性)
    # ------------------------------------------------------------------
    @staticmethod
    def delete_random(text: str, p: float, seed: int = 1) -> str:
        """
        随机删除 p 比例的非空白字符 (保留空白以维持段落结构)。

        实现: 逐个字符判定删除, 保证被删字符恰好约 p 比例,
        同 seed 结果可复现。
        """
        rng = random.Random(seed)
        kept: List[str] = []
        for ch in text:
            if ch.isspace() or rng.random() > p:
                kept.append(ch)
        return "".join(kept)

    @staticmethod
    def truncate_tail(text: str, ratio: float, seed: int = 1) -> str:
        """保留前 (1-ratio) 的字符, 模拟只引用文章开头部分。"""
        keep = max(1, int(len(text) * (1 - ratio)))
        return text[:keep]

    @staticmethod
    def synonym_replace(text: str, seed: int = 1) -> str:
        """确定性同义替换: 词表命中的词全部替换为近义表达 (模拟改写)。"""
        out = text
        for src, dst in SYNONYM_MAP:
            out = out.replace(src, dst)
        return out

    @staticmethod
    def insert_noise(text: str, per_100: int = 2, seed: int = 1) -> str:
        """每 100 字符插入 per_100 个噪声字符 (模拟排版噪声)。"""
        rng = random.Random(seed)
        chars = list(text)
        n = max(1, len(chars) * per_100 // 100)
        for _ in range(n):
            pos = rng.randint(0, len(chars))
            chars.insert(pos, rng.choice(_NOISE_CHARS))
        return "".join(chars)

    @staticmethod
    def reorder_local(text: str, window: int = 4, seed: int = 1) -> str:
        """对连续 window 字符的窗口做轻微乱序 (模拟语序扰动/错字)。"""
        rng = random.Random(seed)
        chars = list(text)
        i = 0
        while i + window <= len(chars):
            seg = chars[i : i + window]
            rng.shuffle(seg)
            chars[i : i + window] = seg
            i += window
        return "".join(chars)

    # ------------------------------------------------------------------
    # 真实攻击: 机器翻译回译 (zh -> en -> zh)
    # ------------------------------------------------------------------
    async def translate_roundtrip(
        self, llm_client: Any, text: str, *, max_len: int = 600
    ) -> Optional[str]:
        """
        机器翻译回译攻击: 中文 -> 英文 -> 中文 (DeepSeek 真实调用)。

        这是最强的改写类攻击: 翻译过程会重排措辞、替换同义表达,
        但对字符级水印 (依赖相邻字符的绿名单关系) 构成破坏。
        无 Key / 失败返回 None (由调用方标记为失败)。

        Args:
            llm_client: services.llm_client.LLMClient
            text:       待攻击文本
            max_len:    截断过长文本以控制成本与耗时

        Returns:
            回译后的中文文本; 失败返回 None
        """
        if not llm_client.is_available():
            return None
        src = text[:max_len]
        en = await llm_client.chat(
            [
                {
                    "role": "user",
                    "content": "请把下面中文翻译成英文，只输出英文译文，不要任何解释：\n\n" + src,
                }
            ],
            temperature=0.3,
            max_tokens=1500,
        )
        if not en:
            return None
        zh = await llm_client.chat(
            [
                {
                    "role": "user",
                    "content": "请把下面英文翻译回中文，只输出中文译文，不要任何解释：\n\n" + en,
                }
            ],
            temperature=0.3,
            max_tokens=1500,
        )
        return zh

    # ------------------------------------------------------------------
    # 攻击矩阵
    # ------------------------------------------------------------------
    def _detect_result(self, text: str, baseline_len: int) -> Dict[str, Any]:
        detect = self.engine.detect_watermark(text)
        return {
            "z_score": detect["z_score"],
            "green_fraction": detect["green_fraction"],
            "is_ai_generated": detect["is_ai_generated"],
            "num_tokens_scored": detect["num_tokens_scored"],
            "chars_after": len(text),
            "chars_retained": round(len(text) / baseline_len, 4) if baseline_len else 1.0,
        }

    def run(
        self,
        text: str,
        *,
        include_translation: bool = False,
        llm_client: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """
        执行完整攻击矩阵 (同步版本)。

        注意: 机器翻译回译涉及真实网络调用, 请使用 run_async()。
        同步版本仅执行确定性攻击; 传入 include_translation 时忽略回译项。

        Args:
            text:               已注入水印的待测文本
            include_translation: 忽略 (回译请用 run_async)
            llm_client:         忽略 (回译请用 run_async)

        Returns:
            {
              "text_len": int,
              "baseline": {z_score, ...},
              "attacks": [{name, label, z_score, is_ai_generated, ...}],
              "summary": {attacked: N, detected: M, detected_ratio, avg_z, min_z}
            }
        """
        baseline = self._detect_result(text, len(text))
        attacks: List[Dict[str, Any]] = [
            {
                "name": "no_attack",
                "label": "无攻击（基线）",
                **self._detect_result(text, len(text)),
            },
            {
                "name": "delete_10",
                "label": "随机删除 10% 字符",
                **self._detect_result(
                    self.delete_random(text, 0.10), len(text)
                ),
            },
            {
                "name": "delete_30",
                "label": "随机删除 30% 字符",
                **self._detect_result(
                    self.delete_random(text, 0.30, seed=2), len(text)
                ),
            },
            {
                "name": "truncate_20",
                "label": "截断末尾 20%",
                **self._detect_result(
                    self.truncate_tail(text, 0.20), len(text)
                ),
            },
            {
                "name": "synonym_replace",
                "label": "中文同义替换",
                **self._detect_result(self.synonym_replace(text), len(text)),
            },
            {
                "name": "noise_insert",
                "label": "插入噪声字符",
                **self._detect_result(
                    self.insert_noise(text, per_100=2), len(text)
                ),
            },
            {
                "name": "reorder_local",
                "label": "局部窗口乱序",
                **self._detect_result(self.reorder_local(text), len(text)),
            },
        ]

        return {
            "text_len": len(text),
            "baseline": baseline,
            "attacks": attacks,
            "summary": self._summarize(attacks),
            "translation_failed": False,
        }

    async def run_async(
        self,
        text: str,
        *,
        include_translation: bool = False,
        llm_client: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """
        攻击矩阵 (异步版本): 同步攻击 + 可选真实机器翻译回译。

        端点与 GUI 使用此版本; 回译失败时 attacks 不包含该行,
        并在 summary 标注 translation_failed=True。
        """
        baseline = self._detect_result(text, len(text))
        attacks: List[Dict[str, Any]] = [
            {
                "name": "no_attack",
                "label": "无攻击（基线）",
                **self._detect_result(text, len(text)),
            },
            {
                "name": "delete_10",
                "label": "随机删除 10% 字符",
                **self._detect_result(self.delete_random(text, 0.10), len(text)),
            },
            {
                "name": "delete_30",
                "label": "随机删除 30% 字符",
                **self._detect_result(self.delete_random(text, 0.30, seed=2), len(text)),
            },
            {
                "name": "truncate_20",
                "label": "截断末尾 20%",
                **self._detect_result(self.truncate_tail(text, 0.20), len(text)),
            },
            {
                "name": "synonym_replace",
                "label": "中文同义替换",
                **self._detect_result(self.synonym_replace(text), len(text)),
            },
            {
                "name": "noise_insert",
                "label": "插入噪声字符",
                **self._detect_result(self.insert_noise(text, per_100=2), len(text)),
            },
            {
                "name": "reorder_local",
                "label": "局部窗口乱序",
                **self._detect_result(self.reorder_local(text), len(text)),
            },
        ]

        translation_failed = False
        if include_translation and llm_client is not None:
            translated = await self.translate_roundtrip(llm_client, text)
            if translated:
                attacks.append(
                    {
                        "name": "translate_roundtrip",
                        "label": "机器翻译回译 zh→en→zh",
                        **self._detect_result(translated, len(text)),
                    }
                )
            else:
                translation_failed = True

        return {
            "text_len": len(text),
            "baseline": baseline,
            "attacks": attacks,
            "summary": self._summarize(attacks, translation_failed),
            "translation_failed": translation_failed,
        }

    @staticmethod
    def _summarize(attacks: List[Dict[str, Any]], translation_failed: bool = False) -> Dict[str, Any]:
        """汇总: 检出率 / 平均 z / 最小 z (不含基线行)。"""
        rows = [a for a in attacks if a["name"] != "no_attack"]
        if not rows:
            return {"attacked": 0, "detected": 0, "detected_ratio": 0.0,
                    "avg_z": 0.0, "min_z": 0.0, "translation_failed": translation_failed}
        zs = [a["z_score"] for a in rows]
        return {
            "attacked": len(rows),
            "detected": sum(1 for a in rows if a["is_ai_generated"]),
            "detected_ratio": round(sum(1 for a in rows if a["is_ai_generated"]) / len(rows), 4),
            "avg_z": round(sum(zs) / len(zs), 4),
            "min_z": round(min(zs), 4),
            "translation_failed": translation_failed,
        }
