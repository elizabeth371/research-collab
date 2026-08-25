"""
AgentOrchestrator: 基于 LangGraph 的多 Agent 协同编排
=====================================================
工作流结构:

                 ┌────────────────────────────────────────┐
                 │            SupervisorAgent            │
                 │   (调度/决策/质量控制)                 │
                 └────────────────────────────────────────┘
                    │              │              │
             研究问题 │        写作任务│         审阅意见│
                    ▼              ▼              ▼
          ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
          │ResearchAgent│  │ WriterAgent │  │(可扩展)     │
          │ (文献检索)  │  │ (论文写作)  │  │ ManagerAgent│
          └─────────────┘  └─────────────┘  └─────────────┘
                    │              │              │
                    └──────────────┴──────────────┘
                                  │
                                  ▼
                    ┌──────────────────────────────┐
                    │  输出: 结构化内容 (写入 Yjs) │
                    └──────────────────────────────┘

技术要点:
- 使用 langgraph 的 StateGraph 构建有状态工作流
- State 定义统一数据流 (研究资料 -> 写作草稿 -> 评审结果)
- 各 Agent 节点为函数占位符, 保留完整签名与 TODO
- LLM 调用预留 DeepSeek / 通义千问 接口
"""

import asyncio
import re
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Literal, Optional, TypedDict

# 检索关键词过滤: 指令中的常见功能性/停用词, 不参与文献匹配
_SEARCH_STOPWORDS = {
    "帮我", "请", "检索", "搜索", "查找", "查询", "获取", "看看",
    "关于", "相关", "有关", "文献", "资料", "论文", "文章",
    "研究", "任务", "需要", "进行", "围绕", "主题", "方向",
    "的", "了", "和", "与", "及", "或", "等", "一些", "这个", "那个",
    "要", "请帮我", "基于", "结果", "引言", "我", "一段", "写一", "写",
    "审查", "当前", "草稿", "是否符合", "规范", "学术", "建议", "补充",
    "系统", "内容", "成果", "结合",
    # 英文研究动作/泛指词: 避免 "retrieve recent papers about X"
    # 这类指令让前 3 个关键词全落到泛词上, 挤掉真正的领域术语
    "retrieve", "retrieval", "retrieving", "search", "searching",
    "find", "finding", "look", "lookup", "query", "queries",
    "recent", "latest", "new", "novel", "current", "existing",
    "paper", "papers", "article", "articles", "literature",
    "review", "reviews", "survey", "surveys", "summarize", "summary",
    "summaries", "analyse", "analyze", "analysis", "study", "studies",
    "investigate", "investigation", "method", "methods", "technique",
    "techniques", "approach", "approaches", "based", "using", "use",
    "about", "regarding", "related", "relevant", "topic", "topics",
    "the", "and", "for", "on", "of", "in", "with", "from", "to", "a", "an",
    "research", "field", "domain", "work", "works", "advance", "advances",
    "development", "develop", "improve", "improving", "compare", "comparing",
    "introduce", "introduced", "propose", "proposed", "present", "presented",
}


def _extract_keywords(text: str) -> List[str]:
    """从自然语言指令中抽取用于文献检索的关键词。

    去除标点与停用词, 保留长度 >= 2 的中英文 token。
    抽取为空时退回整句 (子串匹配兜底)。
    """
    if not text:
        return []
    cleaned = re.sub(r"[^\w\s]", " ", text)
    tokens = [t.strip() for t in cleaned.split() if t.strip()]
    keywords: List[str] = []
    for t in tokens:
        if t.lower() in _SEARCH_STOPWORDS or t in keywords:
            continue
        if len(t) >= 2:
            keywords.append(t)
    return keywords or [text.strip()]

# ---------------------------------------------------------------------------
# LangGraph 导入 (需 pip install langgraph)
# ---------------------------------------------------------------------------
try:
    from langgraph.graph import StateGraph, END
    _LANGGRAPH_AVAILABLE = True
except ImportError:  # pragma: no cover
    _LANGGRAPH_AVAILABLE = False
    StateGraph = None
    END = None

    # 占位定义 (保证模块可导入)
    class StateGraph:  # type: ignore
        def __init__(self, state_schema): ...


# ---------------------------------------------------------------------------
# Agent 类型枚举
# ---------------------------------------------------------------------------
class AgentType(str, Enum):
    """Agent 类型"""

    RESEARCH = "research"
    WRITER = "writer"
    SUPERVISOR = "supervisor"


class AgentStatus(str, Enum):
    """Agent 运行状态"""

    IDLE = "idle"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


