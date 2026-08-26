"""
异步数据库连接与会话管理
=========================
使用 SQLAlchemy 2.0 async API + asyncpg 驱动连接 PostgreSQL。

**自动回退机制**:
- 优先尝试连接 PostgreSQL (asyncpg)
- 若连接失败 (服务未启动/无权限), 自动回退到本地 SQLite 文件数据库
  (backend/research_colab.db), 保证系统无需数据库环境也能直接启动运行

提供:
- `engine`: 全局异步引擎 (自动选择 PostgreSQL/SQLite)
- `async_session_factory`: 异步会话工厂
- `get_db()`: FastAPI 依赖，用于请求级会话
- `init_db()`: 启动时建表 (生产环境建议改用 Alembic 迁移)
"""

import logging
from typing import AsyncGenerator, Optional

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import event

from config import settings

logger = logging.getLogger("uvicorn.error")


# ---------------------------------------------------------------------------
# ORM 声明基类：所有 models.py 中的模型继承此类
# ---------------------------------------------------------------------------
class Base(DeclarativeBase):
    """SQLAlchemy 2.0 声明式基类"""

    pass


# ---------------------------------------------------------------------------
# 数据库引擎创建 (PostgreSQL 优先, 失败回退 SQLite)
# ---------------------------------------------------------------------------
def _create_engine():
    """创建异步引擎。

    尝试连接 PostgreSQL；若不可用，则回退到 SQLite 文件数据库。
    """
    pg_url = settings.DATABASE_URL

    # 1. 尝试 PostgreSQL
    try:
        import asyncpg  # noqa: F401

        engine = create_async_engine(
            pg_url,
            echo=settings.DEBUG,
            pool_size=10,
            max_overflow=20,
            pool_pre_ping=True,
            connect_args={"timeout": 3},  # 3 秒连接超时，快速失败回退
        )

        # 启动时做一次真实连接测试
        import asyncio

        async def _probe() -> bool:
            try:
                async with engine.connect() as conn:
                    await conn.execute(__import__("sqlalchemy").text("SELECT 1"))
                return True
            except Exception:
                return False

        # 注意: 这里不能用 asyncio.run 如果事件循环已在运行。
        # 改为惰性检测: 在 init_db 时兜底
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop is None:
            # 模块导入时无事件循环，直接探测
            ok = asyncio.run(_probe())
            if ok:
                logger.info("📦 数据库连接: PostgreSQL @ %s", pg_url.rsplit("@", 1)[-1])
                return engine
            logger.warning("⚠️  PostgreSQL 不可用，回退到 SQLite 文件数据库")
        else:
            # 事件循环已在运行 (如 uvicorn 导入), 直接假定 PostgreSQL,
            # 真正的兜底在 init_db() 中执行
            logger.info("📦 数据库引擎: PostgreSQL (事件循环内惰性验证)")
            return engine

    except ImportError:
        logger.warning("⚠️  asyncpg 未安装，直接使用 SQLite 文件数据库")
    except Exception as exc:  # 连接失败等
        logger.warning("⚠️  PostgreSQL 连接失败 (%s)，回退到 SQLite", exc)

    # 2. 回退: SQLite 文件数据库
    sqlite_path = settings.SQLITE_PATH
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{sqlite_path}",
        echo=settings.DEBUG,
    )

    # SQLite 需要手动开启外键约束
    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    logger.info("🗄️  数据库连接: SQLite @ %s", sqlite_path)
    return engine


engine = _create_engine()

async_session_factory: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


