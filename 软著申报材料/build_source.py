# -*- coding: utf-8 -*-
"""
生成软著申报所需的「源程序」PDF：
- 收集后端 Python、前端 TS/TSX、共享 TS 源码
- 按顺序拼接为连续源代码
- 总代码量 > 3000 行时，按规则提交前 30 页 + 后 30 页（每页 50 行）
- A4 单栏、带行号与连续页码
"""
import os, glob

ROOT = r"E:\大创\research-collab"
OUT = os.path.join(ROOT, "软著申报材料", "源程序_智溯.pdf")

# ---- 1. 收集源码文件（固定顺序，保证前 30 页为后端核心逻辑） ----
def gather():
    files = []
    backend_order = [
        "backend/config.py", "backend/database.py", "backend/models.py", "backend/main.py",
    ]
    for f in backend_order:
        p = os.path.join(ROOT, f)
        if os.path.exists(p):
            files.append(p)
    for f in sorted(glob.glob(os.path.join(ROOT, "backend", "api", "*.py"))):
        files.append(f)
    for f in sorted(glob.glob(os.path.join(ROOT, "backend", "services", "*.py"))):
        files.append(f)
    for f in sorted(glob.glob(os.path.join(ROOT, "backend", "websocket", "*.py"))):
        files.append(f)
    for f in sorted(glob.glob(os.path.join(ROOT, "backend", "tests", "*.py"))):
        files.append(f)
    for f in sorted(glob.glob(os.path.join(ROOT, "frontend", "src", "**", "*.ts*"), recursive=True)):
        files.append(f)
    p_shared = os.path.join(ROOT, "shared", "types.ts")
    if os.path.exists(p_shared):
        files.append(p_shared)
    return files

# ---- 2. 拼接为带文件头的连续行 ----
def flatten(files):
    lines = []
    for path in files:
        rel = os.path.relpath(path, ROOT)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                content = fh.read().split("\n")
        except Exception:
            content = []
        # 文件分隔头（计入行号，便于审查定位）
        lines.append("# " + "=" * 60)
        lines.append("# FILE: " + rel)
        lines.append("# " + "=" * 60)
        for ln in content:
            lines.append(ln.rstrip("\r"))
    return lines

# ---- 3. 选取前 30 页 + 后 30 页（每页 50 行 -> 3000 行） ----
def select(lines, per_page=50, pages=30):
    total = len(lines)
    need = per_page * pages * 2  # 前 + 后
    if total <= need:
        return lines, total
    head = lines[: per_page * pages]
    tail = lines[total - per_page * pages :]
    return head + tail, total

# ---- 4. 渲染 PDF ----
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import BaseDocTemplate, PageTemplate, Frame, Paragraph, PageBreak
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT

pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
FONT = "STSong-Light"

LINES_PER_PAGE = 50
FONT_SIZE = 7.6
LEADING = 10.6

def build(selected, total_all):
    doc = BaseDocTemplate(
        OUT, pagesize=A4,
        leftMargin=18 * mm, rightMargin=14 * mm,
        topMargin=14 * mm, bottomMargin=14 * mm,
        title="源程序 - 智溯 多智能体科研协同编辑与版权溯源系统 V1.0.0",
        author="长安大学 大创项目组",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin,
                  doc.width, doc.height, id="main")
    doc.addPageTemplates([PageTemplate(id="src", frames=[frame],
                                        onPage=_decorate)])

    style = ParagraphStyle("code", fontName=FONT, fontSize=FONT_SIZE,
                           leading=LEADING, wordWrap="CJK", alignment=TA_LEFT)

    # 行号 + 内容，<br/> 换行；长行自动折行（折行后仍算一行，满足“每页不少于50行”）
    parts = []
    for i, ln in enumerate(selected, 1):
        safe = (ln.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        parts.append(f'<font color="#888888">{i:04d}</font>&nbsp;&nbsp;{safe}')
    text = "<br/>".join(parts)

    # 分页：每 LINES_PER_PAGE 行插入显式分页，保证每页恰好 50 行
    chunk_size = LINES_PER_PAGE
    paras = []
    lines_arr = text.split("<br/>")
    for start in range(0, len(lines_arr), chunk_size):
        chunk = "<br/>".join(lines_arr[start:start + chunk_size])
        paras.append(Paragraph(chunk, style))
        paras.append(PageBreak())
    # 去掉最后一个多余分页
    if paras and isinstance(paras[-1], PageBreak):
        paras.pop()
    doc.build(paras)

def _decorate(canvas, doc):
    canvas.saveState()
    w, h = A4
    # 页眉
    canvas.setFont(FONT, 8)
    canvas.setFillColorRGB(0.4, 0.4, 0.4)
    canvas.drawString(18 * mm, h - 9 * mm,
                      "源程序  ·  智溯 多智能体科研协同编辑与版权溯源系统 V1.0.0")
    canvas.drawRightString(w - 14 * mm, h - 9 * mm, "第 %d 页" % doc.page)
    canvas.setStrokeColorRGB(0.7, 0.7, 0.7)
    canvas.line(18 * mm, h - 10.5 * mm, w - 14 * mm, h - 10.5 * mm)
    # 页脚
    canvas.drawCentredString(w / 2, 8 * mm,
                             "软件著作权源代码（前30页 + 后30页，共60页）")
    canvas.restoreState()

if __name__ == "__main__":
    files = gather()
    all_lines = flatten(files)
    selected, total_all = select(all_lines)
    build(selected, total_all)
    print("源码文件数:", len(files))
    print("总代码行数(含文件头):", total_all)
    print("提交行数:", len(selected))
    print("生成文件:", OUT)
