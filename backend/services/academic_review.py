"""
学术规范审查引擎 (导师/审稿 Agent 核心规则)
============================================
对论文草稿执行静态规则检查, 供 SupervisorAgent 与 /api/agents/review 使用。

红牌 / 黄牌分级 (对应审稿人"红牌警告"语义):
  - 红牌 (error):  必须修改的严重问题 (格式错误 / 结构缺失 / 篇幅无法成文)
  - 黄牌 (warning): 建议改进的质量问题 (论据不足 / 口语化 / 段落结构)
  - info:          提示性信息

接口:
  - review_document(text) -> 全文审查, 问题携带 para_index (1 起, 与编辑器
    顶层块顺序一致), 返回 red_cards / yellow_cards 计数
  - review(text)         -> 兼容包装 (供既有调用与单测使用, 不携带段落定位)

规则为启发式实现 (骨架阶段), 后续可接入 LLM 语义评审。
"""

import re
from typing import List, Optional, TypedDict


class ReviewIssue(TypedDict):
    """一条审查意见"""

    level: str                 # error=红牌 / warning=黄牌 / info
    message: str
    para_index: Optional[int]  # 问题所在段落 (1 起); 全文级问题为 None


class ReviewResult(TypedDict):
    """审查结果 (兼容结构)"""

    passed: bool
    issues: List[ReviewIssue]
    stats: dict


class ReviewDocumentResult(TypedDict):
    """全文审查结果 (红牌/黄牌分级 + 段落定位)"""

    passed: bool
    issues: List[ReviewIssue]
    red_cards: int
    yellow_cards: int
    stats: dict


