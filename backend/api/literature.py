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
    """
    data: List[dict] = []
    for idx, row in enumerate(rows, start=1):
        authors_raw = (row.authors or "").strip()
        data.append(
            {
                "id": str(idx),
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
    """本地文献表包含匹配 (标题/摘要/关键词/作者); 空关键词返回最近入库。"""
    stmt = select(Literature).order_by(Literature.year.desc())
    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(
            or_(
                Literature.title.ilike(like),
                Literature.abstract.ilike(like),
                Literature.keywords.ilike(like),
                Literature.authors.ilike(like),
            )
        )
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
