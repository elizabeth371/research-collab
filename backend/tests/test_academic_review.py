"""
学术规范审查引擎单元测试
=========================
覆盖: 不达标草稿 (篇幅不足/缺参考文献/引用跳号) 判为不通过,
规范草稿通过, 以及各规则独立触发。
"""

from services.academic_review import AcademicReviewEngine


def test_too_short_draft_fails():
    """篇幅过短的草稿必须有 error 级问题"""
    result = AcademicReviewEngine.review("太短了。")
    assert result["passed"] is False
    levels = [i["level"] for i in result["issues"]]
    assert "error" in levels


def test_missing_reference_section_fails():
    """正文有引用但无参考文献章节 -> 不通过"""
    draft = (
        "本文研究 AI 生成内容的溯源方案[1]。\n"
        "通过水印技术可追溯生成来源[2]。\n"
        "实验表明该方法有效[3]。\n"
    )
    result = AcademicReviewEngine.review(draft)
    assert result["passed"] is False
    messages = "；".join(i["message"] for i in result["issues"])
    assert "参考文献" in messages


def test_discontinuous_citations_fail():
    """引用编号跳号 ([1] 直接到 [3]) -> 不通过"""
    draft = (
        "水印方案由 Kirchenbauer 提出[1]。\n"
        "协同编辑依赖 CRDT 技术[3]。\n"
        "参考文献\n"
        "[1] Kirchenbauer J.A Watermark for Large Language Models[J].2023.\n"
        "[2] Jahns P.Yjs: Real-Time Collaboration[J].2021.\n"
        "[3] Wang L.Multi-Agent Systems: A Survey[J].2024.\n"
    )
    result = AcademicReviewEngine.review(draft)
    assert result["passed"] is False
    messages = "；".join(i["message"] for i in result["issues"])
    assert "不连续" in messages


def test_well_formed_draft_passes():
    """规范草稿 (引用连续 + 参考文献章节 + 类型标识) 通过"""
    draft = (
        "引言: AI 生成内容带来学术诚信风险[1], 水印技术提供可信溯源[2]。\n"
        "方法: 系统融合 CRDT 实时协同与绿名单水印方案[3]。\n"
        "结论: 实验验证了溯源链的防篡改能力[3]。\n"
        "参考文献\n"
        "[1] Liu X.On the Risks of LLM-Generated Content[J].2024.\n"
        "[2] Moreau L.Provenance for the Web[M].2013.\n"
        "[3] Kirchenbauer J.A Watermark for Large Language Models[J].2023.\n"
    )
    result = AcademicReviewEngine.review(draft)
    assert result["passed"] is True
    errors = [i for i in result["issues"] if i["level"] == "error"]
    assert errors == []


def test_citation_format_warning():
    """有引用但无 [J]/[C] 类型标识 -> warning (不阻断通过)"""
    draft = (
        "相关研究指出水印技术可追溯 AI 生成内容的来源[1], 是保障学术诚信的重要手段。"
        "该方法通过约束解码过程在文本中嵌入可检测标记, 无需修改模型参数即可实现溯源[1]。"
        "此外, CRDT 技术为多端实时协同编辑提供了收敛性保证, 两者结合构成完整方案[1]。\n"
        "参考文献\n"
        "[1] Kirchenbauer J.A Watermark for Large Language Models.2023.\n"
    )
    result = AcademicReviewEngine.review(draft)
    assert result["passed"] is True
    messages = "；".join(i["message"] for i in result["issues"])
    assert "类型标识" in messages


def test_stats_collected():
    """stats 包含字数/段落/引用编号等维度"""
    draft = "第一段引用[1]。\n第二段引用[1][2]。\n参考文献\n[1] A[J].2020.\n[2] B[J].2021.\n"
    result = AcademicReviewEngine.review(draft)
    s = result["stats"]
    assert s["chars"] > 0
    assert s["paragraphs"] >= 3
    assert s["citation_numbers"] == [1, 2]
    assert s["has_ref_section"] is True
