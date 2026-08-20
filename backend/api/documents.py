"""
文档 CRUD API
================
提供文档的基本增删改查，以及 Yjs 协同状态快照的持久化接口。
内容更新时自动写入操作日志 (哈希链), 供溯源链模块追溯。
"""

import base64
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func as _sql_func
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Document, OpLog
from services.oplog_chain import OpLogHashChain, oplog_append_lock

router = APIRouter(prefix="/api/documents", tags=["documents"])


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------
class DocumentCreate(BaseModel):
    """创建文档请求体"""

    title: str = Field(..., min_length=1, max_length=512)
    owner_id: uuid.UUID
    content: str = ""


class DocumentUpdate(BaseModel):
    """更新文档请求体"""

    title: Optional[str] = Field(None, min_length=1, max_length=512)
    content: Optional[str] = None
    yjs_state: Optional[bytes] = None     # 以 base64 / 二进制传入的 Yjs 快照
    watermark_status: Optional[int] = Field(None, ge=0, le=2)
    operator_id: Optional[uuid.UUID] = None  # 操作者 (写入溯源链日志用)


class DocumentOut(BaseModel):
    """文档响应模型"""

    id: uuid.UUID
    title: str
    owner_id: uuid.UUID
    content: str
    watermark_status: int
    agent_session_id: Optional[uuid.UUID] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# API 端点
# ---------------------------------------------------------------------------
@router.get("", response_model=List[DocumentOut])
async def list_documents(
    owner_id: Optional[uuid.UUID] = None,
    db: AsyncSession = Depends(get_db),
) -> List[Document]:
    """
    文档列表。可按 owner_id 过滤。
    """
    stmt = select(Document).order_by(Document.updated_at.desc())
    if owner_id:
        stmt = stmt.where(Document.owner_id == owner_id)
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.post("", response_model=DocumentOut, status_code=status.HTTP_201_CREATED)
async def create_document(
    payload: DocumentCreate,
    db: AsyncSession = Depends(get_db),
) -> Document:
    """创建新文档"""
    doc = Document(
        title=payload.title,
        owner_id=payload.owner_id,
        content=payload.content,
    )
    db.add(doc)
    await db.commit()
    await db.refresh(doc)
    return doc


