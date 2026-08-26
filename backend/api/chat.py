"""
协作聊天历史 API (步骤 16)
==========================
GET /api/documents/{doc_id}/chat/messages
  - 返回该文档房间的聊天历史 (时间正序, 默认最近 100 条)
  - 供新加入成员/切换文档时加载
"""

import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import ChatMessage, Document

router = APIRouter(prefix="/api/documents", tags=["chat"])


class ChatMessageOut(BaseModel):
    """聊天消息"""

    id: uuid.UUID
    doc_id: uuid.UUID
    user_id: Optional[uuid.UUID] = None
    username: str
    content: str
    created_at: datetime

    class Config:
        from_attributes = True


@router.get("/{doc_id}/chat/messages", response_model=List[ChatMessageOut])
async def get_chat_messages(
    doc_id: uuid.UUID,
    limit: int = Query(100, ge=1, le=500, description="返回最近 N 条"),
    db: AsyncSession = Depends(get_db),
) -> List[ChatMessage]:
    """获取文档房间的聊天历史 (时间正序, 默认最近 100 条)"""
    doc = await db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    stmt = (
        select(ChatMessage)
        .where(ChatMessage.doc_id == doc_id)
        .order_by(ChatMessage.created_at.asc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())
