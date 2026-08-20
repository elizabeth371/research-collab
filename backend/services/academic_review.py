"""
学术规范审查引擎 (导师/审稿 Agent 核心规则)
============================================
对论文草稿执行静态规则检查, 供 SupervisorAgent 生成评审意见。

检查维度:
  1. 篇幅完整性 (字数 / 段落数)
  2. 引用格式 (GB/T 7714 文献类型标识 [J]/[C]/[M] 等)
  3. 引用编号连续性 ([1][2][3]... 是否存在跳号)
  4. 参考文献章节是否存在
  5. 引用编号与参考文献条数匹配

规则为启发式实现 (骨架阶段), 后续可接入 LLM 语义评审。
"""

import re
from typing import List, Optional, TypedDict


class ReviewIssue(TypedDict):
    """一条审查意见"""

    level: str   # error / warning / info
    message: str


class ReviewResult(TypedDict):
    """审查结果"""

    passed: bool
    issues: List[ReviewIssue]
    stats: dict


class AcademicReviewEngine:
    """学术规范静态检查引擎"""

    # GB/T 7714 常见文献类型标识
    DOC_TYPE_TAGS = ("[J]", "[C]", "[M]", "[D]", "[R]", "[S]", "[P]", "[EB/OL]")
    CITATION_RE = re.compile(r"\[(\d{1,3})\](?![0-9])")
    REF_SECTION_RE = re.compile(r"参考文献|References", re.IGNORECASE)

    @classmethod
    def review(cls, text: str) -> ReviewResult:
        """
        对草稿执行全部静态检查。

        Args:
            text: 待审查的论文草稿全文

        Returns:
            ReviewResult: {passed, issues, stats}
        """
        issues: List[ReviewIssue] = []
        stats = cls._collect_stats(text)

        # ---- 1. 篇幅完整性 ----
        if stats["chars"] < 100:
            issues.append(
                {"level": "error", "message": f"草稿篇幅过短 (仅 {stats['chars']} 字), 建议补充完整论证。"}
            )
        elif stats["chars"] < 300:
            issues.append(
                {"level": "warning", "message": f"草稿篇幅较短 ({stats['chars']} 字), 建议扩充方法/实验章节。"}
            )

        if stats["paragraphs"] < 3:
            issues.append(
                {"level": "warning", "message": f"仅 {stats['paragraphs']} 个段落, 建议按 引言/方法/结论 组织结构。"}
            )

        # ---- 2. 引用格式 (GB/T 7714 文献类型标识) ----
        if stats["has_citation"] and not stats["has_doc_type_tag"]:
            issues.append(
                {
                    "level": "warning",
                    "message": "存在引用编号但未标注文献类型标识 (如 [J]/[C]/[M]), "
                    "建议按 GB/T 7714 规范补充。",
                }
            )

        # ---- 3. 引用编号连续性 ----
        if stats["citation_numbers"]:
            numbers = stats["citation_numbers"]
            max_num = max(numbers)
            missing = [n for n in range(1, max_num + 1) if n not in numbers]
            if missing:
                issues.append(
                    {
                        "level": "error",
                        "message": f"引用编号不连续: 缺失 {missing} (最大编号 {max_num})。",
                    }
                )

        # ---- 4. 参考文献章节 ----
        if stats["has_citation"] and not stats["has_ref_section"]:
            issues.append(
                {"level": "error", "message": "正文存在引用但缺少『参考文献』章节。"}
            )
        elif stats["has_ref_section"] and not stats["has_citation"]:
            issues.append(
                {"level": "warning", "message": "存在参考文献章节但正文未标注引用编号。"}
            )

        # ---- 5. 引用与文献条数匹配 (粗略) ----
        if stats["has_ref_section"]:
            ref_lines = cls._count_ref_lines(text)
            cited_max = max(stats["citation_numbers"]) if stats["citation_numbers"] else 0
            if ref_lines > 0 and cited_max > ref_lines:
                issues.append(
                    {
                        "level": "warning",
                        "message": f"正文引用最大编号 [{cited_max}] 超过参考文献条数 ({ref_lines}), 请核对。",
                    }
                )

        passed = not any(i["level"] == "error" for i in issues)
        return {"passed": passed, "issues": issues, "stats": stats}

    # ------------------------------------------------------------------
    # 内部统计
    # ------------------------------------------------------------------
    @classmethod
    def _collect_stats(cls, text: str) -> dict:
        paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
        # 正文引用编号: 仅统计"参考文献"章节之前的部分,
        # 避免文献列表行首的 [n] 被误当作正文引用而掩盖跳号。
        body = text.split("参考文献", 1)[0].split("References", 1)[0]
        citation_nums = [int(m) for m in cls.CITATION_RE.findall(body)]
        return {
            "chars": len(text.replace(" ", "").replace("\n", "")),
            "paragraphs": len(paragraphs),
            "has_citation": bool(citation_nums),
            "citation_numbers": sorted(set(citation_nums)),
            "has_doc_type_tag": any(tag in text for tag in cls.DOC_TYPE_TAGS),
            "has_ref_section": bool(cls.REF_SECTION_RE.search(text)),
        }

    @staticmethod
    def _count_ref_lines(text: str) -> int:
        """粗略统计参考文献条目数 (以行首 [n] 或 '作者.' 开头的行计)"""
        count = 0
        for line in text.split("\n"):
            line = line.strip()
            if not line:
                continue
            if re.match(r"^\[\d{1,3}\]", line):
                count += 1
            elif re.match(r"^[A-Z][A-Za-z]+ [A-Za-z]+[^。]*\[[JCMDRS]\]", line):
                count += 1
        return count
