"""
版权证据包生成服务 (步骤 13)
================================
把文档的完整版权证据链打包为可存档 / 可提交评审的审计产物:

  1. 文档元信息 + 全文快照
  2. 每文档水印参数 (γ / δ) 与密钥指纹 (密钥 hex 完整保留, 供离线复现检测)
  3. 全部水印检测历史记录
  4. 完整溯源链操作日志 + 哈希链完整性校验结果
  5. 导出时刻的实时水印检测 (仅作为导出时点的观察, 不落库)

支持 Markdown / PDF / JSON 三种格式, 均附带 package_hash:
对去除 package_hash 字段后的规范化 JSON 计算 SHA-256,
接收方可离线重算以校验证据包在传输/存档过程中未被篡改。
"""

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from config import settings

# ---------------------------------------------------------------------------
# package_hash: 规范化 JSON -> SHA-256
# ---------------------------------------------------------------------------
def _canonical_json(data: dict) -> str:
    """去除 package_hash 字段后的规范化 JSON (键排序, 紧凑分隔, 保留 UTF-8)"""
    core = {k: v for k, v in data.items() if k != "package_hash"}
    return json.dumps(core, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def compute_package_hash(data: dict) -> str:
    """计算证据包完整性哈希 (SHA-256 hex)"""
    return hashlib.sha256(_canonical_json(data).encode("utf-8")).hexdigest()


def verify_package_hash(data: dict) -> bool:
    """离线校验: 重算 package_hash 并与包内记录比对"""
    return compute_package_hash(data) == data.get("package_hash")


# ---------------------------------------------------------------------------
# 证据包数据组装
# ---------------------------------------------------------------------------
def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _record_out(r) -> dict:
    """水印检测历史记录 -> 可序列化字典 (token_seq 容错)"""
    token_seq = {}
    try:
        token_seq = r.token_seq or {}
    except Exception:
        token_seq = {}
    if not isinstance(token_seq, dict):
        token_seq = {}
    return {
        "id": str(r.id),
        "model_name": r.model_name,
        "gamma": r.gamma,
        "delta": r.delta,
        "detected": bool(token_seq.get("detected")) if token_seq.get("detected") is not None else None,
        "watermark_chars": token_seq.get("watermark_chars"),
        "created_at": _iso(r.created_at),
    }


def _log_out(l) -> dict:
    """溯源链日志 -> 可序列化字典 (operation 容错)"""
    op = l.operation
    if not isinstance(op, dict):
        op = {}
    return {
        "id": str(l.id),
        "op_type": l.op_type,
        "operation": op,
        "prev_hash": l.prev_hash,
        "current_hash": l.current_hash,
        "created_at": _iso(l.created_at),
    }


def build_evidence_data(
    doc,
    records: List,
    logs: List,
    chain_verify: dict,
    live_detect: dict,
    exported_at: Optional[datetime] = None,
) -> dict:
    """
    组装证据包数据字典 (各格式渲染的公共数据源)。
    doc/records/logs 为 SQLAlchemy ORM 对象; chain_verify 为溯源链校验结果;
    live_detect 为导出时刻实时检测结果字典。
    """
    exported_at = exported_at or datetime.now(timezone.utc)
    key = doc.watermark_key or settings.WATERMARK_SECRET_KEY

    data: Dict[str, Any] = {
        "package": {
            "name": "research-collab-copyright-evidence",
            "version": 1,
            "exported_at": exported_at.isoformat(),
            "note": "package_hash 为去除该字段后规范化 JSON 的 SHA-256, 可离线重算校验完整性",
        },
        "document": {
            "id": str(doc.id),
            "title": doc.title,
            "created_at": _iso(doc.created_at),
            "updated_at": _iso(doc.updated_at),
            "content_length": len(doc.content or ""),
            "content": doc.content or "",
        },
        "watermark_params": {
            "gamma": doc.watermark_gamma,
            "delta": doc.watermark_delta,
            "key_fingerprint": hashlib.sha256(key).hexdigest()[:16],
            "secret_key_hex": key.hex(),
        },
        "detect_records": [_record_out(r) for r in records],
        "provenance": {
            "log_count": len(logs),
            "chain_valid": {
                "valid": bool(chain_verify.get("valid", False)),
                "checked": chain_verify.get("checked", 0),
            },
            "logs": [_log_out(l) for l in logs],
        },
        "live_detect": dict(live_detect),
    }
    data["package_hash"] = compute_package_hash(data)
    return data


# ---------------------------------------------------------------------------
# 操作摘要 (供表格/日志展示)
# ---------------------------------------------------------------------------
def _op_summary(op: dict) -> str:
    if not isinstance(op, dict) or not op:
        return ""
    action = op.get("action") or ""
    summaries = {
        "insert": f"插入 {op.get('chars_added', '?')} 字符",
        "delete": f"删除 {op.get('chars_removed', '?')} 字符",
        "replace": "替换内容",
        "ai_generate": "AI 生成水印内容",
        "watermark_checked": (
            f"水印检测: {'AI 生成' if op.get('is_ai_generated') else '人类创作'} "
            f"(置信度 {op.get('confidence', '?')})"
        ),
        "watermark_params": (
            f"更新水印参数/密钥: γ={op.get('gamma', '?')} δ={op.get('delta', '?')} "
            f"指纹={str(op.get('key_fingerprint', ''))[:16]}"
        ),
    }
    if action in summaries:
        return summaries[action]
    text = json.dumps(op, ensure_ascii=False)
    return text[:120]


# ---------------------------------------------------------------------------
# Markdown 渲染
# ---------------------------------------------------------------------------
def render_markdown(data: dict) -> str:
    d = data["document"]
    p = data["watermark_params"]
    pk = data["package"]
    lines = [
        f"# 版权证据包 · {d['title']}",
        "",
        "> 智溯 · 多智能体科研协同编辑与版权溯源系统 — 自动生成的版权证据文件",
        "",
        "## 一、文档信息",
        "",
        f"- **文档 ID**: `{d['id']}`",
        f"- **文档标题**: {d['title']}",
        f"- **创建时间**: {d['created_at']}",
        f"- **最后更新**: {d['updated_at']}",
        f"- **全文长度**: {d['content_length']} 字符",
        "",
        "## 二、文档水印参数 (每文档独立密钥)",
        "",
        f"- **绿名单比例 γ**: {p['gamma']}",
        f"- **注入强度 δ**: {p['delta']}",
        f"- **密钥指纹**: `{p['key_fingerprint']}`",
        f"- **独立密钥 (hex)**: `{p['secret_key_hex']}`",
        "",
        "## 三、水印检测历史记录",
        "",
    ]
    if data["detect_records"]:
        lines.append("| 时间 | 模型 | γ | δ | 检出 | 水印字符 |")
        lines.append("|---|---|---|---|---|---|")
        for r in data["detect_records"]:
            lines.append(
                f"| {r['created_at']} | {r['model_name']} | {r['gamma']} | {r['delta']} "
                f"| {'是' if r['detected'] else '否'} | {r['watermark_chars']} |"
            )
    else:
        lines.append("_暂无检测记录。_")
    lines += [
        "",
        "## 四、溯源链 (操作日志)",
        "",
    ]
    logs = data["provenance"]["logs"]
    if logs:
        lines.append("| # | 时间 | 操作类型 | 操作摘要 | 当前哈希 |")
        lines.append("|---|---|---|---|---|")
        for i, l in enumerate(logs, 1):
            lines.append(
                f"| {i} | {l['created_at']} | {l['op_type']} | {_op_summary(l['operation'])} "
                f"| `{l['current_hash'][:16]}...` |"
            )
    else:
        lines.append("_该文档尚无溯源链日志。_")
    cv = data["provenance"]["chain_valid"]
    lines += [
        "",
        "## 五、哈希链完整性校验",
        "",
        f"- **校验结果**: {'✅ 通过' if cv['valid'] else '❌ 失败'}",
        f"- **校验日志数**: {cv['checked']} / {data['provenance']['log_count']}",
        "",
        "## 六、导出时刻实时水印检测",
        "",
        f"- **判定**: {'AI 生成 (含水印)' if data['live_detect']['is_ai_generated'] else '人类创作 (未检出)'}",
        f"- **置信度**: {data['live_detect']['confidence']}",
        f"- **z 统计量**: {data['live_detect']['z_score']} (阈值 4.0)",
        f"- **绿名单命中**: {data['live_detect']['green_fraction']}",
        f"- **评分字符对数**: {data['live_detect']['num_tokens_scored']}",
        "",
        "## 七、文档全文快照",
        "",
        "```text",
        d["content"] or "(空文档)",
        "```",
        "",
        "## 八、证据包完整性",
        "",
        f"- **导出时间**: {pk['exported_at']}",
        f"- **package_hash (SHA-256)**: `{data['package_hash']}`",
        "- **校验方式**: 对去除 `package_hash` 字段后的规范化 JSON (键排序、紧凑分隔、UTF-8) 计算 SHA-256，应与此哈希一致。",
        "",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# PDF 渲染 (reportlab + 系统黑体)
# ---------------------------------------------------------------------------
_FONT = "SimHei"


def _font_paths() -> List[str]:
    """候选中文字体路径: 优先仓库内置字体 (Docker 可移植), 其次 Windows 系统字体"""
    repo_font = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "fonts",
        "simhei.ttf",
    )
    return [repo_font, "C:/Windows/Fonts/simhei.ttf"]


def _ensure_fonts() -> None:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    if _FONT in pdfmetrics.getRegisteredFontNames():
        return
    for path in _font_paths():
        if os.path.exists(path):
            pdfmetrics.registerFont(TTFont(_FONT, path))
            pdfmetrics.registerFontFamily(
                _FONT,
                normal=_FONT,
                bold=_FONT,
                italic=_FONT,
                boldItalic=_FONT,
            )
            return
    raise RuntimeError(
        "未找到中文字体 simhei.ttf (请检查 backend/fonts/simhei.ttf 或系统字体)"
    )


def render_pdf(data: dict) -> bytes:
    """渲染 PDF 证据包 (A4, 系统黑体, 页脚页码)"""
    from io import BytesIO

    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    _ensure_fonts()
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title=f"版权证据包 · {data['document']['title']}",
        author="智溯 · Research Collab",
    )

    title_style = ParagraphStyle(
        "EvTitle", fontName=_FONT, fontSize=16, leading=22,
        alignment=TA_CENTER, spaceAfter=6,
    )
    subtitle_style = ParagraphStyle(
        "EvSub", fontName=_FONT, fontSize=9, leading=13,
        alignment=TA_CENTER, textColor=colors.HexColor("#666666"), spaceAfter=12,
    )
    h2_style = ParagraphStyle(
        "EvH2", fontName=_FONT, fontSize=12, leading=16,
        spaceBefore=14, spaceAfter=6, textColor=colors.HexColor("#1f2937"),
    )
    body_style = ParagraphStyle(
        "EvBody", fontName=_FONT, fontSize=9, leading=14, spaceAfter=4,
    )
    mono_style = ParagraphStyle(
        "EvMono", fontName=_FONT, fontSize=7.5, leading=11,
        textColor=colors.HexColor("#374151"), backColor=colors.HexColor("#f3f4f6"),
        borderPadding=4, borderColor=colors.HexColor("#e5e7eb"), borderWidth=0.5,
    )
    cell_style = ParagraphStyle(
        "EvCell", fontName=_FONT, fontSize=7.5, leading=10,
    )

    def _footer(canvas, _doc):
        canvas.saveState()
        canvas.setFont(_FONT, 7.5)
        canvas.setFillColor(colors.HexColor("#999999"))
        canvas.drawCentredString(
            A4[0] / 2, 9 * mm,
            f"智溯 · 版权证据包 · {data['package']['exported_at']} — 第 {_doc.page} 页",
        )
        canvas.restoreState()

    d = data["document"]
    p = data["watermark_params"]
    story = [
        Paragraph(f"版权证据包 · {d['title']}", title_style),
        Paragraph(
            "智溯 · 多智能体科研协同编辑与版权溯源系统 — 自动生成的版权证据文件",
            subtitle_style,
        ),
    ]

    def _h2(text):
        story.append(Paragraph(text, h2_style))

    def _kv_table(rows):
        t = Table(
            [[Paragraph(k, cell_style), Paragraph(str(v), cell_style)] for k, v in rows],
            colWidths=[46 * mm, 128 * mm],
        )
        t.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), _FONT),
            ("FONTSIZE", (0, 0), (-1, -1), 7.5),
            ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f0fdf4")),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d1d5db")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 2.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ]))
        return t

    # 一、文档信息
    _h2("一、文档信息")
    story.append(_kv_table([
        ("文档 ID", d["id"]),
        ("文档标题", d["title"]),
        ("创建时间", d["created_at"] or ""),
        ("最后更新", d["updated_at"] or ""),
        ("全文长度", f"{d['content_length']} 字符"),
    ]))

    # 二、水印参数
    _h2("二、文档水印参数 (每文档独立密钥)")
    story.append(_kv_table([
        ("绿名单比例 γ", p["gamma"]),
        ("注入强度 δ", p["delta"]),
        ("密钥指纹", p["key_fingerprint"]),
        ("独立密钥 (hex)", p["secret_key_hex"]),
    ]))

    # 三、检测历史
    _h2("三、水印检测历史记录")
    if data["detect_records"]:
        header = ["时间", "模型", "γ", "δ", "检出", "水印字符"]
        rows = [[Paragraph(h, cell_style) for h in header]]
        for r in data["detect_records"]:
            rows.append([
                Paragraph(str(r["created_at"]), cell_style),
                Paragraph(r["model_name"], cell_style),
                Paragraph(str(r["gamma"]), cell_style),
                Paragraph(str(r["delta"]), cell_style),
                Paragraph("是" if r["detected"] else "否", cell_style),
                Paragraph(str(r["watermark_chars"]), cell_style),
            ])
        t = Table(rows, colWidths=[44 * mm, 30 * mm, 16 * mm, 16 * mm, 16 * mm, 28 * mm])
        t.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), _FONT),
            ("FONTSIZE", (0, 0), (-1, -1), 7.5),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#065f46")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d1d5db")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f0fdf4")]),
            ("TOPPADDING", (0, 0), (-1, -1), 2.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ]))
        story.append(t)
    else:
        story.append(Paragraph("暂无检测记录。", body_style))

    # 四、溯源链
    _h2("四、溯源链 (操作日志)")
    logs = data["provenance"]["logs"]
    if logs:
        header = ["#", "时间", "操作类型", "操作摘要", "当前哈希"]
        rows = [[Paragraph(h, cell_style) for h in header]]
        for i, l in enumerate(logs, 1):
            rows.append([
                Paragraph(str(i), cell_style),
                Paragraph(str(l["created_at"]), cell_style),
                Paragraph(l["op_type"], cell_style),
                Paragraph(_op_summary(l["operation"]), cell_style),
                Paragraph(f"{l['current_hash'][:16]}…", cell_style),
            ])
        t = Table(rows, colWidths=[9 * mm, 38 * mm, 30 * mm, 66 * mm, 31 * mm])
        t.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), _FONT),
            ("FONTSIZE", (0, 0), (-1, -1), 7),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#065f46")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d1d5db")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f0fdf4")]),
            ("TOPPADDING", (0, 0), (-1, -1), 2.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ]))
        story.append(t)
    else:
        story.append(Paragraph("该文档尚无溯源链日志。", body_style))
    cv = data["provenance"]["chain_valid"]
    _h2("五、哈希链完整性校验")
    story.append(_kv_table([
        ("校验结果", "✅ 通过" if cv["valid"] else "❌ 失败"),
        ("校验日志数", f"{cv['checked']} / {data['provenance']['log_count']}"),
    ]))

    # 六、实时检测
    ld = data["live_detect"]
    _h2("六、导出时刻实时水印检测")
    story.append(_kv_table([
        ("判定", "AI 生成 (含水印)" if ld["is_ai_generated"] else "人类创作 (未检出)"),
        ("置信度", ld["confidence"]),
        ("z 统计量", f"{ld['z_score']} (阈值 4.0)"),
        ("绿名单命中", ld["green_fraction"]),
        ("评分字符对数", ld["num_tokens_scored"]),
    ]))

    # 七、全文快照
    _h2("七、文档全文快照")
    story.append(Paragraph((d["content"] or "(空文档)"), mono_style))

    # 八、完整性
    _h2("八、证据包完整性")
    story.append(_kv_table([
        ("导出时间", data["package"]["exported_at"]),
        ("package_hash (SHA-256)", data["package_hash"]),
    ]))
    story.append(Paragraph(
        "校验方式: 对去除 package_hash 字段后的规范化 JSON (键排序、紧凑分隔、UTF-8) 计算 SHA-256，应与此哈希一致。",
        body_style,
    ))

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buf.getvalue()