@router.get("/{doc_id}", response_model=DocumentOut)
async def get_document(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Document:
    """获取单个文档"""
    doc = await db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@router.patch("/{doc_id}", response_model=DocumentOut)
async def update_document(
    doc_id: uuid.UUID,
    payload: DocumentUpdate,
    db: AsyncSession = Depends(get_db),
) -> Document:
    """更新文档 (标题 / 内容 / 协同状态快照 / 水印状态)"""
    # 串行化本文档的溯源链追加: 并发 PATCH 读到相同链尾会算出相同
    # current_hash, 违反 op_logs.current_hash UNIQUE 约束 -> 500 + 断链
    # (缺陷 D1, 见 oplog_chain.oplog_append_lock 说明)。锁覆盖
    # 「读文档 -> 写 OpLog -> commit」全过程, 提交后释放。
    async with oplog_append_lock(doc_id):
        doc = await db.get(Document, doc_id)
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")

        data = payload.model_dump(exclude_unset=True)
        # operator_id 是溯源链元数据, 不属于 Document 字段
        operator_id = data.pop("operator_id", None) or doc.owner_id

        content_changed = "content" in data and data["content"] != doc.content
        old_content = doc.content

        for field, value in data.items():
            setattr(doc, field, value)

        # 内容变更 -> 写入溯源链操作日志 (哈希链)
        if content_changed:
            await _append_content_log(db, doc, operator_id, old_content, doc.content)

        await db.commit()
        await db.refresh(doc)
        return doc


async def _append_content_log(
    db: AsyncSession,
    doc: Document,
    operator_id: uuid.UUID,
    old_content: str,
    new_content: str,
) -> None:
    """
    内容更新时追加一条溯源链日志:
      - 取该文档链尾 current_hash 作为 prev_hash;
      - current_hash 由 flush 后的数据库时间戳计算, 保证与
        verify_provenance 的校验规则一致。
    """
    from models import OpLog as OpLogModel  # noqa: F401 (类型引用)

    last_stmt = (
        select(OpLog)
        .where(OpLog.doc_id == doc.id)
        .order_by(OpLog.created_at.desc())
        .limit(1)
    )
    last = (await db.execute(last_stmt)).scalar_one_or_none()
    prev_hash = last.current_hash if last else ""

    # 首次内容写入视为 insert, 后续修改视为 replace
    op_type = "insert" if not old_content.strip() else "replace"
    operation = {
        "content_len": len(new_content),
        "content_head": new_content[:200],
        "old_len": len(old_content),
        "delta": len(new_content) - len(old_content),
    }

    log = OpLog(
        doc_id=doc.id,
        user_id=operator_id,
        op_type=op_type,
        operation=operation,
        prev_hash=prev_hash,
        current_hash="",  # flush 后按数据库时间戳补算
    )
    db.add(log)
    await db.flush()
    log.current_hash = OpLogHashChain.compute_hash(
        prev_hash=prev_hash,
        operation=operation,
        timestamp=log.created_at,
    )


@router.delete("/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """删除文档"""
    doc = await db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    await db.delete(doc)
    await db.commit()


# ---------------------------------------------------------------------------
# 文档导出 (Markdown + 溯源元数据)
# ---------------------------------------------------------------------------
@router.get("/{doc_id}/export")
async def export_document(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """
    导出文档为 Markdown 文本, 并附带完整的溯源元数据:
      - 文档标题 / 更新时间 / 字数统计
      - 正文内容 (段落保留)
      - 溯源哈希链校验状态 (valid / 日志条数)
      - 水印检测记录
      - 可引用的参考文献列表

    前端可直接下载为 .md 文件, 或用于软著演示的"版权可信导出"。
    """
    from models import Literature, WatermarkRecord

    doc = await db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    # 溯源链统计与校验
    oplog_stmt = (
        select(OpLog).where(OpLog.doc_id == doc_id).order_by(OpLog.created_at.asc())
    )
    logs = list((await db.execute(oplog_stmt)).scalars().all())
    chain_ok, checked = True, 0
    prev_hash = ""
    for log in logs:
        if log.prev_hash != prev_hash:
            chain_ok = False
            break
        expected = OpLogHashChain.compute_hash(
            prev_hash=log.prev_hash,
            operation=log.operation,
            timestamp=log.created_at,
        )
        if log.current_hash != expected:
            chain_ok = False
            break
        prev_hash = log.current_hash
        checked += 1

    # 水印记录
    wm_stmt = select(WatermarkRecord).where(WatermarkRecord.doc_id == doc_id)
    wm_records = list((await db.execute(wm_stmt)).scalars().all())

    # 参考文献 (全库, 供引用参考)
    lit_stmt = select(Literature).order_by(Literature.year.desc()).limit(10)
    lits = list((await db.execute(lit_stmt)).scalars().all())

    lines: List[str] = []
    lines.append(f"# {doc.title}")
    lines.append("")
    lines.append(f"> 导出时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"> 文档字数: {len(doc.content)} | 操作日志: {len(logs)} 条")
    lines.append(f"> 溯源哈希链校验: {'✅ 完整可信' if chain_ok else '❌ 校验失败'} (检查 {checked} 条)")
    lines.append("")
    lines.append("---")
    lines.append("")

    # 正文 (剥离编辑器 HTML 标签, 保留段落)
    import re as _re

    content = doc.content or "(空文档)"
    content = _re.sub(r"<[^>]+>", "", content)
    if content.strip():
        for para in content.split("\n"):
            para = para.strip()
            if not para:
                continue
            lines.append(para)
            lines.append("")
    else:
        lines.append("(空文档)")
        lines.append("")

    # 水印记录
    if wm_records:
        lines.append("---")
        lines.append("")
        lines.append("## 🔍 水印检测记录")
        lines.append("")
        for i, r in enumerate(wm_records, 1):
            lines.append(
                f"{i}. {r.created_at.strftime('%Y-%m-%d %H:%M')} · "
                f"模型 {r.model_name} · gamma={r.gamma} · delta={r.delta}"
            )
        lines.append("")

    # 参考文献
    if lits:
        lines.append("---")
        lines.append("")
        lines.append("## 📚 参考文献 (GB/T 7714)")
        lines.append("")
        for i, l in enumerate(lits, 1):
            cite = f"{l.authors}.{l.title}[{l.source}].{l.year}."
            lines.append(f"[{i}] {cite}")
        lines.append("")

    body = "\n".join(lines)
    filename = f"{doc.title or 'document'}.md"
    return Response(
        content=body,
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename*=UTF-8\'\'{_urlquote(filename)}'
        },
    )


def _urlquote(name: str) -> str:
    """URL 编码文件名 (RFC 5987, 支持中文)"""
    from urllib.parse import quote

    return quote(name)


# ---------------------------------------------------------------------------
# Yjs 协同状态持久化
# ---------------------------------------------------------------------------
@router.get("/{doc_id}/yjs-state")
async def get_yjs_state(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    获取文档 Yjs CRDT 状态快照 (用于新加入的客户端离线初始化)。
    返回 base64 编码字符串。
    """
    doc = await db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    state_b64 = base64.b64encode(doc.yjs_state or b"").decode("ascii")
    return {"doc_id": str(doc_id), "yjs_state_b64": state_b64}


@router.put("/{doc_id}/yjs-state")
async def save_yjs_state(
    doc_id: uuid.UUID,
    payload: dict,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    保存文档 Yjs 状态快照。
    请求体: {"yjs_state_b64": "..."}  (编码后的 Yjs Update Message)
    """
    state_b64: str = payload.get("yjs_state_b64", "")
    try:
        state_bytes = base64.b64decode(state_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64")

    stmt = (
        update(Document)
        .where(Document.id == doc_id)
        .values(yjs_state=state_bytes, updated_at=func_now_sql())
    )
    result = await db.execute(stmt)
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Document not found")
    await db.commit()
    return {"ok": True}


# 辅助: 直接使用 SQL now()
def func_now_sql():
    return _sql_func.now()
