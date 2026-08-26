"""
FastAPI 应用入口
=================
- 配置 CORS 中间件
- 挂载 REST API 路由
- 挂载 Yjs WebSocket 协同端点 (/ws/{doc_id})

启动:
    uvicorn main:app --reload --host 0.0.0.0 --port 8000
"""

import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from api import agents as agents_api
from api import chat as chat_api
from api import comments as comments_api
from api import documents as documents_api
from api import literature as literature_api
from api import watermark as watermark_api
from config import settings
from database import init_db
from websocket.document_ws import collaborative_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    应用生命周期管理:
    - 启动: 初始化数据库表 (开发环境)
    - 关闭: 释放资源 (数据库连接池由 engine 自动管理)
    """
    # 启动时创建数据库表 (骨架阶段; 生产环境建议使用 Alembic)
    await init_db()

    # 初始化演示数据 (用户 + 默认文档), 保证前端开箱即用
    await seed_demo_data()
    # 初始化文献种子语料 (调研 Agent 检索库)
    await seed_literature()

    yield

    # 关闭时清理 (预留)
    pass


# ---------------------------------------------------------------------------
# 演示数据初始化: 固定 UUID, 前端通过 /api/bootstrap 获取
# ---------------------------------------------------------------------------
DEMO_USER_ID = uuid.UUID("00000000-0000-4000-8000-000000000001")
DEMO_DOC_ID = uuid.UUID("00000000-0000-4000-8000-0000000000a1")


async def seed_demo_data() -> None:
    """若演示用户/文档不存在则创建 (幂等)"""
    from models import Document, User
    from database import async_session_factory

    async with async_session_factory() as db:
        user = await db.get(User, DEMO_USER_ID)
        if user is None:
            user = User(
                id=DEMO_USER_ID,
                username="demo-researcher",
                email="demo@research.local",
                display_name="演示研究员",
                role="researcher",
            )
            db.add(user)

        # 演示协作用户 (权限管理/协作者选择用, 幂等)
        demo_collabs = [
            (
                "00000000-0000-4000-8000-0000000000b1",
                "teacher-zhao",
                "zhao@chd.edu.cn",
                "赵老师(导师)",
                "collaborator",
            ),
            (
                "00000000-0000-4000-8000-0000000000b2",
                "li-jingwen",
                "li@chd.edu.cn",
                "李静雯",
                "collaborator",
            ),
            (
                "00000000-0000-4000-8000-0000000000b3",
                "sun-xitong",
                "sun@chd.edu.cn",
                "孙希彤",
                "collaborator",
            ),
        ]
        for uid, uname, uemail, dname, urole in demo_collabs:
            uid_obj = uuid.UUID(uid)
            if await db.get(User, uid_obj) is None:
                db.add(
                    User(
                        id=uid_obj,
                        username=uname,
                        email=uemail,
                        display_name=dname,
                        role=urole,
                    )
                )

        doc = await db.get(Document, DEMO_DOC_ID)
        if doc is None:
            doc = Document(
                id=DEMO_DOC_ID,
                title="演示文档 · 多Agent协同科研编辑",
                owner_id=DEMO_USER_ID,
                content="欢迎来到智溯协同编辑器。左侧可触发 Agent, 右侧可直接编辑。",
            )
            db.add(doc)

        await db.commit()


# ---------------------------------------------------------------------------
# 文献种子语料: 覆盖水印算法 / CRDT 协同 / 多 Agent / 科研诚信等主题
# ---------------------------------------------------------------------------
_SEED_LITERATURE: list[dict] = [
    {
        "title": "A Watermark for Large Language Models",
        "authors": "Kirchenbauer J, Geiping J, Wen Y",
        "year": 2023,
        "source": "arXiv:2301.10226",
        "abstract": "提出基于绿名单的文本水印方案, 通过约束 LLM 解码过程在生成文本中嵌入可检测标记, 无需修改模型参数即可追溯 AI 生成内容来源。",
        "keywords": "watermark, large language model, AIGC, green list",
        "url": "https://arxiv.org/abs/2301.10226",
    },
    {
        "title": "Yjs: A Framework for Near Real-Time Peer-to-Peer Shared Editing on Arbitrary Data Types",
        "authors": "Jahns P",
        "year": 2021,
        "source": "arXiv:2102.12943",
        "abstract": "介绍 Yjs CRDT 框架: 基于冲突无关复制数据类型实现多端实时协同编辑, 无需中心服务器协调, 支持文本与富文本结构。",
        "keywords": "CRDT, Yjs, real-time collaboration, peer-to-peer",
        "url": "https://arxiv.org/abs/2102.12943",
    },
    {
        "title": "Multi-Agent Systems for Scientific Research: A Survey",
        "authors": "Wang L, Zhang X, Chen R",
        "year": 2024,
        "source": "arXiv:2403.07128",
        "abstract": "综述多智能体系统在科研场景的应用: 文献调研、实验设计、论文撰写与审稿等环节的自动化, 讨论协作框架与一致性保证。",
        "keywords": "multi-agent, LLM, scientific research, survey",
        "url": "https://arxiv.org/abs/2403.07128",
    },
    {
        "title": "Provenance for the Web: Trustworthy Computing Chains",
        "authors": "Moreau L, Groth P",
        "year": 2013,
        "source": "W3C PROV",
        "abstract": "提出基于哈希链与声明式规则的数据溯源模型, 为版权归属、内容演化与可信计算提供形式化基础。",
        "keywords": "provenance, hash chain, trust, authorship",
        "url": "https://www.w3.org/TR/prov-overview/",
    },
    {
        "title": "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
        "authors": "Lewis P, Perez E, Piktus A",
        "year": 2020,
        "source": "NeurIPS 2020",
        "abstract": "提出 RAG 框架: 结合检索器与生成器, 使模型从外部知识库检索证据支撑生成, 显著提升知识密集型任务的事实准确性。",
        "keywords": "RAG, retrieval, knowledge, generation",
        "url": "https://arxiv.org/abs/2005.11401",
    },
    {
        "title": "A Survey on Collaborative Editing Systems and CRDTs",
        "authors": "Nedelec B, Molli P, Mostefaoui A",
        "year": 2015,
        "source": "arXiv:1507.03967",
        "abstract": "系统梳理协同编辑技术演进: OT 与 CRDT 两大路线, 分析并发操作收敛性与离线编辑支持, 是分布式协同的经典综述。",
        "keywords": "collaborative editing, CRDT, OT, concurrency",
        "url": "https://arxiv.org/abs/1507.03967",
    },
    {
        "title": "On the Risks of LLM-Generated Content and Detection Methods",
        "authors": "Liu X, Wang Y, Li H",
        "year": 2024,
        "source": "arXiv:2402.04667",
        "abstract": "分析大模型生成内容在学术诚信场景中的风险 (造假、洗稿、代写), 综述文本水印、统计检测与元数据方案的能力边界。",
        "keywords": "AIGC, academic integrity, watermark, detection",
        "url": "https://arxiv.org/abs/2402.04667",
    },
    {
        "title": "Fast and Accurate Real-Time Collaboration with Yjs",
        "authors": "Jahns P",
        "year": 2022,
        "source": "Yjs Documentation",
        "abstract": "阐述 Yjs 的二进制同步协议 (y-websocket) 与状态快照机制, 面向工程实践的协同性能优化指南。",
        "keywords": "Yjs, y-websocket, sync protocol, binary",
        "url": "https://docs.yjs.dev/",
    },
]


async def seed_literature() -> None:
    """若文献表为空则写入种子语料 (幂等)"""
    from models import Literature
    from database import async_session_factory

    async with async_session_factory() as db:
        existing = (await db.execute(select(Literature).limit(1))).scalar_one_or_none()
        if existing is not None:
            return
        for item in _SEED_LITERATURE:
            db.add(Literature(**item))
        await db.commit()


# ---------------------------------------------------------------------------
# 创建应用
# ---------------------------------------------------------------------------
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="面向科研诚信的多Agent实时协同与版权溯源系统",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# CORS 中间件: 允许前端跨域访问
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# 注册 REST API 路由
# ---------------------------------------------------------------------------
app.include_router(documents_api.router)
app.include_router(comments_api.router)
app.include_router(agents_api.router)
app.include_router(watermark_api.router)
app.include_router(literature_api.router)
app.include_router(chat_api.router)

# ---------------------------------------------------------------------------
# 注册 WebSocket 协同路由 (Yjs)
#   - WebSocket 端点: /ws/{doc_id}
#   - 同时也挂载 y-websocket 的 /yjs 心跳/就绪检查
# ---------------------------------------------------------------------------
app.include_router(collaborative_router)

# 注册 WebSocket 聊天路由 (步骤 16): /ws/chat/{doc_id}
from websocket.chat_ws import chat_router

app.include_router(chat_router)


# ---------------------------------------------------------------------------
# 健康检查
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health_check() -> dict:
    """服务健康检查端点"""
    return {
        "status": "ok",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
    }


@app.get("/api/bootstrap")
async def bootstrap() -> dict:
    """前端初始化数据: 演示用户与文档 (前端启动时调用一次)"""
    from sqlalchemy import select

    from database import async_session_factory
    from models import Document

    async with async_session_factory() as db:
        docs = (
            await db.execute(select(Document).order_by(Document.updated_at.desc()))
        ).scalars().all()
        return {
            "demo_user_id": str(DEMO_USER_ID),
            "demo_doc_id": str(DEMO_DOC_ID),
            "documents": [
                {
                    "id": str(d.id),
                    "title": d.title,
                    "owner_id": str(d.owner_id),
                    "content": d.content,
                    "watermark_status": d.watermark_status,
                    "created_at": d.created_at.isoformat(),
                    "updated_at": d.updated_at.isoformat(),
                }
                for d in docs
            ],
        }


@app.get("/")
async def root() -> dict:
    """根路径, 便于浏览器确认服务已启动"""
    return {
        "service": settings.APP_NAME,
        "docs": "/docs",
        "health": "/api/health",
        "websocket": "/ws/{doc_id}",
    }