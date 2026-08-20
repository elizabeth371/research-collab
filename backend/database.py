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
    sqlite_path = "./research_colab.db"
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

            sqlite_path = "./research_colab.db"
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