# ---------------------------------------------------------------------------
# LangGraph State 定义
# ---------------------------------------------------------------------------
class State(TypedDict, total=False):
    """
    LangGraph 图状态的统一 schema。

    字段说明:
      doc_id:          目标文档 ID
      session_id:      Agent 会话 ID
      research_input:  研究任务输入 (给 ResearchAgent)
      research_output: 研究结果 (结构化文献/资料)
      writing_task:    写作任务输入 (给 WriterAgent)
      draft:           写作草稿
      supervisor_feedback: 监督审阅意见
      final_output:    最终输出 (将写入 Yjs)
      messages:        消息历史 (供前端流式回放)
      status:          当前整体状态
      metadata:        附加元数据 (模型名称/耗时等)
    """

    doc_id: str
    session_id: str
    research_input: Optional[str]
    research_output: Optional[str]
    writing_task: Optional[str]
    draft: Optional[str]
    supervisor_feedback: Optional[str]
    final_output: Optional[str]
    messages: List[Dict[str, Any]]
    status: str
    metadata: Dict[str, Any]


# ---------------------------------------------------------------------------
# 节点函数: 三个 Agent
# ---------------------------------------------------------------------------
async def research_agent_node(state: State) -> Dict[str, Any]:
    """
    ResearchAgent 节点 (文献检索与研究):
    - 接收 research_input (研究命题/问题)
    - 优先从 arXiv API 实时检索真实论文 (科研信息源头);
      网络不可用时降级到本地 literature 表 (关键词匹配);
    - 汇总为 research_output (检索结果 + 综述建议)

    TODO:
      - 调用 DeepSeek / 通义千问 进行文献综述生成
    """
    print(f"[ResearchAgent] 接收到研究任务: {state.get('research_input', '')}")

    keyword = (state.get("research_input") or "").strip()
    keywords = _extract_keywords(keyword)
    retrieved: List[str] = []
    source = ""

    # ---- 1. arXiv 实时检索 (优先) ----
    try:
        from services.arxiv_client import search_arxiv

        # arXiv 仅支持英文检索: 只用 ASCII 关键词, AND 收紧相关性
        ascii_kws = [kw for kw in keywords if kw.isascii()]
        if ascii_kws:
            query = " AND ".join(f'all:"{kw}"' for kw in ascii_kws[:3])
        else:
            query = None
        arxiv_items = await search_arxiv(query, max_results=5) if query else []
        if arxiv_items:
            retrieved = [
                f"- ({it['year']}) {it['authors']}《{it['title']}》[{it['source']}]"
                for it in arxiv_items
            ]
            source = "arXiv 实时检索"
    except Exception as e:  # 网络不可用/超时/解析失败 -> 降级
        print(f"[ResearchAgent] arXiv 检索不可用 ({type(e).__name__}: {e}), 降级本地文献库")

    # ---- 2. 本地文献库降级 (无网络/无 arXiv 结果时) ----
    if not retrieved:
        try:
            from sqlalchemy import or_, select

            from database import async_session_factory
            from models import Literature

            async with async_session_factory() as db:
                stmt = select(Literature).order_by(Literature.year.desc()).limit(5)
                if keywords:
                    # 任一词命中即召回 (宽松匹配, 保证演示链路可检索到真实文献)
                    conds = [
                        or_(
                            Literature.title.ilike(f"%{kw}%"),
                            Literature.abstract.ilike(f"%{kw}%"),
                            Literature.keywords.ilike(f"%{kw}%"),
                        )
                        for kw in keywords
                    ]
                    stmt = stmt.where(or_(*conds))
                lits = (await db.execute(stmt)).scalars().all()
            retrieved = [
                f"- ({l.year}) {l.authors}《{l.title}》[{l.source}]"
                for l in lits
            ]
            source = "本地文献库"
        except Exception as e:  # pragma: no cover - 检索失败不阻断流程
            print(f"[ResearchAgent] 文献检索失败: {e}")

    if retrieved:
        research_output = (
            f"【文献检索结果 · 来源: {source}】\n"
            + "\n".join(retrieved)
            + "\n【综述建议】\n"
            + f"围绕『{keyword or '协同科研'}』主题, 上述文献覆盖了水印算法、"
            "CRDT 协同与多 Agent 编排等关键技术方向, 可作为论文核心章节的引用来源。"
        )
    else:
        # 兜底: 无检索结果时给出模拟研究结论 (保证演示链路完整)
        research_output = (
            "【模拟研究结果】\n"
            "1. Kirchenbauer et al. (2023) 提出绿名单水印方案。\n"
            "2. Yjs CRDT 技术可实现低延迟多端协同。\n"
            "3. LangGraph 适合构建可编排的多 Agent 工作流。\n"
        )

    return {
        "research_output": research_output,
        "status": AgentStatus.COMPLETED.value,
        "messages": [
            *state.get("messages", []),
            {
                "role": "agent",
                "agent": AgentType.RESEARCH.value,
                "content": research_output,
            },
        ],
    }


