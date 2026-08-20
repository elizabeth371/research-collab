"""
SQLAlchemy ORM 模型定义
========================
对应数据库表:
1. User             - 用户表
2. Document         - 文档表 (含 yjs_state 二进制字段)
3. OpLog            - 操作日志表 (prev_hash/current_hash/operation_jsonb)
4. WatermarkRecord  - 水印记录表
5. Literature       - 文献资源表 (调研 Agent 检索语料)
6. PermissionConfig - 权限配置表 (文档/用户访问控制)

技术要点:
- 使用 SQLAlchemy 2.0 Mapped / mapped_column 类型注解风格
- 操作日志采用"哈希链"结构实现版权溯源与防篡改
- 类型跨方言设计: PostgreSQL 使用原生 UUID/JSONB/BYTEA,
  SQLite 自动降级为 CHAR(32)/JSON/BLOB (便于本地无数据库直接运行)
"""

import uuid
from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    String,
    Text,
    LargeBinary,
    Integer,
    SmallInteger,
    Float,
    ForeignKey,
    UniqueConstraint,
    Index,
    CheckConstraint,
    JSON,
    DateTime,
    TIMESTAMP,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.dialects.postgresql import JSONB as PG_JSONB
from sqlalchemy.dialects.postgresql import BYTEA as PG_BYTEA
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


# ---------------------------------------------------------------------------
# 跨方言类型定义
# ---------------------------------------------------------------------------
# PostgreSQL 使用原生 UUID, 其他方言 (SQLite) 使用 CHAR(32) 字符串
UUID_TYPE = Uuid().with_variant(PG_UUID(as_uuid=True), "postgresql")

# PostgreSQL 使用原生 JSONB, 其他方言使用 JSON
JSONB_TYPE = JSON().with_variant(PG_JSONB, "postgresql")

# PostgreSQL 使用原生 BYTEA, 其他方言使用 LargeBinary (BLOB)
BYTEA_TYPE = LargeBinary().with_variant(PG_BYTEA, "postgresql")


# 通用 GUID 主键生成函数
def _gen_uuid() -> uuid.UUID:
    """生成 UUID 主键"""
    return uuid.uuid4()


