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