async def writer_agent_node(state: State) -> Dict[str, Any]:
    """
    WriterAgent 节点 (论文写作):
    - 接收 research_output + writing_task
    - 优先调用 LLM (OpenAI 兼容协议) 生成真实学术草稿;
      未配置 API Key / 调用失败时降级到模拟草稿模板 (离线可演示)
    - 输出 draft (将经 StreamBufferService 以 author=ai-agent 写入 Yjs)

    关键: 生成结果将通过 StreamBufferService 原子写入 Yjs,
          且前景字体为蓝色 (作者属性 author=ai-agent)。
    """
    print(f"[WriterAgent] 基于研究结果起草: {state.get('writing_task', '')}")

    await asyncio.sleep(0.1)  # 统一最小耗时, 保证前端流转可感知

    research = state.get("research_output", "")
    task = (state.get("writing_task") or "").strip()
    engine = "rule"
    draft: Optional[str] = None

    # ---- 1. LLM 真实生成 (可插拔, 无 key 自动跳过) ----
    try:
        from services.llm_client import llm_client

        if llm_client.is_available():
            draft = await llm_client.write_draft(task, research)
    except Exception as e:  # pragma: no cover - LLM 失败不阻断流程
        print(f"[WriterAgent] LLM 草稿生成失败 ({type(e).__name__}: {e}), 降级模板")

    # ---- 2. 规则/模板降级 ----
    if draft:
        engine = "llm"
    else:
        draft = (
            "【模拟写作草稿 · 规则模式】\n"
            f"基于以下研究背景，本文提出面向科研诚信的多Agent协同框架：\n{research}\n"
            "系统结合 Yjs 实时协同与 Kirchenbauer 水印技术，"
            "实现 AI 生成内容可信溯源。"
        )

    return {
        "draft": draft,
        "status": AgentStatus.COMPLETED.value,
        "metadata": {**(state.get("metadata") or {}), "writer_engine": engine},
        "messages": [
            *state.get("messages", []),
            {
                "role": "agent",
                "agent": AgentType.WRITER.value,
                "content": draft,
            },
        ],
    }


async def supervisor_agent_node(state: State) -> Dict[str, Any]:
    """
    SupervisorAgent 节点 (导师审稿 / 质量控制):
    - 汇总 research_output + draft
    - 调用 AcademicReviewEngine 执行学术规范静态检查
      (红牌/黄牌分级 + 段落定位, 覆盖引用格式/编号连续性/参考文献/篇幅/论据支撑)
    - 输出结构化评审意见 (红牌=error 级, 黄牌=warning 级)

    TODO:
      - 接入 LLM 语义评审
      - 调用 WatermarkEngine 检测 AI 内容比例
    """
    print("[SupervisorAgent] 正在审阅研究成果与草稿...")

    from services.academic_review import AcademicReviewEngine

    draft = state.get("draft", "")
    review = AcademicReviewEngine.review_document(draft)
    stats = review["stats"]
    red = review["red_cards"]
    yellow = review["yellow_cards"]

    if review["passed"]:
        extra = f" (另 {yellow} 条黄牌建议)" if yellow else ""
        feedback = (
            f"【导师审稿意见】✅ 通过。草稿 {stats['chars']} 字 / "
            f"{stats['paragraphs']} 段, 引用编号 {len(stats['citation_numbers'])} 处, "
            f"学术格式基本规范, 无红牌问题{extra}。"
        )
    else:
        red_msgs = [i["message"] for i in review["issues"] if i["level"] == "error"]
        yellow_msgs = [i["message"] for i in review["issues"] if i["level"] == "warning"]
        detail = "；".join(red_msgs) or "；".join(yellow_msgs)
        feedback = (
            f"【导师审稿意见】❌ 红牌 {red} 项 / 黄牌 {yellow} 项, 需修改: {detail}"
        )

    # ---- 模拟评审结论 ----
    return {
        "supervisor_feedback": feedback,
        "final_output": draft,
        "status": AgentStatus.COMPLETED.value,
        "messages": [
            *state.get("messages", []),
            {
                "role": "agent",
                "agent": AgentType.SUPERVISOR.value,
                "content": feedback,
            },
        ],
    }


# ---------------------------------------------------------------------------
# 路由函数 (条件边)
# ---------------------------------------------------------------------------
def should_retry(state: State) -> Literal["writer", "supervisor"]:
    """
    监督决策路由:
    - 若反馈包含 "重写"/"驳回" 关键字 => 回到 WriterAgent
    - 否则 => 完成 (图结束)
    """
    feedback = state.get("supervisor_feedback", "")
    if any(kw in feedback for kw in ("重写", "驳回", "打回")):
        return "writer"
    return "supervisor"  # 默认结束


