"""
审稿红牌 -> 自动重写引擎 (规则版)
====================================
针对 AcademicReviewEngine 判定的红牌 (error 级) 问题, 执行确定性规则重写:

  - 引用编号不连续   -> 正文按首次出现顺序重新编号, 参考文献条目随之改标
  - 缺少参考文献章节 -> 按最大引用编号补齐 [n] 占位条目 (供后续人工补全)
  - 篇幅过短         -> 追加 引言/方法/结论 模板段, 使草稿达到成文篇幅

每次重写后重新调用 AcademicReviewEngine 复检, 输出红牌前后对比,
供编排器判断是否需要再次修订 (上限 N 轮) / 前端展示"重写前后"。

空文档 / 无红牌问题时不重写 (返回原文, 由上游提示补充内容)。
"""

import re
from typing import List, Optional, TypedDict

from services.academic_review import AcademicReviewEngine


class RewriteChange(TypedDict):
    """一条重写变更 (供前端展示与溯源)"""

    type: str                 # citation / references / length
    before: str
    after: str
    para_index: Optional[int]  # 全文级修复为 None


class RewriteResult(TypedDict):
    """重写结果"""

    text: str
    changes: List[RewriteChange]
    engine: str
    red_cards_before: int
    red_cards_after: int
    passed_after: bool