# ===========================================================================
# 1. 用户表
# ===========================================================================
class User(Base):
    """
    用户表: 人类用户与 AI Agent 账号统一在该表中建模。
    AI Agent 通过 role='ai_agent' 区分。
    """

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            "role IN ('admin', 'researcher', 'collaborator', 'ai_agent')",
            name="ck_users_role",
        ),
        Index("idx_users_role", "role"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE, primary_key=True, default=_gen_uuid
    )
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    avatar_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    role: Mapped[str] = mapped_column(
        String(32), nullable=False, default="researcher"
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    # 反向关系
    documents: Mapped[List["Document"]] = relationship(
        back_populates="owner", foreign_keys="Document.owner_id"
    )
    op_logs: Mapped[List["OpLog"]] = relationship(back_populates="user")

    def __repr__(self) -> str:
        return f"<User {self.username} ({self.role})>"


# ===========================================================================
# 2. 文档表
# ===========================================================================
class Document(Base):
    """
    文档表:
    - yjs_state: 存储 Yjs CRDT 文档的完整状态快照 (Update Message 二进制)
    - content:   明文快照，供快速预览与全文检索 (与 yjs_state 最终一致)
    - watermark_status: 0-未检测 1-含AI水印 2-纯人类创作
    """

    __tablename__ = "documents"
    __table_args__ = (
        Index("idx_documents_owner", "owner_id"),
        Index("idx_documents_updated_at", "updated_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE, primary_key=True, default=_gen_uuid
    )
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Yjs 协同状态快照 (二进制)
    yjs_state: Mapped[Optional[bytes]] = mapped_column(BYTEA_TYPE, nullable=True)
    # 明文快照
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # 0-未检测 1-含AI水印 2-纯人类
    watermark_status: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=0
    )
    agent_session_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID_TYPE, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    # 关系
    owner: Mapped["User"] = relationship(
        back_populates="documents", foreign_keys=[owner_id]
    )
    collaborators: Mapped[List["User"]] = relationship(
        secondary="document_collaborators",
        lazy="selectin",
    )
    op_logs: Mapped[List["OpLog"]] = relationship(back_populates="document")
    watermarks: Mapped[List["WatermarkRecord"]] = relationship(
        back_populates="document"
    )

    def __repr__(self) -> str:
        return f"<Document {self.title}>"


# 文档-协作者中间表 (多对多)
class DocumentCollaborator(Base):
    """文档-协作者关联表"""

    __tablename__ = "document_collaborators"
    __table_args__ = (
        UniqueConstraint("document_id", "user_id", name="uq_doc_collab"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE,
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )


# ===========================================================================
# 3. 操作日志表 (版权溯源哈希链)
# ===========================================================================
class OpLog(Base):
    """
    操作日志表 (哈希链结构):
    - prev_hash:     前一条操作日志的 current_hash ("" 表示链首)
    - current_hash:  sha256(prev_hash + operation_json + created_at)
    - operation:     操作内容 JSON (PostgreSQL: JSONB / SQLite: JSON)

    每条日志可通过 current_hash 串联成链。一旦某条历史日志被修改，
    其后所有 current_hash 均失效，服务端可快速校验链完整性。
    """

    __tablename__ = "op_logs"
    __table_args__ = (
        CheckConstraint(
            "op_type IN ('insert', 'delete', 'replace', 'ai_generate', 'watermark_checked')",
            name="ck_oplogs_type",
        ),
        Index("idx_oplogs_doc_created", "doc_id", "created_at"),
        Index("idx_oplogs_prev_hash", "prev_hash"),
        Index("idx_oplogs_op_type", "op_type"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE, primary_key=True, default=_gen_uuid
    )
    doc_id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE,
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    op_type: Mapped[str] = mapped_column(String(32), nullable=False)
    # 操作内容 JSONB
    operation: Mapped[dict] = mapped_column(JSONB_TYPE, nullable=False, default=dict)
    # 哈希链字段
    prev_hash: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    current_hash: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )

    # 关系
    document: Mapped["Document"] = relationship(back_populates="op_logs")
    user: Mapped["User"] = relationship(back_populates="op_logs")

    def __repr__(self) -> str:
        return f"<OpLog {self.op_type} @ {self.doc_id}>"


# ===========================================================================
# 4. 水印记录表
# ===========================================================================
class WatermarkRecord(Base):
    """
    水印记录表:
    记录某文档中 AI 生成内容的水印参数 (Kirchenbauer 方案)。
    用于后续检测时还原绿/红名单，验证文本是否包含水印。
    """

    __tablename__ = "watermark_records"
    __table_args__ = (
        Index("idx_watermarks_doc", "doc_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE, primary_key=True, default=_gen_uuid
    )
    doc_id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE,
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
    )
    model_name: Mapped[str] = mapped_column(String(128), nullable=False)
    # 绿名单比例
    gamma: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    # logits 偏移强度
    delta: Mapped[float] = mapped_column(Float, nullable=False, default=2.0)
    # 哈希密钥 (用于还原绿名单)
    secret_key: Mapped[bytes] = mapped_column(BYTEA_TYPE, nullable=False)
    # 涉及水印的 token 序列 (调试用)
    token_seq: Mapped[dict] = mapped_column(JSONB_TYPE, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )

    # 关系
    document: Mapped["Document"] = relationship(back_populates="watermarks")

    def __repr__(self) -> str:
        return f"<WatermarkRecord {self.model_name} gamma={self.gamma} delta={self.delta}>"


# ===========================================================================
# 5. 文献资源表
# ===========================================================================
class Literature(Base):
    """
    文献资源表: 调研 (Research) Agent 的检索语料库。

    支持按标题/摘要/关键词检索, 前端展示检索结果并可一键插入
    引文到协作文档。
    """

    __tablename__ = "literature"
    __table_args__ = (
        Index("idx_literature_keywords", "keywords"),
        Index("idx_literature_year", "year"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE, primary_key=True, default=_gen_uuid
    )
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    authors: Mapped[str] = mapped_column(String(512), nullable=False, default="")
    year: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    abstract: Mapped[str] = mapped_column(Text, nullable=False, default="")
    keywords: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=func.now()
    )

    def __repr__(self) -> str:
        return f"<Literature {self.year} {self.title[:40]}>"


# ===========================================================================
# 6. 权限配置表
# ===========================================================================
class PermissionConfig(Base):
    """
    权限配置表: 文档级访问控制策略。

    每个文档可配置:
    - 协作模式 (collab_mode): open(公开协作) / invited(受邀协作)
    - 水印策略 (watermark_policy): enforce(强制水印) / optional(可选)
    - 导出限制 (export_policy): allow / deny
    """

    __tablename__ = "permission_configs"
    __table_args__ = (
        UniqueConstraint("doc_id", name="uq_perm_doc"),
        CheckConstraint(
            "collab_mode IN ('open', 'invited')", name="ck_perm_collab_mode"
        ),
        CheckConstraint(
            "watermark_policy IN ('enforce', 'optional')",
            name="ck_perm_watermark_policy",
        ),
        CheckConstraint(
            "export_policy IN ('allow', 'deny')", name="ck_perm_export_policy"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE, primary_key=True, default=_gen_uuid
    )
    doc_id: Mapped[uuid.UUID] = mapped_column(
        UUID_TYPE,
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
    )
    collab_mode: Mapped[str] = mapped_column(
        String(16), nullable=False, default="open"
    )
    watermark_policy: Mapped[str] = mapped_column(
        String(16), nullable=False, default="optional"
    )
    export_policy: Mapped[str] = mapped_column(
        String(16), nullable=False, default="allow"
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    def __repr__(self) -> str:
        return f"<PermissionConfig {self.doc_id} mode={self.collab_mode}>"