# ---------------------------------------------------------------------------
# 图构建器
# ---------------------------------------------------------------------------
def build_agent_graph() -> Any:
    """
    构建 LangGraph 状态图。

    节点:
      research   -> writer -> supervisor -> END
                    ^                      |
                    |______(条件重写)_______|

    Returns:
        Compiled Graph (可调用的 agent 应用)
    """
    if not _LANGGRAPH_AVAILABLE:
        # 降级: 返回一个可用的同步占位图 (保证后端可启动)
        class _FallbackGraph:
            async def ainvoke(self, inputs: dict) -> dict:
                """模拟图执行 (无 langgraph 时的降级)"""
                state: State = {**inputs, "messages": [], "status": "idle"}
                # 顺序执行三个节点
                state.update(await research_agent_node(state))
                state.update(await writer_agent_node(state))
                state.update(await supervisor_agent_node(state))
                state["status"] = AgentStatus.COMPLETED.value
                return state

        print("[AgentOrchestrator] langgraph 未安装, 使用降级顺序图")
        return _FallbackGraph()

    # ---- 正式构建 LangGraph ----
    graph = StateGraph(State)

    # 添加节点
    graph.add_node("research", research_agent_node)
    graph.add_node("writer", writer_agent_node)
    graph.add_node("supervisor", supervisor_agent_node)

    # 添加边: research -> writer -> supervisor
    graph.add_edge("research", "writer")
    graph.add_edge("writer", "supervisor")

    # 条件边: supervisor 根据反馈决定重写或结束
    graph.add_conditional_edges(
        "supervisor",
        should_retry,
        {
            "writer": "writer",        # 打回重写
            "supervisor": END,          # 完成
        },
    )

    # 入口
    graph.set_entry_point("research")

    return graph.compile()


# ---------------------------------------------------------------------------
# 编排服务 (对外门面)
# ---------------------------------------------------------------------------
class OrchestratorService:
    """
    Agent 编排服务:
    - 维护会话 (session)
    - 构建/复用 LangGraph
    - 提供 start_session 入口
    """

    def __init__(self) -> None:
        self._graph = build_agent_graph()
        self._sessions: Dict[str, Dict[str, Any]] = {}

    async def start_session(
        self,
        *,
        doc_id: str,
        agent_type: AgentType,
        instruction: str,
        session_id: Optional[str] = None,
    ) -> str:
        """
        启动一个新的 Agent 会话 (或复用群聊会话继续多轮追问)。

        Args:
            doc_id:       目标文档 ID
            agent_type:   触发的 Agent 类型
            instruction:  给 Agent 的指令
            session_id:   可选。传入已存在的会话 ID 时, 复用该会话的消息历史,
                          三个节点把新消息追加到既有历史 (同一线程内多轮对话);
                          未传或不存在时创建新会话。

        Returns:
            session_id (UUID 字符串)

        TODO:
          - 实际运行时: 创建 asyncio.Task 后台执行图,
            StreamBufferService 将结果写入 Yjs 并推送 WebSocket
          - 此处为骨架: 直接同步执行图并更新会话状态
        """
        # 群聊会话复用: 继承既有消息历史 (节点以 *state.get("messages") 追加)
        if session_id and session_id in self._sessions:
            prev_messages = (
                self._sessions[session_id].get("state", {}).get("messages", [])
            )
        else:
            session_id = str(uuid.uuid4())
            prev_messages = []

        # 构建初始 State
        initial_state: State = {
            "doc_id": doc_id,
            "session_id": session_id,
            "research_input": instruction,
            "writing_task": instruction,
            "messages": prev_messages,
            "status": AgentStatus.RUNNING.value,
            "metadata": {"model": "deepseek-v3"},  # TODO: 可配置
        }

        self._sessions[session_id] = {
            "doc_id": doc_id,
            "agent_type": agent_type,
            "status": AgentStatus.RUNNING.value,
            "state": initial_state,
        }

        # 骨架: 同步执行图 (生产环境改为后台任务 + WebSocket 推送)
        final_state = await self._graph.ainvoke(initial_state)

        self._sessions[session_id].update(
            {
                "status": final_state.get("status", AgentStatus.COMPLETED.value),
                "state": final_state,
            }
        )

        # TODO: 将 final_output 通过 StreamBufferService 写入 Yjs 文档
        #       并广播至 /ws/{doc_id} 的客户端

        return session_id

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """查询会话状态"""
        return self._sessions.get(session_id)

    def list_sessions(self) -> List[Dict[str, Any]]:
        """列出所有会话摘要"""
        return [
            {
                "session_id": sid,
                "doc_id": s["doc_id"],
                "agent_type": s["agent_type"],
                "status": s["status"],
            }
            for sid, s in self._sessions.items()
        ]