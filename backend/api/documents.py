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
from sqlalchemy import delete, func as _sql_func
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import (
    Comment,
    Document,
    DocumentCollaborator,
    DocumentVersion,
    OpLog,
    PermissionConfig,
    User,
    WatermarkRecord,
)
from services.oplog_chain import OpLogHashChain, oplog_append_lock

router = APIRouter(prefix="/api/documents", tags=["documents"])

# 版本回溯: 每文档最多保留的版本快照数 (超出删除最旧)
MAX_VERSIONS_PER_DOC = 50


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
            # 版本回溯: 内容变化即自动快照一版 (去重 + 上限裁剪)
            await _snapshot_version(
                db, doc, operator_id, old_content, doc.content
            )

        await db.commit()
        await db.refresh(doc)
        return doc


async def _snapshot_version(
    db: AsyncSession,
    doc: Document,
    operator_id: uuid.UUID,
    old_content: str,
    new_content: str,
) -> None:
    """
    内容变更时记录文档版本快照 (步骤 15 版本回溯):
      - 与最新版本内容相同则不重复记录 (防抖保存场景下去重)
      - version_no = 现有最大版本号 + 1
      - 超出 MAX_VERSIONS_PER_DOC 时删除最旧版本, 保持可回溯窗口
    """
    last_stmt = (
        select(DocumentVersion)
        .where(DocumentVersion.doc_id == doc.id)
        .order_by(DocumentVersion.version_no.desc())
        .limit(1)
    )
    last = (await db.execute(last_stmt)).scalar_one_or_none()
    if last is not None and last.content == new_content:
        # 内容与最新版本一致 (如防抖重复保存), 无需新版本
        return

    next_no = (last.version_no + 1) if last else 1
    db.add(
        DocumentVersion(
            doc_id=doc.id,
            version_no=next_no,
            content=new_content,
            yjs_state=doc.yjs_state,
            operator_id=operator_id,
        )
    )
    await db.flush()

    # 裁剪: 只保留最近 MAX_VERSIONS_PER_DOC 个版本
    count_stmt = (
        select(_sql_func.count())
        .select_from(DocumentVersion)
        .where(DocumentVersion.doc_id == doc.id)
    )
    count = (await db.execute(count_stmt)).scalar_one()
    if count > MAX_VERSIONS_PER_DOC:
        excess = count - MAX_VERSIONS_PER_DOC
        await db.execute(
            delete(DocumentVersion)
            .where(DocumentVersion.doc_id == doc.id)
            .where(
                DocumentVersion.version_no.in_(
                    select(DocumentVersion.version_no)
                    .where(DocumentVersion.doc_id == doc.id)
                    .order_by(DocumentVersion.version_no.asc())
                    .limit(excess)
                )
            )
        )


