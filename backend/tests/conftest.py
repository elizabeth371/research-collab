"""
pytest 共享配置
================
- 在会话开始前初始化数据库表与种子数据 (等价于 uvicorn lifespan,
  因为 httpx ASGITransport 不会自动触发 FastAPI lifespan)。
"""

import pytest


@pytest.fixture(scope="session", autouse=True)
def _init_backend():
    """初始化数据库 (建表 + 演示数据 + 文献种子), 供全部测试使用"""
    import asyncio

    import main
    from database import init_db

    async def _setup():
        await init_db()
        await main.seed_demo_data()
        await main.seed_literature()

    asyncio.run(_setup())
    yield
    # 清理测试自产文档 (test_api_integration 以 "测试文档-" 前缀创建独立文档,
    # 测试结束不删除, 若不清理会持续污染真实演示数据库)
    _cleanup_test_docs()


def _cleanup_test_docs():
    """删除本次会话残留的 '测试文档-' 前缀文档及其关联记录"""
    import asyncio

    from database import async_session_factory

    async def _cleanup():
        from sqlalchemy import delete, select

        import models  # noqa: F401

        async with async_session_factory() as session:
            result = await session.execute(
                select(models.Document.id).where(
                    models.Document.title.like("测试文档-%")
                )
            )
            ids = [row[0] for row in result.fetchall()]
            if not ids:
                return
            for table in (
                models.OpLog,
                models.WatermarkRecord,
                models.Comment,
                models.DocumentCollaborator,
                models.PermissionConfig,
            ):
                await session.execute(
                    delete(table).where(table.doc_id.in_(ids))
                    if table is not models.DocumentCollaborator
                    else delete(table).where(table.document_id.in_(ids))
                )
            await session.execute(
                delete(models.Document).where(models.Document.id.in_(ids))
            )
            await session.commit()

    asyncio.run(_cleanup())