class RewriteEngine:
    """红牌问题的确定性规则重写引擎"""

    CITATION_RE = AcademicReviewEngine.CITATION_RE
    REF_HEADING_RE = re.compile(r"(?m)^\s*#{0,6}\s*(参考文献|References)\s*$")

    # 篇幅过短时的扩写模板 (插入草稿尾部, 与主题呼应)
    _EXPANSION = (
        "\n\n## 引言\n"
        "本研究聚焦{draft_snip}。随着大模型与协同编辑技术的融合，"
        "科研协作中 AI 生成内容的版权归属与可信溯源成为亟待解决的问题，"
        "本文面向上述需求开展相关工作。\n\n"
        "## 方法\n"
        "系统采用 Yjs CRDT 实现多端实时协同编辑，通过多 Agent 编排完成"
        "检索、起草与审阅，并对 AI 生成内容嵌入可检测水印，实现全链路溯源。\n\n"
        "## 结论\n"
        "本文围绕{draft_snip}展开研究，后续将进一步扩充实验验证与定量评估。"
    )

    # ------------------------------------------------------------------
    # 公开入口
    # ------------------------------------------------------------------
    @classmethod
    def rewrite_document(
        cls,
        text: str,
        review_result: Optional[dict] = None,
    ) -> RewriteResult:
        """
        对草稿执行红牌修复重写。

        Args:
            text:          待重写草稿全文
            review_result: 可选。已跑过的审查结果 (避免重复审查);
                           None 时内部重新审查。

        Returns:
            RewriteResult: {text, changes, engine, red_cards_before,
                            red_cards_after, passed_after}
        """
        review = review_result or AcademicReviewEngine.review_document(text)
        red_before = review["red_cards"]
        changes: List[RewriteChange] = []

        # 编辑器 markdown 持久化会把 [n] 转义为 \[n\], 归一化后
        # 引用编号/参考文献规则才能正确识别 (重写输出用普通括号, 前端可直接应用)
        text = AcademicReviewEngine._normalize(text)

        if not text.strip():
            # 空文档无内容可重写, 原样返回
            return {
                "text": text,
                "changes": changes,
                "engine": "rule",
                "red_cards_before": red_before,
                "red_cards_after": red_before,
                "passed_after": False,
            }

        if red_before == 0:
            return {
                "text": text,
                "changes": changes,
                "engine": "rule",
                "red_cards_before": 0,
                "red_cards_after": 0,
                "passed_after": True,
            }

        # ---- 1. 引用编号不连续 -> 按首次出现顺序重排 ----
        new_text = cls._fix_citation_gaps(text, changes)

        # ---- 2. 缺少参考文献章节 -> 补齐占位条目 ----
        new_text = cls._fix_missing_refs(new_text, changes)

        # ---- 3. 篇幅过短 -> 追加 引言/方法/结论 模板 ----
        new_text = cls._fix_short_text(new_text, changes)

        # ---- 复检 ----
        review_after = AcademicReviewEngine.review_document(new_text)
        return {
            "text": new_text,
            "changes": changes,
            "engine": "rule",
            "red_cards_before": red_before,
            "red_cards_after": review_after["red_cards"],
            "passed_after": review_after["red_cards"] == 0,
        }

    # ------------------------------------------------------------------
    # 规则: 引用编号重排
    # ------------------------------------------------------------------
    @classmethod
    def _fix_citation_gaps(cls, text: str, changes: List[RewriteChange]) -> str:
        """正文引用编号不连续 (缺号) -> 按首次出现顺序重排, 参考文献改标"""
        body, refs = cls._split_body_refs(text)

        order: List[int] = []
        mapping: dict = {}

        def repl(m: "re.Match[str]") -> str:
            n = int(m.group(1))
            if n not in mapping:
                mapping[n] = len(order) + 1
                order.append(n)
            return f"[{mapping[n]}]"

        new_body = cls.CITATION_RE.sub(repl, body)
        if not order:
            return text

        old_nums = sorted(set(order))
        if old_nums == list(range(1, len(order) + 1)):
            return text  # 本就连续, 无需重排

        # 参考文献条目行首 [n] 随之改标; 未被正文引用的条目顺延编号
        if refs:
            max_new = len(order)
            used = set(mapping.values())
            next_free = max_new + 1

            def ref_repl(m: "re.Match[str]") -> str:
                nonlocal next_free
                n = int(m.group(1))
                if n in mapping:
                    return f"[{mapping[n]}]"
                while next_free in used:
                    next_free += 1
                used.add(next_free)
                return f"[{next_free}]"

            refs = cls.CITATION_RE.sub(ref_repl, refs)

        changes.append(
            {
                "type": "citation",
                "before": f"引用编号不连续 (原编号 {old_nums})",
                "after": f"已按出现顺序重排为连续编号 1-{len(order)}",
                "para_index": None,
            }
        )
        return f"{new_body}\n{refs}" if refs else new_body

    # ------------------------------------------------------------------
    # 规则: 补齐参考文献章节
    # ------------------------------------------------------------------
    @classmethod
    def _fix_missing_refs(cls, text: str, changes: List[RewriteChange]) -> str:
        """正文存在引用但缺参考文献章节 -> 按最大引用编号补齐占位条目"""
        body, refs = cls._split_body_refs(text)
        if refs.strip():
            return text  # 已有参考文献章节

        nums = sorted({int(m) for m in cls.CITATION_RE.findall(body)})
        if not nums:
            return text

        max_cite = max(nums)
        ref_lines = [
            f"[{i}] 占位文献条目 {i}: 待补充完整著录信息[J]. 期刊, 2024."
            for i in range(1, max_cite + 1)
        ]
        changes.append(
            {
                "type": "references",
                "before": "正文存在引用但缺少『参考文献』章节",
                "after": f"已补齐参考文献章节 ({len(ref_lines)} 条占位条目, 待人工补全)",
                "para_index": None,
            }
        )
        return f"{body.rstrip()}\n\n## 参考文献\n" + "\n".join(ref_lines)

    # ------------------------------------------------------------------
    # 规则: 篇幅扩充
    # ------------------------------------------------------------------
    @classmethod
    def _fix_short_text(cls, text: str, changes: List[RewriteChange]) -> str:
        """篇幅过短 (<100 字) -> 追加 引言/方法/结论 模板段"""
        stats = AcademicReviewEngine._collect_stats(text)
        chars = stats["chars"]
        if chars >= 100:
            return text

        # 以草稿开头内容作为扩写主题 (截取去标点前 40 字)
        plain = re.sub(r"\s+", "", text)
        topic = plain[:40] or "智能科研协同与 AI 内容溯源"
        if len(topic) < 4:
            topic = "智能科研协同与 AI 内容溯源"

        new_text = text.rstrip() + cls._EXPANSION.format(draft_snip=topic)
        new_chars = AcademicReviewEngine._collect_stats(new_text)["chars"]
        changes.append(
            {
                "type": "length",
                "before": f"草稿篇幅过短 (仅 {chars} 字)",
                "after": f"已扩充至 {new_chars} 字 (补齐引言/方法/结论结构)",
                "para_index": None,
            }
        )
        return new_text

    # ------------------------------------------------------------------
    # 工具
    # ------------------------------------------------------------------
    @staticmethod
    def _split_body_refs(text: str) -> "tuple[str, str]":
        """按『参考文献/References』标题切分正文与文献区 (无标题则文献区为空)"""
        m = RewriteEngine.REF_HEADING_RE.search(text)
        if not m:
            return text, ""
        return text[: m.start()], text[m.end() :]
