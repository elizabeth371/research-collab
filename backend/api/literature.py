"""
文献检索 API
================
面向「文献检索面板」与调研 (Research) Agent 的文献检索端点。

- /search: **联网检索优先** (arXiv API, 带重试/超时/标准化映射,
  见 services/arxiv_client.py), 失败或空结果时自动降级本地文献表;
  响应为标准化信封 JSON: {status, message, data[]}, data 内字段
  统一映射为 {id, title, authors[], abstract, url, published_date, source}。
- /{lit_id}, /{lit_id}/citation: 本地文献详情与引文格式文本 (不变)。
"""

import re
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Literature
from services.arxiv_client import search_arxiv_standard

router = APIRouter(prefix="/api/literature", tags=["literature"])


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------
class LiteratureOut(BaseModel):
    """文献条目响应模型"""

    id: uuid.UUID
    title: str
    authors: str
    year: int
    source: str
    abstract: str
    keywords: str
    url: Optional[str] = None

    class Config:
        from_attributes = True


class CitationOut(BaseModel):
    """引文格式文本"""

    citation: str
    bibtex: str


# ---------------------------------------------------------------------------
# 中文检索增强: arXiv 只索引英文, 中文查询需领域词映射; 本地降级按词匹配
# ---------------------------------------------------------------------------
_CJK_RE = re.compile(r"[一-鿿]")

# 领域术语 中文 -> arXiv 英文检索词 (最长匹配优先)
_CJK_EN_MAP = {
    "大语言模型": "large language model",
    "音频水印": "audio watermark",
    "语音水印": "speech audio watermark",
    "文本水印": "text watermark",
    "图像水印": "image watermark",
    "视频水印": "video watermark",
    "大模型": "large language model",
    "协同编辑": "collaborative editing",
    "实时协同": "real-time collaboration",
    "科研诚信": "research integrity",
    "学术诚信": "research integrity",
    "人工智能": "artificial intelligence",
    "机器学习": "machine learning",
    "深度学习": "deep learning",
    "自然语言": "natural language",
    "注意力机制": "attention mechanism",
    "版权保护": "copyright protection",
    "注意力": "attention",
    "水印": "watermark",
    "溯源": "provenance",
    "版权": "copyright",
}

# 中文口语/无检索价值词 (jieba 分词后过滤)
_CJK_STOPWORDS = {
    "你好", "您好", "我想", "我要", "我们", "请帮", "帮我", "请问",
    "一个", "一篇", "相关", "论文", "文章", "介绍", "综述", "方面",
    "写", "写一个", "寻找", "查找", "搜索", "关于", "的", "了", "吗",
    "呢", "啊", "吧", "和", "与", "及", "等", "相关",
}


def _has_cjk(text: str) -> bool:
    return bool(_CJK_RE.search(text or ""))


def _cjk_to_english(keyword: str) -> Optional[str]:
    """把中文查询映射为英文检索词 (arXiv 只索引英文)。

    最长匹配优先扫描领域词典; 未命中词典的中文词不臆造翻译,
    由本地分词降级兜底。返回 None 表示无可映射词。
    """
    if not _has_cjk(keyword):
        return None
    terms: List[str] = []
    rest = keyword
    # 最长匹配优先, 避免 "音频水印" 被 "水印" 抢先
    for zh in sorted(_CJK_EN_MAP, key=len, reverse=True):
        if zh in rest:
            en = _CJK_EN_MAP[zh]
            if en not in terms:
                terms.append(en)
            rest = rest.replace(zh, " ")
    # 非中文部分 (英文单词/术语) 原样保留
    ascii_part = re.findall(r"[A-Za-z][A-Za-z0-9 \-]*", rest)
    for chunk in ascii_part:
        for w in chunk.split():
            if w.lower() not in [t.lower() for t in terms]:
                terms.append(w)
    return " ".join(terms) if terms else None


def _expand_keywords(keyword: str) -> List[str]:
    """本地检索用关键词展开: 中文按 jieba 分词 + 词典英文词, 任一命中即可。"""
    tokens: List[str] = []
    if _has_cjk(keyword):
        try:
            import jieba

            for w in jieba.cut(keyword):
                w = w.strip()
                if len(w) >= 2 and w not in _CJK_STOPWORDS:
                    if w not in tokens:
                        tokens.append(w)
        except Exception:  # jieba 不可用时退化为整串
            tokens.append(keyword)
        en = _cjk_to_english(keyword)
        if en:
            for w in en.split():
                if w.lower() not in [t.lower() for t in tokens]:
                    tokens.append(w)
    else:
        tokens.append(keyword)
    return tokens or [keyword]


