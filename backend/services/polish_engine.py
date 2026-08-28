"""
写稿人润色引擎 (规则实现)
==========================
对选中文本 / 段落执行确定性的学术化润色, 供 WriterAgent 与 /api/agents/polish 使用。

润色维度 (全部为安全变换, 不改变原意):
  1. 措辞升级: 口语 / 网络化表达 -> 学术表达 (仅多字短语, 避免单字误伤)
  2. 冗余清理: "进行了实验" -> "实验" 等明确无歧义的搭配
  3. 标点归一: 中文标点统一 (省略号 / 引号 / 句读全角化)
  4. 学术句式: 惯用语 -> 规范学术句式

输出带变更清单 (before -> after), 供前端展示与溯源; 无变化的文本原样返回
(changes 为空, 前端可提示"文本已符合学术规范, 无需润色")。

接口保持纯净 (纯函数), 后续接入 LLM 语义润色时, 仅需替换引擎内部实现,
调用方 (API / Agent 节点) 无需改动。
"""

import re
from typing import List, TypedDict


class PolishChange(TypedDict):
    """一条润色变更"""

    type: str      # phrasing / redundancy / punctuation / sentence
    before: str
    after: str


class PolishResult(TypedDict):
    """润色结果"""

    original: str
    polished: str
    changes: List[PolishChange]
    stats: dict


