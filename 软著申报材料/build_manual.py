# -*- coding: utf-8 -*-
"""
将 docs/软件说明书.md 渲染为软著申报所需的「软件说明书」PDF。
支持：标题、段落、表格、代码块、加粗、项目符号、引用、分隔线。
A4、带页眉页脚与连续页码。
"""
import os, re

ROOT = r"E:\大创\research-collab"
SRC = os.path.join(ROOT, "软著申报材料", "软件说明书_申报版.md")
OUT = os.path.join(ROOT, "软著申报材料", "软件说明书_智溯.pdf")

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, Preformatted, PageBreak)
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER

pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
FONT = "STSong-Light"

styles = {
    "h1": ParagraphStyle("h1", fontName=FONT, fontSize=19, leading=27,
                         spaceBefore=8, spaceAfter=12, alignment=TA_CENTER),
    "h2": ParagraphStyle("h2", fontName=FONT, fontSize=14.5, leading=21,
                         spaceBefore=14, spaceAfter=7),
    "h3": ParagraphStyle("h3", fontName=FONT, fontSize=12, leading=18,
                         spaceBefore=9, spaceAfter=5),
    "body": ParagraphStyle("body", fontName=FONT, fontSize=10.5, leading=17,
                           spaceAfter=6, alignment=TA_LEFT),
    "bullet": ParagraphStyle("bullet", fontName=FONT, fontSize=10.5, leading=17,
                             leftIndent=16, spaceAfter=3),
    "quote": ParagraphStyle("quote", fontName=FONT, fontSize=10, leading=16,
                            leftIndent=18, textColor=colors.HexColor("#555555"),
                            spaceAfter=6),
    "cell": ParagraphStyle("cell", fontName=FONT, fontSize=9.5, leading=13.5),
    "cellh": ParagraphStyle("cellh", fontName=FONT, fontSize=9.5, leading=13.5,
                            textColor=colors.white),
}

def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def inline(t):
    t = esc(t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"`(.+?)`", r'<font face="STSong-Light">\1</font>', t)
    return t

def parse(md):
    lines = md.split("\n")
    blocks = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        # 分隔线
        if re.match(r"^-{3,}\s*$", line.strip()):
            blocks.append(("hr", None)); i += 1; continue
        # 代码块
        if line.strip().startswith("```"):
            i += 1
            code = []
            while i < n and not lines[i].strip().startswith("```"):
                code.append(lines[i]); i += 1
            i += 1
            blocks.append(("code", "\n".join(code))); continue
        # 标题
        m = re.match(r"^(#{1,3})\s+(.*)$", line)
        if m:
            lv = len(m.group(1)); blocks.append(("h", (lv, m.group(2)))); i += 1; continue
        # 表格
        if line.strip().startswith("|") and i + 1 < n and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i+1]):
            rows = []
            # 表头
            hdr = [c.strip() for c in line.strip().strip("|").split("|")]
            rows.append(hdr)
            i += 2  # 跳过表头与分隔行
            while i < n and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            blocks.append(("table", rows)); continue
        # 引用
        if line.strip().startswith(">"):
            quote = []
            while i < n and lines[i].strip().startswith(">"):
                quote.append(lines[i].strip().lstrip(">").strip()); i += 1
            blocks.append(("quote", " ".join(quote))); continue
        # 项目符号
        if re.match(r"^\s*[-*]\s+", line):
            blocks.append(("bullet", re.sub(r"^\s*[-*]\s+", "", line))); i += 1; continue
        # 空行
        if line.strip() == "":
            i += 1; continue
        # 普通段落（合并连续非空非特殊行）
        para = []
        while (i < n and lines[i].strip() != ""
               and not lines[i].strip().startswith(("```", "#", "|", ">", "-", "*"))
               and not re.match(r"^-{3,}\s*$", lines[i].strip())):
            para.append(lines[i]); i += 1
        blocks.append(("p", " ".join(para)))
    return blocks

def build():
    with open(SRC, "r", encoding="utf-8") as fh:
        md = fh.read()
    blocks = parse(md)
    doc = BaseDocTemplate(OUT, pagesize=A4,
                          leftMargin=20*mm, rightMargin=18*mm,
                          topMargin=16*mm, bottomMargin=16*mm,
                          title="软件说明书 - 智溯 多智能体科研协同编辑与版权溯源系统 V1.0",
                          author="长安大学 大创项目组")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    doc.addPageTemplates([PageTemplate(id="man", frames=[frame], onPage=_deco)])

    flow = []
    for kind, val in blocks:
        if kind == "h":
            lv, text = val
            st = styles["h1"] if lv == 1 else (styles["h2"] if lv == 2 else styles["h3"])
            flow.append(Paragraph(inline(text), st))
            if lv == 1:
                flow.append(Spacer(1, 2))
        elif kind == "p":
            flow.append(Paragraph(inline(val), styles["body"]))
        elif kind == "bullet":
            flow.append(Paragraph("• " + inline(val), styles["bullet"]))
        elif kind == "quote":
            flow.append(Paragraph(inline(val), styles["quote"]))
        elif kind == "code":
            flow.append(Preformatted(val, ParagraphStyle(
                "code", fontName=FONT, fontSize=8.5, leading=12,
                backColor=colors.HexColor("#f4f4f4"), borderPadding=4)))
            flow.append(Spacer(1, 4))
        elif kind == "hr":
            flow.append(Spacer(1, 4))
            flow.append(Table([[""]], colWidths=[doc.width],
                              style=TableStyle([("LINEABOVE",(0,0),(-1,-1),
                                                0.5, colors.grey)])))
            flow.append(Spacer(1, 4))
        elif kind == "table":
            rows = val
            data = []
            for r, row in enumerate(rows):
                cells = []
                for c in row:
                    cells.append(Paragraph(inline(c), styles["cellh"] if r == 0 else styles["cell"]))
                data.append(cells)
            t = Table(data, repeatRows=1)
            t.setStyle(TableStyle([
                ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#2f5496")),
                ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#999999")),
                ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
                ("LEFTPADDING", (0,0), (-1,-1), 4),
                ("RIGHTPADDING", (0,0), (-1,-1), 4),
                ("TOPPADDING", (0,0), (-1,-1), 3),
                ("BOTTOMPADDING", (0,0), (-1,-1), 3),
                ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#eef1f7")]),
            ]))
            flow.append(t)
            flow.append(Spacer(1, 6))
    doc.build(flow)

def _deco(canvas, doc):
    canvas.saveState()
    w, h = A4
    canvas.setFont(FONT, 8)
    canvas.setFillColorRGB(0.4, 0.4, 0.4)
    canvas.drawString(20*mm, h - 10*mm,
                      "软件说明书  ·  智溯 多智能体科研协同编辑与版权溯源系统 V1.0")
    canvas.drawRightString(w - 18*mm, h - 10*mm, "第 %d 页" % doc.page)
    canvas.setStrokeColorRGB(0.7, 0.7, 0.7)
    canvas.line(20*mm, h - 11.5*mm, w - 18*mm, h - 11.5*mm)
    canvas.drawCentredString(w/2, 9*mm, "软件著作权登记 · 软件说明书")
    canvas.restoreState()

if __name__ == "__main__":
    build()
    print("生成文件:", OUT)