# ---------------------------------------------------------------------------
# FastAPI 依赖注入
# ---------------------------------------------------------------------------
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    请求级数据库会话依赖。

    用法:
        @router.get("/documents")
        async def list_documents(db: AsyncSession = Depends(get_db)):
            ...
    """
    async with async_session_factory() as session:
        try:
            yield session
        finally:
            pass


# ---------------------------------------------------------------------------
# 初始化建表 (开发环境)
# ---------------------------------------------------------------------------
async def init_db() -> None:
    """
    根据 models.py 中定义的 ORM 模型创建所有表。

    若 PostgreSQL 连接失败 (首次真正使用连接时才暴露), 在此处兜底重建 SQLite 引擎。
    注意: 生产环境应使用 Alembic 迁移工具而非此函数。
    """
    global engine, async_session_factory

    # 延迟导入，确保 models 已注册到 Base.metadata
    import models  # noqa: F401  (触发模型注册)

    # 尝试建表; 失败则回退到 SQLite
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("✅ 数据库表创建/校验完成")
    except Exception as exc:
        # PostgreSQL 不可用 -> 切到 SQLite
        if engine.dialect.name == "postgresql":
            logger.warning("⚠️  PostgreSQL 建表失败 (%s)，回退到 SQLite 文件数据库", exc)

            sqlite_path = settings.SQLITE_PATH
            new_engine = create_async_engine(
                f"sqlite+aiosqlite:///{sqlite_path}",
                echo=settings.DEBUG,
            )

            @event.listens_for(new_engine.sync_engine, "connect")
            def _set_sqlite_pragma(dbapi_connection, connection_record):  # noqa: ANN001
                cursor = dbapi_connection.cursor()
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.close()

            engine = new_engine
            async_session_factory = async_sessionmaker(
                bind=engine,
                class_=AsyncSession,
                expire_on_commit=False,
                autoflush=False,
            )

            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            logger.info("✅ SQLite 数据库表创建完成 @ %s", sqlite_path)
        else:
            raise

    # 步骤 12 轻量迁移: 已有库补充每文档水印参数列 + 兼容旧约束
    # (create_all 不会给已存在的表增量加列, 需手动 ALTER)
    try:
        await _migrate_watermark_params()
    except Exception as exc:  # 迁移失败不阻断启动 (仅记录)
        logger.warning("⚠️  水印参数迁移失败 (不影响启动): %s", exc)


# ---------------------------------------------------------------------------
# 步骤 12: 每文档独立水印密钥/参数的轻量迁移
# ---------------------------------------------------------------------------
async def _migrate_watermark_params() -> None:
    """
    为已有数据库补齐 documents.watermark_key / watermark_gamma /
    watermark_delta 列, 并回填密钥; 同时扩展 op_logs 的 op_type 约束
    以允许 'watermark_params' (SQLite 需重建表, 先备份再迁移)。

    新库由 create_all 直接创建完整 schema, 本函数自动跳过已存在的结构。
    """
    from sqlalchemy import text

    from config import settings
    from services.watermark_engine import generate_secret_key  # noqa: F401

    is_sqlite = engine.dialect.name == "sqlite"

    async with engine.begin() as conn:
        # ---- 1. 补充列 ----
        if is_sqlite:
            cols = [
                row[1]
                for row in (
                    await conn.execute(text("PRAGMA table_info(documents)"))
                ).fetchall()
            ]
            for name, ddl in (
                ("watermark_key", "BLOB"),
                ("watermark_gamma", "FLOAT NOT NULL DEFAULT 0.5"),
                ("watermark_delta", "FLOAT NOT NULL DEFAULT 4.0"),
            ):
                if name not in cols:
                    await conn.execute(text(f"ALTER TABLE documents ADD COLUMN {name} {ddl}"))
        else:
            # PostgreSQL: IF NOT EXISTS 幂等
            for name, ddl in (
                ("watermark_key", "BYTEA"),
                ("watermark_gamma", "DOUBLE PRECISION NOT NULL DEFAULT 0.5"),
                ("watermark_delta", "DOUBLE PRECISION NOT NULL DEFAULT 4.0"),
            ):
                await conn.execute(
                    text(f"ALTER TABLE documents ADD COLUMN IF NOT EXISTS {name} {ddl}")
                )

        # ---- 2. 回填密钥: 已有文档沿用全局密钥 (兼容历史全局密钥水印内容);
        #        新文档由模型 default 自动生成独立随机密钥 ----
        await conn.execute(
            text(
                "UPDATE documents SET watermark_key = :k "
                "WHERE watermark_key IS NULL OR length(watermark_key) = 0"
            ),
            {"k": settings.WATERMARK_SECRET_KEY},
        )

        # ---- 3. SQLite: op_logs 表重建以扩展 op_type 约束 ----
        # SQLite 不支持 ALTER 改约束, 采用标准重建模式:
        #   备份 -> 按新 DDL 建表 -> 拷贝数据 -> 换名 -> 重建索引
        if is_sqlite:
            await _rebuild_op_logs_constraint(conn)


async def _rebuild_op_logs_constraint(conn) -> None:
    """将 op_logs 的 op_type 约束扩展为包含 'watermark_params' (SQLite)"""
    from sqlalchemy import text

    row = (
        await conn.execute(
            text("SELECT sql FROM sqlite_master WHERE type='table' AND name='op_logs'")
        )
    ).fetchone()
    if not row or not row[0]:
        return
    ddl: str = row[0]
    old = "('insert', 'delete', 'replace', 'ai_generate', 'watermark_checked')"
    new = "('insert', 'delete', 'replace', 'ai_generate', 'watermark_checked', 'watermark_params')"
    if "watermark_params" in ddl or old not in ddl:
        return  # 已是最新或结构未知, 跳过

    # 索引 DDL (重建后需手动恢复)
    idx_rows = (
        await conn.execute(
            text(
                "SELECT name, sql FROM sqlite_master "
                "WHERE type='index' AND name LIKE 'idx_oplogs_%' AND sql IS NOT NULL"
            )
        )
    ).fetchall()

    await conn.execute(text("PRAGMA foreign_keys=OFF"))
    await conn.execute(text("ALTER TABLE op_logs RENAME TO op_logs_legacy"))
    await conn.execute(text(ddl.replace(old, new)))
    await conn.execute(
        text(
            "INSERT INTO op_logs (id, doc_id, user_id, op_type, operation, "
            "prev_hash, current_hash, created_at) "
            "SELECT id, doc_id, user_id, op_type, operation, prev_hash, "
            "current_hash, created_at FROM op_logs_legacy"
        )
    )
    await conn.execute(text("DROP TABLE op_logs_legacy"))
    for name, sql in idx_rows:
        await conn.execute(text(sql))
    await conn.execute(text("PRAGMA foreign_keys=ON"))