class PolishEngine:
    """规则化学术润色引擎"""

    # ---- 1. 措辞升级表: 口语化/网络化 -> 学术表达 ----
    # 仅收录 2 字以上短语: 单字替换 (想/能/做/看/挺/蛮) 无边界可判,
    # 会误伤 "思想 / 能力 / 做法 / 看法 / 挺拔" 等词, 故不收录。
    PHRASE_UPGRADES: dict[str, str] = {
        "我们做了": "本研究开展了",
        "我们提出": "本文提出",
        "我们研究了": "本研究探讨了",
        "我们探讨了": "本研究探讨了",
        "我们分析了": "本研究分析了",
        "本文的目标是": "本文旨在",
        "我们的目标是": "本文旨在",
        "做的事情": "开展的工作",
        "很多方面": "诸多方面",
        "一大堆": "大量",
        "特别重要": "至关重要",
        "非常重要": "具有重要意义",
        "意义重大": "具有重要意义",
        "挺好的": "效果良好",
        "非常不错": "效果良好",
        "特别棒": "性能优越",
        "很好的": "良好的",
        "非常好": "显著",
        "很好": "良好",
        "非常多": "极为丰富",
        "很多": "大量",
        "非常": "显著",
        "特别": "尤为",
        "差不多能": "基本可",
        "差不多": "基本",
        "基本上": "总体上",
        "大概": "大致",
        "用来": "用于",
        "用到": "应用于",
        "比如像": "诸如",
        "比如说": "例如",
        "比如": "例如",
        "还有": "此外",
        "另外": "此外",
        "所以": "因此",
        "因为": "由于",
        "但是": "然而",
        "可是": "然而",
        "想要": "拟",
        "得到": "获得",
        "得出": "获得",
        "弄明白": "厘清",
        "搞清楚": "厘清",
        "说的是": "所述",
        "提到的": "所述",
        "咱们": "本文",
        "我们": "本文",
    }

    # 多字词优先匹配: 按长度降序 (避免 "非常" 先吃掉 "非常不错" 中的 "非常")
    _PHRASE_ITEMS: list[tuple[str, str]] = sorted(
        PHRASE_UPGRADES.items(), key=lambda kv: len(kv[0]), reverse=True
    )    # ---- 2. 冗余/形式动词清理 (保守): ----
    # "进行了X" 若直接删 "X" 前的动词会破坏动宾结构 ("本文实验。" 病句),
    # 故仅升级形式动词 "进行了" -> "开展了", 以及指示词学术化。
    # 不含 "的内容" -> "内容" 这类规则 —— "生成内容的溯源" 中删 "的" 会
    # 破坏定中结构, 宁可不改。
    REDUNDANCY_RULES: list[tuple[str, str]] = [
        ("进行了", "开展了"),
        ("这个", "该"),
        ("这些", "上述"),
        ("那些", "上述"),
    ]

    # ---- 3. 标点归一 ----
    PUNCT_RULES: list[tuple[str, str]] = [
        # 省略号统一为六点中文省略号
        ("...", "……"),
        ("…", "……"),
        # 全角化半角句读 (句号需带空格上下文, 单独处理避免破坏小数/缩写)
        ("(", "（"),
        (")", "）"),
        (",", "，"),
        (";", "；"),
        (":", "："),
        ("!", "！"),
        ("?", "？"),
    ]

    # ---- 4. 学术句式 (仅安全前缀) ----
    SENTENCE_PATTERNS: list[tuple[str, str]] = [
        ("本文的目标是", "本文旨在"),
        ("我们的目标是", "本文旨在"),
        ("本文主要讨论", "本文聚焦于"),
        ("本文主要研究", "本文聚焦于"),
    ]

    # ---- 词表规则合并为单次正则扫描 ----
    # 句式/措辞/冗余三张词表 (~60 条) 若逐条 str.replace, 每条要对全文
    # 扫描两遍 (in 判断 + replace); 合并为一个"最长优先"交替正则后,
    # 全文只需扫描一遍。各表替换产物均不含其他表的关键词 (无级联),
    # 单次扫描与逐条替换的输出完全一致。
    _WORD_RULES: list[tuple[str, str, str]] = sorted(
        (
            *[(k, v, "sentence") for k, v in SENTENCE_PATTERNS],
            *[(k, v, "phrasing") for k, v in _PHRASE_ITEMS],
            *[(k, v, "redundancy") for k, v in REDUNDANCY_RULES],
        ),
        key=lambda kv: len(kv[0]),
        reverse=True,
    )
    _WORD_RULE_MAP: dict[str, tuple[str, str]] = {k: (v, t) for k, v, t in _WORD_RULES}
    _WORD_RULE_RE: re.Pattern[str] = re.compile(
        "|".join(re.escape(k) for k, _, _ in _WORD_RULES)
    )

    # 断言词表 (供审稿引擎引用): 疑似结论断言但段内无引用支撑
    ASSERTION_WORDS: tuple[str, ...] = (
        "实验结果表明",
        "结果表明",
        "表明",
        "证明",
        "证实",
        "验证了",
        "显著",
        "导致了",
        "揭示",
        "说明",
    )

    # 口语化词表 (供审稿引擎引用)
    COLLOQUIAL_WORDS: tuple[str, ...] = (
        "很多",
        "非常多",
        "挺好的",
        "非常不错",
        "特别棒",
        "差不多",
        "大概",
        "一大堆",
        "一堆",
        "咱们",
        "弄明白",
        "搞清楚",
        "想",
    )

    # ------------------------------------------------------------------
    # 主入口
    # ------------------------------------------------------------------
    @classmethod
    def polish_text(cls, text: str) -> PolishResult:
        """
        对一段文本执行学术润色, 返回原文 / 润色后文本 / 变更清单 / 统计。

        输入为空或无需润色时, polished 与 original 一致, changes 为空。
        """
        original = text
        if not text or not text.strip():
            return {
                "original": original,
                "polished": original,
                "changes": [],
                "stats": {
                    "chars_before": len(original),
                    "chars_after": len(original),
                    "change_count": 0,
                },
            }

        changes: List[PolishChange] = []
        current = text

        # ---- 4+1+2. 句式 / 措辞 / 冗余: 单次正则扫描 (最长优先匹配) ----
        rule_map = cls._WORD_RULE_MAP

        def _apply_word_rule(m: "re.Match[str]") -> str:
            src = m.group(0)
            after, rule_type = rule_map[src]
            changes.append(
                {"type": rule_type, "before": src, "after": after}
            )
            return after

        current = cls._WORD_RULE_RE.sub(_apply_word_rule, current)

        # ---- 3. 标点归一 ----
        for before, after in cls.PUNCT_RULES:
            if before in current:
                current = current.replace(before, after)
                changes.append({"type": "punctuation", "before": before, "after": after})

        # 半角句号 + 空格 -> 中文句号 (排除小数点与缩写场景)
        if ". " in current and not re.search(r"\d\. \d", current):
            current = current.replace(". ", "。")
            changes.append({"type": "punctuation", "before": ". ", "after": "。"})

        # 末尾无句读时补句号 (学术正文规范)
        stripped = current.rstrip()
        if stripped and stripped[-1] not in "。；！？…”」』】":
            current = stripped + "。"
            changes.append({"type": "punctuation", "before": "", "after": "。"})

        # 去重 (同一位置可能命中多条规则)
        seen: set[tuple[str, str, str]] = set()
        dedup: List[PolishChange] = []
        for c in changes:
            key = (c["type"], c["before"], c["after"])
            if key in seen:
                continue
            seen.add(key)
            dedup.append(c)

        return {
            "original": original,
            "polished": current,
            "changes": dedup,
            "stats": {
                "chars_before": len(original),
                "chars_after": len(current),
                "change_count": len(dedup),
            },
        }