async def _append_content_log(
    db: AsyncSession,
    doc: Document,
    operator_id: uuid.UUID,
    old_content: str,
    new_content: str,
    extra_operation: Optional[dict] = None,
) -> None:
    """
    内容更新时追加一条溯源链日志:
      - 取该文档链尾 current_hash 作为 prev_hash;
      - current_hash 由 flush 后的数据库时间戳计算, 保证与
        verify_provenance 的校验规则一致。
      - extra_operation: 追加自定义操作字段 (如 version_restore 标记)
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
    if extra_operation:
        operation.update(extra_operation)

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
    # 显式删除子表记录再删文档本体:
    # SQLite 未启用 FK 级联, 且 ORM 对非空外键的默认"置空"策略会触发
    # NOT NULL constraint failed (op_logs.doc_id), 导致删除 500。
    # 注: Core delete 需 synchronize_session=False, 否则在已加载 doc 对象的
    # 会话中会触发 StaleDataError (expected N row(s); Only 0 were matched)
    await db.execute(
        delete(OpLog).where(OpLog.doc_id == doc_id).execution_options(synchronize_session=False)
    )
    await db.execute(
        delete(WatermarkRecord).where(WatermarkRecord.doc_id == doc_id).execution_options(synchronize_session=False)
    )
    await db.execute(
        delete(Comment).where(Comment.doc_id == doc_id).execution_options(synchronize_session=False)
    )
    await db.execute(
        delete(DocumentVersion)
        .where(DocumentVersion.doc_id == doc_id)
        .execution_options(synchronize_session=False)
    )
    await db.execute(
        delete(DocumentCollaborator)
        .where(DocumentCollaborator.document_id == doc_id)
        .execution_options(synchronize_session=False)
    )
    await db.execute(
        delete(PermissionConfig)
        .where(PermissionConfig.doc_id == doc_id)
        .execution_options(synchronize_session=False)
    )
    # 文档本体也用 Core delete (synchronize_session=False): 避免 ORM 对
    # many-to-many 关联表 (document_collaborators) 的级联删除与已删行冲突
    await db.execute(
        delete(Document)
        .where(Document.id == doc_id)
        .execution_options(synchronize_session=False)
    )
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

    # 权限策略: 导出限制 (export_policy=deny 时禁止导出)
    if await _export_denied(db, doc_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="文档已设置禁止导出 (export_policy=deny)",
        )

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


# ---------------------------------------------------------------------------
# 版本回溯 (步骤 15)
# ---------------------------------------------------------------------------
class VersionListItem(BaseModel):
    """版本列表项"""

    version_no: int
    created_at: datetime
    operator_id: uuid.UUID
    content_length: int
    preview: str
    has_yjs_state: bool


class VersionsOut(BaseModel):
    """版本列表响应"""

    doc_id: uuid.UUID
    total: int
    max_versions: int
    versions: List[VersionListItem]


class VersionDetailOut(BaseModel):
    """版本详情 (完整内容)"""

    doc_id: uuid.UUID
    version_no: int
    created_at: datetime
    operator_id: uuid.UUID
    content: str
    yjs_state_b64: Optional[str] = None


@router.get("/{doc_id}/versions", response_model=VersionsOut)
async def list_document_versions(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> VersionsOut:
    """列出文档全部版本快照 (新→旧), 含预览与字数"""
    doc = await db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    stmt = (
        select(DocumentVersion)
        .where(DocumentVersion.doc_id == doc_id)
        .order_by(DocumentVersion.version_no.desc())
    )
    versions = list((await db.execute(stmt)).scalars().all())
    return VersionsOut(
        doc_id=doc_id,
        total=len(versions),
        max_versions=MAX_VERSIONS_PER_DOC,
        versions=[
            VersionListItem(
                version_no=v.version_no,
                created_at=v.created_at,
                operator_id=v.operator_id,
                content_length=len(v.content),
                preview=v.content[:120],
                has_yjs_state=v.yjs_state is not None,
            )
            for v in versions
        ],
    )


@router.get("/{doc_id}/versions/{version_no}", response_model=VersionDetailOut)
async def get_document_version(
    doc_id: uuid.UUID,
    version_no: int,
    db: AsyncSession = Depends(get_db),
) -> VersionDetailOut:
    """获取某版本完整内容 (预览/比对用)"""
    version = await _get_version(db, doc_id, version_no)
    return VersionDetailOut(
        doc_id=doc_id,
        version_no=version.version_no,
        created_at=version.created_at,
        operator_id=version.operator_id,
        content=version.content,
        yjs_state_b64=(
            base64.b64encode(version.yjs_state).decode("ascii")
            if version.yjs_state
            else None
        ),
    )


@router.post("/{doc_id}/versions/{version_no}/restore", response_model=DocumentOut)
async def restore_document_version(
    doc_id: uuid.UUID,
    version_no: int,
    db: AsyncSession = Depends(get_db),
) -> Document:
    """
    恢复到指定版本: 文档内容与 Yjs 状态回写为该版本快照,
    并在溯源链追加一条 replace 日志 (operation.action='version_restore'),
    保证"回溯动作"本身也可追溯。
    """
    version = await _get_version(db, doc_id, version_no)

    async with oplog_append_lock(doc_id):
        doc = await db.get(Document, doc_id)
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")

        old_content = doc.content
        doc.content = version.content
        if version.yjs_state is not None:
            doc.yjs_state = version.yjs_state

        # 恢复动作写入溯源链 (复用 replace 类型, 携带 version_restore 标记)
        await _append_content_log(
            db,
            doc,
            version.operator_id,
            old_content,
            doc.content,
            extra_operation={"action": "version_restore", "version_no": version.version_no},
        )
        # 恢复后的内容同样快照为最新版本
        await _snapshot_version(db, doc, version.operator_id, old_content, doc.content)

        await db.commit()
        await db.refresh(doc)
        return doc


async def _get_version(
    db: AsyncSession, doc_id: uuid.UUID, version_no: int
) -> DocumentVersion:
    stmt = select(DocumentVersion).where(
        DocumentVersion.doc_id == doc_id,
        DocumentVersion.version_no == version_no,
    )
    version = (await db.execute(stmt)).scalar_one_or_none()
    if version is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return version


# ---------------------------------------------------------------------------
# 文档权限管理 (步骤 15)
# ---------------------------------------------------------------------------
class CollaboratorItem(BaseModel):
    """协作者条目 (含用户信息)"""

    user_id: uuid.UUID
    username: str
    display_name: str
    role: str


class PermissionsOut(BaseModel):
    """文档权限配置响应"""

    doc_id: uuid.UUID
    owner_id: uuid.UUID
    collab_mode: str
    watermark_policy: str
    export_policy: str
    updated_at: Optional[datetime] = None
    collaborators: List[CollaboratorItem]
    all_users: List[CollaboratorItem]


class PermissionsUpdate(BaseModel):
    """文档权限配置更新请求体"""

    collab_mode: str = Field("open", pattern="^(open|invited)$")
    watermark_policy: str = Field("optional", pattern="^(enforce|optional)$")
    export_policy: str = Field("allow", pattern="^(allow|deny)$")
    collaborator_ids: List[uuid.UUID] = Field(default_factory=list)


@router.get("/{doc_id}/permissions", response_model=PermissionsOut)
async def get_document_permissions(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> PermissionsOut:
    """读取文档权限配置与协作者列表 (无配置时按默认值返回)"""
    doc = await db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return await _permissions_out(db, doc)


@router.put("/{doc_id}/permissions", response_model=PermissionsOut)
async def update_document_permissions(
    doc_id: uuid.UUID,
    payload: PermissionsUpdate,
    db: AsyncSession = Depends(get_db),
) -> PermissionsOut:
    """
    更新文档权限配置 (协作模式/水印策略/导出策略) 与协作者集合。
    协作者集合为全量替换: 传入 collaborator_ids 即最终授权名单。
    """
    doc = await db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    # 1. 权限配置 upsert (默认行已由 seed 或惰性创建)
    config = (
        await db.execute(
            select(PermissionConfig).where(PermissionConfig.doc_id == doc_id)
        )
    ).scalar_one_or_none()
    if config is None:
        config = PermissionConfig(doc_id=doc_id)
        db.add(config)
    config.collab_mode = payload.collab_mode
    config.watermark_policy = payload.watermark_policy
    config.export_policy = payload.export_policy

    # 2. 协作者集合全量替换 (owner 始终保留在授权名单中)
    await db.execute(
        delete(DocumentCollaborator).where(
            DocumentCollaborator.document_id == doc_id
        )
    )
    member_ids = {doc.owner_id, *payload.collaborator_ids}
    for uid in member_ids:
        db.add(DocumentCollaborator(document_id=doc_id, user_id=uid))

    await db.commit()
    return await _permissions_out(db, doc)


async def _permissions_out(
    db: AsyncSession, doc: Document
) -> PermissionsOut:
    """组装权限配置响应 (含协作者与全部人类用户)"""
    config = (
        await db.execute(
            select(PermissionConfig).where(PermissionConfig.doc_id == doc.id)
        )
    ).scalar_one_or_none()
    collab_mode = config.collab_mode if config else "open"
    watermark_policy = config.watermark_policy if config else "optional"
    export_policy = config.export_policy if config else "allow"
    updated_at = config.updated_at if config else None

    collab_rows = (
        await db.execute(
            select(DocumentCollaborator).where(
                DocumentCollaborator.document_id == doc.id
            )
        )
    ).scalars().all()
    collab_ids = {r.user_id for r in collab_rows} or {doc.owner_id}

    users_stmt = select(User).where(User.role != "ai_agent").order_by(User.username)
    users = list((await db.execute(users_stmt)).scalars().all())
    users_by_id = {u.id: u for u in users}

    collaborators = [
        CollaboratorItem(
            user_id=u.id, username=u.username,
          
            display_name=u.display_name, role=u.role,
        )
        for u in users
        if u.id in collab_ids
    ]
    all_users = [
        CollaboratorItem(
            user_id=u.id, username=u.username,
            display_name=u.display_name, role=u.role,
        )
        for u in users
    ]
    return PermissionsOut(
        doc_id=doc.id,
        owner_id=doc.owner_id,
        collab_mode=collab_mode,
        watermark_policy=watermark_policy,
        export_policy=export_policy,
        updated_at=updated_at,
        collaborators=collaborators,
        all_users=all_users,
    )


async def _export_denied(db: AsyncSession, doc_id: uuid.UUID) -> bool:
    """查询文档是否禁止导出 (export_policy=deny)"""
    config = (
        await db.execute(
            select(PermissionConfig).where(PermissionConfig.doc_id == doc_id)
        )
    ).scalar_one_or_none()
    return config is not None and config.export_policy == "deny"
