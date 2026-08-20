"""
文献检索 API
================
面向调研 (Research) Agent 的文献资源检索端点。

- 数据源: literature 表 (种子语料 + 人工导入)
- 检索策略: 标题/摘要/关键词的简单包含匹配 (骨架阶段;
  后续可接入 ArXiv / 知网 / 语义 Scholar 等外部检索源)
- 能力: 关键词检索 + 文献详情 + 插入引文格式文本
"""

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Literature

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
@router.get("/search", response_model=List[LiteratureOut])
async def search_literature(
    q: str = Query("", description="检索关键词"),
    limit: int = Query(10, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
) -> List[Literature]:
    """
    按关键词检索文献 (标题 / 摘要 / 关键词包含匹配)。
    空关键词返回最近入库的文献, 便于前端初始化展示。
    """
    stmt = select(Literature).order_by(Literature.year.desc())
    keyword = q.strip()
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
