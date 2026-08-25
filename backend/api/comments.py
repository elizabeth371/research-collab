"""
段落批注 API
==============
师门共研核心: 支持对文档中任意段落添加批注 / 查看 / 删除。

批注锚定: 段落序号 para_index (1 起, 按 ProseMirror 顶层块级节点顺序)
+ 段落文本快照 para_snapshot, 展示时由前端校验段落是否漂移。
"""

import uuid
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Comment, Document

router = APIRouter(prefix="/api/documents", tags=["comments"])


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------
class CommentCreate(BaseModel):
    """新增批注请求体"""

    para_index: int = Field(..., ge=1, description="段落序号 (1 起)")
    para_snapshot: str = Field("", description="锚定段落文本快照 (防漂移校验)")
    author: str = Field(..., min_length=1, max_length=64, description="批注人")
    content: str = Field(..., min_length=1, max_length=2000, description="批注内容")


class CommentOut(BaseModel):
    """批注响应体"""

    id: str
    doc_id: str
    para_index: int
    para_snapshot: str
    author: str
    content: str
    created_at: datetime


async def _ensure_doc_exists(db: AsyncSession, doc_id: uuid.UUID) -> None:
    doc = await db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------
@router.get("/{doc_id}/comments", response_model=List[CommentOut])
async def list_comments(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> List[CommentOut]:
    """列出文档全部批注 (按创建时间升序)"""
    await _ensure_doc_exists(db, doc_id)
    stmt = (
        select(Comment)
        .where(Comment.doc_id == doc_id)
        .order_by(Comment.created_at.asc())
    )
    result = await db.execute(stmt)
    comments = list(result.scalars().all())
    return [
        CommentOut(
            id=str(c.id),
            doc_id=str(c.doc_id),
            para_index=c.para_index,
            para_snapshot=c.para_snapshot,
            author=c.author,
            content=c.content,
            created_at=c.created_at,
        )
        for c in comments
    ]


@router.post(
    "/{doc_id}/comments",
    response_model=CommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_comment(
    doc_id: uuid.UUID,
    payload: CommentCreate,
    db: AsyncSession = Depends(get_db),
) -> CommentOut:
    """为文档某段落新增批注"""
    await _ensure_doc_exists(db, doc_id)
    comment = Comment(
        doc_id=doc_id,
        para_index=payload.para_index,
        para_snapshot=payload.para_snapshot,
        author=payload.author,
        content=payload.content,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return CommentOut(
        id=str(comment.id),
        doc_id=str(comment.doc_id),
        para_index=comment.para_index,
        para_snapshot=comment.para_snapshot,
        author=comment.author,
        content=comment.content,
        created_at=comment.created_at,
    )


@router.delete(
    "/{doc_id}/comments/{comment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_comment(
    doc_id: uuid.UUID,
    comment_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """删除批注 (校验归属文档)"""
    comment = await db.get(Comment, comment_id)
    if comment is None or comment.doc_id != doc_id:
        raise HTTPException(status_code=404, detail="Comment not found")
    await db.delete(comment)
    await db.commit()