class AcademicReviewEngine:
    """学术规范静态检查引擎"""

    # GB/T 7714 常见文献类型标识
    DOC_TYPE_TAGS = ("[J]", "[C]", "[M]", "[D]", "[R]", "[S]", "[P]", "[EB/OL]")
    CITATION_RE = re.compile(r"\[(\d{1,3})\](?![0-9])")
    REF_SECTION_RE = re.compile(r"参考文献|References", re.IGNORECASE)

    # 疑似断言词: 句段中出现且段内无引用编号 -> 黄牌 (论据不足)
    ASSERTION_WORDS = (
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

    # 口语化词表: 单段命中 >= 2 处 -> 黄牌 (建议学术化改写)
    COLLOQUIAL_WORDS = (
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
    )

    # 段落过长阈值 (字)
    LONG_PARA_CHARS = 400

    @classmethod
    def review(cls, text: str) -> ReviewResult:
        """
        对草稿执行静态检查 (兼容入口, 无段落定位)。

        Args:
            text: 待审查的论文草稿全文

        Returns:
            ReviewResult: {passed, issues, stats}
        """
        doc = cls.review_document(text)
        return {
            "passed": doc["passed"],
            "issues": [{"level": i["level"], "message": i["message"]} for i in doc["issues"]],
            "stats": doc["stats"],
        }

    # ------------------------------------------------------------------
    # 全文审查 (红牌/黄牌 + 段落定位)
    # ------------------------------------------------------------------
    @classmethod
    def review_document(cls, text: str) -> ReviewDocumentResult:
        """
        对草稿全文执行检查, 问题携带 para_index (1 起)。

        - 全文级规则: 篇幅 / 引用编号连续性 / 参考文献章节 / 匹配核对
        - 段落级规则: 断言无引用支撑 / 口语化密度 / 段落过长

        Returns:
            ReviewDocumentResult: {passed, issues, red_cards, yellow_cards, stats}
        """
        issues: List[ReviewIssue] = []
        stats = cls._collect_stats(text)

        if stats["chars"] == 0:
            issues.append(
                {"level": "error", "message": "文档内容为空, 无法评审。", "para_index": None}
            )
        else:
            cls._check_whole_doc(issues, stats, text)
            cls._check_paragraphs(issues, text)

        red_cards = sum(1 for i in issues if i["level"] == "error")
        yellow_cards = sum(1 for i in issues if i["level"] == "warning")
        passed = red_cards == 0
        return {
            "passed": passed,
            "issues": issues,
            "red_cards": red_cards,
            "yellow_cards": yellow_cards,
            "stats": stats,
        }

    # ------------------------------------------------------------------
    # 全文级检查
    # ------------------------------------------------------------------
    @classmethod
    def _check_whole_doc(cls, issues: List[ReviewIssue], stats: dict, text: str) -> None:
        """篇幅 / 引用格式与连续性 / 参考文献章节 / 引用与文献条数匹配"""
        # ---- 篇幅完整性 ----
        if stats["chars"] < 100:
            issues.append(
                {
                    "level": "error",
                    "message": f"草稿篇幅过短 (仅 {stats['chars']} 字), 尚不足一篇成文, 请补充完整论证。",
                    "para_index": None,
                }
            )
        elif stats["chars"] < 300:
            issues.append(
                {
                    "level": "warning",
                    "message": f"草稿篇幅较短 ({stats['chars']} 字), 建议扩充方法/实验章节。",
                    "para_index": None,
                }
            )

        if stats["paragraphs"] < 3:
            issues.append(
                {
                    "level": "warning",
                    "message": f"仅 {stats['paragraphs']} 个段落, 建议按 引言/方法/结论 组织结构。",
                    "para_index": None,
                }
            )

        # ---- 引用格式 (GB/T 7714 文献类型标识) ----
        if stats["has_citation"] and not stats["has_doc_type_tag"]:
            issues.append(
                {
                    "level": "warning",
                    "message": "存在引用编号但未标注文献类型标识 (如 [J]/[C]/[M]), 建议按 GB/T 7714 规范补充。",
                    "para_index": None,
                }
            )

        # ---- 引用编号连续性 ----
        if stats["citation_numbers"]:
            numbers = stats["citation_numbers"]
            max_num = max(numbers)
            missing = [n for n in range(1, max_num + 1) if n not in numbers]
            if missing:
                issues.append(
                    {
                        "level": "error",
                        "message": f"引用编号不连续: 缺失 {missing} (最大编号 {max_num})。",
                        "para_index": None,
                    }
                )

        # ---- 参考文献章节 ----
        if stats["has_citation"] and not stats["has_ref_section"]:
            issues.append(
                {"level": "error", "message": "正文存在引用但缺少『参考文献』章节。", "para_index": None}
            )
        elif stats["has_ref_section"] and not stats["has_citation"]:
            issues.append(
                {"level": "warning", "message": "存在参考文献章节但正文未标注引用编号。", "para_index": None}
            )

        # ---- 引用与文献条数匹配 (粗略) ----
        if stats["has_ref_section"]:
            ref_lines = cls._count_ref_lines(text)
            cited_max = max(stats["citation_numbers"]) if stats["citation_numbers"] else 0
            if ref_lines > 0 and cited_max > ref_lines:
                issues.append(
                    {
                        "level": "warning",
                        "message": f"正文引用最大编号 [{cited_max}] 超过参考文献条数 ({ref_lines}), 请核对。",
                        "para_index": None,
                    }
                )

    # ------------------------------------------------------------------
    # 段落级检查 (黄牌: 断言无引用 / 口语化 / 段落过长)
    # ------------------------------------------------------------------
    @classmethod
    def _check_paragraphs(cls, issues: List[ReviewIssue], text: str) -> None:
        """按段落 (空行分隔, 1 起) 检查论据支撑与表达质量"""
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        for idx, para in enumerate(paragraphs, start=1):
            # 标题行 (markdown #) 不参与段落级检查
            if para.startswith("#"):
                continue

            # ---- 断言无引用支撑 ----
            if any(w in para for w in cls.ASSERTION_WORDS):
                para_nums = [int(m) for m in cls.CITATION_RE.findall(para)]
                if not para_nums:
                    issues.append(
                        {
                            "level": "warning",
                            "message": "段落包含结论性断言 (如『表明/证明/验证了』) 但该段无引用支撑, 建议补充文献论据。",
                            "para_index": idx,
                        }
                    )

            # ---- 口语化密度 ----
            colloquial_hits = sum(para.count(w) for w in cls.COLLOQUIAL_WORDS)
            if colloquial_hits >= 2:
                issues.append(
                    {
                        "level": "warning",
                        "message": f"段落存在 {colloquial_hits} 处口语化表达, 建议使用学术措辞改写 (可选中文字交给写稿人润色)。",
                        "para_index": idx,
                    }
                )

            # ---- 段落过长 ----
            para_chars = len(para.replace(" ", ""))
            if para_chars > cls.LONG_PARA_CHARS:
                issues.append(
                    {
                        "level": "warning",
                        "message": f"段落过长 ({para_chars} 字), 建议按论点拆分以提升可读性。",
                        "para_index": idx,
                    }
                )

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