# ---------------------------------------------------------------------------
# API 端点
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 标准化检索信封 (联网搜索修复): 本地 Literature 行 -> 统一文献结构
# ---------------------------------------------------------------------------
def _map_local_items(rows: List[Literature]) -> List[dict]:
    """
    字段映射 (Mapping): literature 表行 -> 标准化文献结构,
    与 arXiv 在线结果共用同一份契约 (id/title/authors[]/abstract/url/
    published_date/source), 严禁把 ORM 原始对象直接抛给前端。

    id 使用文献真实 UUID 主键 (而非位置序号): 详情 /citation 等
    按 {lit_id} 路由的端点以 UUID 定位本地库记录, 序号 id 无法寻址。
    """
    data: List[dict] = []
    for row in rows:
        authors_raw = (row.authors or "").strip()
        data.append(
            {
                "id": str(row.id),
                "title": (row.title or "").strip() or "(无标题)",
                "authors": [a.strip() for a in authors_raw.split(",") if a.strip()],
                "abstract": (row.abstract or "").strip(),
                "url": (row.url or "").strip(),
                "published_date": f"{row.year:04d}-01-01" if row.year else None,
                "source": (row.source or "").strip() or "本地文献库",
            }
        )
    return data


async def _search_local(
    db: AsyncSession, keyword: str, limit: int
) -> List[Literature]:
    """本地文献表匹配 (标题/摘要/关键词/作者); 空关键词返回最近入库。

    中文关键词先经 _expand_keywords 展开为词元 (jieba 分词 + 词典英文词),
    任一词元命中即算匹配 —— 避免「音频水印」这类组合词因整串不匹配而漏检。
    """
    stmt = select(Literature).order_by(Literature.year.desc())
    if keyword:
        conditions = []
        for token in _expand_keywords(keyword):
            like = f"%{token}%"
            conditions.append(
                or_(
                    Literature.title.ilike(like),
                    Literature.abstract.ilike(like),
                    Literature.keywords.ilike(like),
                    Literature.authors.ilike(like),
                )
            )
        if conditions:
            stmt = stmt.where(or_(*conditions))
    stmt = stmt.limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/search")
async def search_literature(
    q: str = Query("", max_length=200, description="检索关键词"),
    limit: int = Query(10, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    联网文献检索 (标准化信封 JSON)。

    策略:
      1. 空关键词        -> 本地文献库最近入库 (面板初始化展示);
      2. 联网检索成功    -> 直接返回 arXiv 标准化结果;
      3. 联网成功但为空  -> 补充本地文献库匹配项; 仍无则按规范返回
         {"status":"success","data":[],"message":"未找到相关文献，请更换关键词"};
      4. 联网失败 (超时/网络/解析) -> 降级本地文献库并在 message 中注明;
         本地也不可用时透传标准化错误信封 (TIMEOUT/NETWORK_ERROR/PARSE_ERROR)。
    """
    keyword = q.strip()

    if not keyword:
        rows = await _search_local(db, "", limit)
        return {
            "status": "success",
            "message": "本地文献库最近入库文献",
            "data": _map_local_items(rows),
        }

    online = await search_arxiv_standard(keyword, max_results=limit)

    # 中文查询: arXiv 仅索引英文, 原查询为空时补一次领域词英译检索
    # (如「音频水印」-> "audio watermark"); 仍为空则走本地分词降级
    if online.get("status") == "success" and not online.get("data"):
        en_query = _cjk_to_english(keyword)
        if en_query:
            online = await search_arxiv_standard(en_query, max_results=limit)

    # 联网成功且非空 -> 直接返回
    if online.get("status") == "success" and online.get("data"):
        return online

    # 联网成功但空结果 -> 本地补充, 仍无则规范空态
    if online.get("status") == "success":
        rows = await _search_local(db, keyword, limit)
        if rows:
            return {
                "status": "success",
                "message": "在线检索未找到结果，以下为本地文献库匹配项",
                "data": _map_local_items(rows),
            }
        return {
            "status": "success",
            "data": [],
            "message": "未找到相关文献，请更换关键词",
        }

    # 联网失败 -> 本地降级; 本地也不可用时透传错误信封
    try:
        rows = await _search_local(db, keyword, limit)
    except Exception:
        return online
    if rows:
        return {
            "status": "success",
            "message": f"在线检索暂不可用（{online.get('message', '')}），"
                       "已返回本地文献库结果",
            "data": _map_local_items(rows),
        }
    return online


@router.get("/{lit_id}", response_model=LiteratureOut)
async def get_literature(
    lit_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Literature:
    """获取单条文献详情"""
    lit = await db.get(Literature, lit_id)
    if lit is None:
        from fastapi import HTTPException, status

        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Literature not found")
    return lit


@router.get("/{lit_id}/citation", response_model=CitationOut)
async def get_citation(
    lit_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    生成文献的引文格式文本 (GB/T 7714 近似 + BibTeX),
    供前端"插入引用"写入协作文档。
    """
    lit = await db.get(Literature, lit_id)
    if lit is None:
        from fastapi import HTTPException, status

        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Literature not found")

    authors = lit.authors or "佚名"
    title = lit.title
    source = lit.source
    year = lit.year

    # GB/T 7714 近似格式: 作者. 题名[J]. 来源, 年份.
    citation = f"{authors}. {title}[J]. {source}, {year}."

    # BibTeX 近似格式
    first_author = (authors.split(",")[0].split(" ")[0] if authors else "unknown")
    bibtex = (
        f"@article{{{first_author}{year},\n"
        f"  title = {{{title}}},\n"
        f"  author = {{{authors}}},\n"
        f"  journal = {{{source}}},\n"
        f"  year = {{{year}}}\n"
        f"}}"
    )
    return {"citation": citation, "bibtex": bibtex}
