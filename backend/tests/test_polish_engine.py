"""
写稿人润色引擎单元测试
=======================
覆盖: 措辞升级 / 冗余清理 / 标点归一 / 学术句式 / 无变化 no-op / 统计字段。
"""

from services.polish_engine import PolishEngine


def test_phrase_upgrade():
    """口语化措辞升级为学术表达"""
    result = PolishEngine.polish_text("本文研究了很多方法。")
    assert result["polished"] == "本文研究了大量方法。"


def test_longer_phrase_priority():
    """长短语优先替换, 避免 '非常' 吃掉 '非常不错' 的 '非常'"""
    result = PolishEngine.polish_text("这个方法非常不错。")
    assert "效果良好" in result["polished"]


def test_we_first_person_upgrade():
    """第一人称口语化 -> 本研究/本文"""
    result = PolishEngine.polish_text("我们做了实验。")
    assert result["polished"].startswith("本研究开展了实验")


def test_redundancy_removal():
    """形式动词 '进行了' -> '开展了' (删除会破坏动宾结构, 故仅升级)"""
    result = PolishEngine.polish_text("我们进行了实验。")
    assert "进行了" not in result["polished"]
    assert "开展了" in result["polished"]


def test_punctuation_normalization():
    """半角标点转全角 + 省略号统一"""
    result = PolishEngine.polish_text("本文研究了A,B与C...")
    assert "，" in result["polished"]
    assert "……" in result["polished"]
    assert "," not in result["polished"]


def test_sentence_pattern():
    """惯用句式 -> 规范学术句式"""
    result = PolishEngine.polish_text("本文的目标是研究水印算法。")
    assert "本文旨在" in result["polished"]


def test_clean_text_noop():
    """已符合学术规范的文本无需润色 (changes 为空)"""
    text = "本研究提出了一种基于深度学习的文本水印方案，实现了对生成内容的可信溯源。"
    result = PolishEngine.polish_text(text)
    assert result["polished"] == text
    assert result["changes"] == []
    assert result["stats"]["change_count"] == 0


def test_empty_input_noop():
    """空文本原样返回"""
    result = PolishEngine.polish_text("   ")
    assert result["polished"] == "   "
    assert result["changes"] == []


def test_changes_recorded_with_types():
    """变更清单带 type/before/after, 统计字数变化"""
    result = PolishEngine.polish_text("我们研究了很多方法。")
    assert len(result["changes"]) >= 2  # 我们 -> 本文 / 很多 -> 大量
    types = {c["type"] for c in result["changes"]}
    assert "phrasing" in types
    assert result["stats"]["change_count"] == len(result["changes"])
    assert result["stats"]["chars_before"] > 0


def test_single_char_no_false_hit():
    """单字替换已禁用: 不得误伤 '思想/能力' 等词"""
    result = PolishEngine.polish_text("该思想体现了系统的能力。")
    assert "思想" in result["polished"]
    assert "能力" in result["polished"]
