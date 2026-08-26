# 面向科研诚信的多Agent实时协同与版权溯源系统

> 智溯 · 多智能体协同科研编辑与 AIGC 可信溯源原型系统
>
> Multi-Agent Collaboration & AIGC Provenance

## 架构概览

```
┌─────────────────────┐        ┌──────────────────────────────────────┐
│      Frontend       │  HTTP  │               Backend                │
│  React 18 + Vite    │ ─────► │      FastAPI + SQLAlchemy(async)     │
│  Tiptap + Yjs       │        │                                      │
│  y-websocket        │        │  /api/documents     文档 CRUD        │
│  (多光标协同)        │        │  /api/agents        Agent 编排触发    │
└─────────┬───────────┘        │  /api/watermark     Kirchenbauer 水印│
          │  WebSocket         │  /api/watermark/.../provenance 溯源链 │
          └───────────────────►│──────────────┬───────────────────────┘
                               │  /ws/{doc_id} │ LangGraph 编排
                               │  (纯转发模式)  │  Research/Writer/
                               └───────┬──────┴  Supervisor
                                       │
                               ┌───────▼────────┐
                               │  SQLite (回退)  │
                               │  / PostgreSQL  │
                               └────────────────┘
```

- **前端**: React 18 + TypeScript + Vite 5 + TailwindCSS, Tiptap 编辑器通过
  `@tiptap/extension-collaboration` 接入 Yjs CRDT, `y-websocket` 负责实时同步,
  `y-protocols/awareness` 实现多光标。
- **后端**: FastAPI + SQLAlchemy(async)。WebSocket 端点为**纯转发模式**——
  服务端不持有 CRDT 状态, 只维护房间连接列表并按 y-websocket 协议转发
  增量更新与 awareness, 客户端之间直接收敛。
- **数据库**: 优先 PostgreSQL(asyncpg), 未安装时自动回退 SQLite(aiosqlite),
  无需任何数据库环境即可运行。

## 功能清单 (开发路线图 1-15 全达成)

| # | 步骤 | 状态 | 说明 |
|---|------|------|------|
| 1 | 文档 CRUD + 协同编辑 | ✅ | Tiptap + Yjs CRDT + y-websocket 纯转发, 多光标实时同步 |
| 2 | 多 Agent 编排 | ✅ | LangGraph 编排 Research / Writer / Supervisor (可切换纯规则) |
| 3 | 写稿润色 + 审稿红牌 | ✅ | 规则引擎润色 (学术措辞/标点归一) + 红牌/黄牌段落级审稿 |
| 4 | 哈希链溯源 | ✅ | 每个操作写入 OpLog 并 SHA-256 前后哈希链接, 可逐条校验 |
| 5 | 编辑器内 AI/人类着色 | ✅ | AI 生成内容蓝色标记, 插入走编辑器事务自动进溯源链 |
| 6 | 学术审查 | ✅ | 断言词/引用/篇幅/口语化密度分级审稿 |
| 7 | 文献检索与引用 | ✅ | arXiv API 实时检索 + BibTeX 引用插入 |
| 8 | 文档导出 | ✅ | Markdown + 溯源元数据头 |
| 9 | LLM 水印注入 | ✅ | DeepSeek logprobs 重采样 + Kirchenbauer 绿名单 (z>4 检出) |
| 10 | 编辑器内水印可视化闭环 | ✅ | 生成→自检→插入→全文检测留痕 全链路 |
| 11 | 对抗鲁棒性实验 | ✅ | 6 类攻击矩阵 + 真实机器翻译回译, 论文实验数据 |
| 12 | 每文档独立水印密钥 | ✅ | 密钥/γ/δ 可配置可重建, 变更留痕, 跨文档密钥隔离 |
| 13 | 版权证据包导出 | ✅ | PDF / Markdown / JSON 三格式 + package_hash 完整性校验 |
| 14 | Docker 部署 + 中文文档 | ✅ | 一键 compose 起前后端, SQLite 数据卷持久化 |
| 15 | 版本回溯 + 权限管理 | ✅ | 自动版本快照/一键恢复(溯源链留痕) + 协作模式/水印策略/导出策略/协作者管理 |

## 目录结构

```
.
├── frontend/                     # React 客户端
│   ├── src/
│   │   ├── components/
│   │   │   ├── Editor/CollaborativeEditor.tsx   # Yjs+Tiptap 协同编辑器(多光标/作者着色)
│   │   │   ├── Agent/AgentPanel.tsx             # 多 Agent 交互面板
│   │   │   ├── Watermark/WatermarkPanel.tsx     # 水印检测面板(留痕记录)
│   │   │   ├── Provenance/ProvenancePanel.tsx   # 版权溯源链面板
│   │   │   └── Literature/LiteraturePanel.tsx   # 文献检索/插入引用面板
│   │   ├── lib/
│   │   │   ├── api.ts                           # 后端 REST 客户端
│   │   │   ├── collab.ts                        # Y.Doc/Provider 单例缓存(连接复用)
│   │   │   └── yjs.ts                           # Yjs 文本提取/作者着色工具
│   │   ├── App.tsx / main.tsx / index.css
│   │   └── vite-env.d.ts / vite.config.ts / tailwind.config.js
│   └── package.json
│
├── backend/                      # FastAPI 服务端
│   ├── main.py                   # 应用入口 + CORS + 启动初始化(建表/种子数据)
│   ├── config.py                 # 环境配置
│   ├── database.py               # SQLAlchemy 连接(PostgreSQL→SQLite 回退)
│   ├── models.py                 # ORM 模型 (User/Document/OpLog/WatermarkRecord/Literature/PermissionConfig)
│   ├── api/
│   │   ├── documents.py          # 文档 CRUD + yjs-state + Markdown 导出
│   │   ├── agents.py             # Agent 触发/会话状态/消息
│   │   ├── watermark.py          # 水印检测(含文档留痕) + 溯源链
│   │   └── literature.py         # 文献检索/引文生成 (GB/T 7714 + BibTeX)
│   ├── services/
│   │   ├── agent_orchestrator.py # 多 Agent 编排 (Research arXiv/本地检索 / Writer / Supervisor 学术审查)
│   │   ├── watermark_engine.py   # Kirchenbauer 水印 (论文级实现, 源自 lm-watermarking Apache-2.0)
│   │   ├── arxiv_client.py       # arXiv API 实时文献检索 (无网络时自动降级)
│   │   ├── academic_review.py    # 学术规范静态审查引擎 (导师 Agent 规则)
│   │   ├── stream_buffer.py      # LLM 流式缓冲 → Yjs 原子插入 (预留)
│   │   └── oplog_chain.py        # 操作日志 SHA-256 哈希链
│   ├── tests/                    # pytest 单元/集成测试 (29 用例)
│   │   ├── test_oplog_chain.py
│   │   ├── test_watermark_engine.py
│   │   ├── test_academic_review.py
│   │   └── test_api_integration.py
│   └── websocket/
│       └── document_ws.py        # /ws/{doc_id} y-websocket 协议端点(纯转发)
│
├── THIRD_PARTY/                  # 第三方开源代码许可证
│   └── LICENSE-lm-watermarking.txt   # Apache-2.0 全文 (水印算法来源)
│
├── THIRD_PARTY_NOTICES.md        # 开源代码来源与合规声明
│
├── docs/
│   ├── 软件说明书.md              # 软件版权说明书 (功能/操作/开源许可/版本)
│   ├── 测试报告.md                # 测试报告 (审查结论/环境/结果/修复记录)
│   ├── 测试样例.md                # 测试样例集 (TC-01~25 具体输入与期望输出)
│   └── 测试工作流.md              # 分步测试工作流 (环境/功能/异常/验收检查表)
│
├── database/
│   └── init.sql                  # PostgreSQL 建表脚本(可选)
│
└── shared/
    └── types.ts                  # 前后端共享 TS 类型
```

## 快速启动

### 1. 后端

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux

pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

首次启动会自动建表并写入演示用户与演示文档(通过 `/api/bootstrap` 暴露)。
无需安装 PostgreSQL——服务会自动回退到 SQLite。

### 2. 前端

```bash
cd frontend
npm install
npm run dev
```

访问 `http://localhost:5173` (Vite 已配置代理 `/api` 与 `/ws` → `localhost:8000`)。

> 生产构建: `npm run build` (tsc 类型检查 + vite build)。


### 3. Docker 一键部署 (推荐演示环境)

```bash
# 仓库根目录
docker compose up -d --build
```

- 前端: `http://localhost` (Nginx 托管静态资源, 自动反代 `/api` 与 `/ws`)
- 后端健康检查: `http://localhost:8000/api/health`
- 首次启动自动建表并写入演示文档; SQLite 数据持久化在命名卷 `backend-data`
- 配置 DeepSeek API Key: 在仓库根 `.env` 写 `LLM_API_KEY=sk-...` 后重启,
  或 `LLM_API_KEY=sk-... docker compose up -d --build`
- 详细部署说明见 `docs/DEPLOYMENT.md`

> 前端镜像构建上下文为仓库根目录 (共享类型 `@shared` 位于 frontend 之外),
> 请勿使用 `docker build frontend/` 单独构建前端。

## 核心机制说明

### 协同编辑 (Yjs CRDT + WebSocket 纯转发)

前端通过 `y-websocket` 连接 `/ws/{doc_id}`, 后端 `document_ws.py` 实现
y-websocket 服务端协议, 消息首字节为类型:

| 类型 | 名称       | 说明                                   |
|------|-----------|----------------------------------------|
| 0x00 | SYNC      | CRDT 状态同步 (step1/step2/update)     |
| 0x01 | AWARENESS | 光标/在线状态 (多光标)                  |
| 0x02 | AUTH      | 鉴权 (预留)                            |

协议关键细节(与 y-websocket 客户端保持一致, 是本项目踩坑修复后的正确实现):

- update / state vector 以 **varUint8Array** 编码: `[varUint(len), bytes...]`
  (LEB128 变长长度前缀), 不能裸发字节。
- **空 update 必须编码为 `[0x00, 0x00]`**(delete 集与插入集长度均为 0),
  0 字节或单字节 `[0x00]` 都会让客户端 `applyUpdate` 抛
  `Unexpected end of array`。
- SYNC_STEP1: 客户端发状态向量 → 服务端回复空 update
  (`00 01 02 00 00`), 客户端进入 synced 状态。
- SYNC_STEP2 / SYNC_UPDATE: 服务端转发给同房间其他客户端(**排除发送者**)。
- AWARENESS: 原样转发, 排除发送者, 不回显。

纯转发模式下服务端无状态, 客户端持有完整 CRDT 状态并互相收敛; 服务端
不持久化 Yjs 增量(见"已知限制")。

### 连接复用与 awareness 防回环

前端 `lib/collab.ts` 用**模块级单例缓存** `Map<docId, {ydoc, provider}>`
保证:

- 同一文档全页面共享同一 `Y.Doc` 与同一条 WebSocket 连接;
- 避免 React StrictMode 开发模式 double-mount 造成重复连接;
- 避免多个 provider 共享同一 doc 时, 服务端把 A 的 awareness 转发给 B、
  B 应用后重新广播的无限回环(时钟无限递增的消息风暴)。

切换文档时 `App.tsx` 显式调用 `disposeCollabSession()` 关闭旧连接。

### AI / 人类作者着色

- 文本的 `author` 属性 = `ai` → 蓝色背景 (`.author-ai`)
- 文本的 `author` 属性 = `human` → 白色背景 (`.author-human`)
- 实现: ProseMirror `Decoration` 插件(`CollaborativeEditor.tsx` 的
  `AuthorHighlight` 扩展), 将 Yjs 文本 delta 属性映射为视图层背景色。

### 版权溯源 (SHA-256 哈希链)

每次操作生成 `OpLog`, 通过 SHA-256 链接:

```
current_hash = sha256(prev_hash + operation_json + timestamp)
```

任一历史记录被篡改, 整条链验证失败(见 `services/oplog_chain.py`)。

### 水印 (Kirchenbauer, 论文级实现)

`watermark_engine.py` 按 Kirchenbauer et al. (ICML 2023, arXiv:2301.10226)
论文方法实现, 与官方代码仓库 [jwkirchenbauer/lm-watermarking](https://github.com/jwkirchenbauer/lm-watermarking)
(Apache-2.0) 算法一致:

- **绿名单生成**: `seed = hash_key * prev_token` (大素数种子, 论文式 PRF),
  对词表洗牌 (randperm) 取前 `gamma` 比例为绿名单; 检测端以相同种子还原,
  密钥通过 SHA-256 混合, 不可被他人预测;
- **统计检验**: `z = (green - gamma*T) / sqrt(T*gamma*(1-gamma))`,
  `p = 1 - Phi(z)`, 判定规则 `z > 4.0` (论文建议), 置信度 = `1 - p`;
- **安全检测**: 默认对唯一 bigram 去重计数 (`ignore_repeated_bigrams`),
  防止文本重复片段虚高统计量;
- **接入方式**: 默认字符级 tokenizer (无模型可演示闭环), 预留真实
  tokenizer 接入点 (tiktoken / transformers)。

### arXiv 实时文献检索

`services/arxiv_client.py` 调用 [arXiv API](https://export.arxiv.org/api/query)
检索真实论文 (标题/作者/年份/摘要/分类), 用于 ResearchAgent 的实时调研:

- 查询词由自然语言指令自动抽取 (仅保留英文关键词, AND 组合提升相关性);
- 网络不可用 / 超时 / 无结果时**自动降级**到本地 `literature` 文献库,
  演示链路始终可用;
- 检索结果标注来源 ("arXiv 实时检索" / "本地文献库")。

### Agent 编排 (多 Agent 协作)

```
SupervisorAgent ──► ResearchAgent ──► WriterAgent ──► SupervisorAgent (审校)
     ▲                                                    │
     └───────────────── 循环/结束 ◄──────────────────────┘
```

- `State`: 文档内容 + 检索结果 + 写作草稿 + 审阅意见
- 节点: `research_node` / `writing_node` / `supervisor_review_node`
- **ResearchAgent**: 从自然语言指令自动抽取英文关键词, 优先经 arXiv API
  **实时检索**真实论文, 无网络/失败时降级到 `literature` 本地文献库,
  结果标注来源;
- **SupervisorAgent**: 调用 `AcademicReviewEngine` 对草稿执行学术规范静态检查
  (篇幅 / GB/T 7714 类型标识 / 引用编号连续性 / 参考文献章节 / 条数匹配),
  输出结构化导师审稿意见。
- 未安装 langgraph 时自动降级为顺序执行(结果一致)。

### 文献检索与引用插入

- 右侧"文献检索"面板: 关键词检索 `literature` 种子语料(标题/摘要/关键词),
  一键生成 GB/T 7714 引文并插入协作文档(带 `author=human` 标记);
- ResearchAgent 复用同一检索能力。

### 文档导出 (Markdown + 溯源元数据)

- 顶栏"导出 Markdown": 生成含标题、正文、溯源哈希链校验状态、水印检测
  记录、GB/T 7714 参考文献列表的 `.md` 文件, 正文自动剥离编辑器 HTML 标签。

## 运行测试

```bash
cd backend
python -m pytest tests/ -q        # 129 用例: 哈希链/水印/攻击矩阵/证据包/参数/API 集成
```

前端类型检查与构建:

```bash
cd frontend
npm run build                     # tsc 类型检查 + vite build
```

完整验收请按 `docs/测试工作流.md` 分阶段执行, GUI 实测脚本位于
`test-harness/` (`gui_step11_robustness.mjs` / `gui_step12_params.mjs` /
`gui_step13_evidence.mjs`, 用 Playwright + Chromium 模拟真实用户操作);
样例数据见 `docs/测试样例.md`, 历史测试结论见 `docs/测试报告.md`。

## 开源代码与许可

本项目在科研核心模块参考/适配了以下开源项目, 均已在
`THIRD_PARTY_NOTICES.md` 声明, 许可证全文存放于 `THIRD_PARTY/`:

| 项目 | 用途 | 许可证 |
|------|------|--------|
| [jwkirchenbauer/lm-watermarking](https://github.com/jwkirchenbauer/lm-watermarking) | Kirchenbauer 水印算法 (绿名单/检测统计) | Apache-2.0 |
| [THU-BPM/MarkLLM](https://github.com/THU-BPM/MarkLLM) | 后续水印算法扩展参考 (KGW 家族/鲁棒性评估) | Apache-2.0 |
| [arXiv API](https://export.arxiv.org/api/query) | 真实文献实时检索数据源 | arXiv 公开接口 |

## 验证要点

启动后依次验证:

1. **健康检查**: `curl http://localhost:8000/api/health` 返回 `{"status":"ok",...}`;
   `curl http://localhost:8000/api/bootstrap` 返回演示用户与文档列表。
2. **单页协同**: 打开 `http://localhost:5173`, 浏览器控制台无报错;
   DevTools → Network → WS 过滤 `ws`, 恰好 **1 条** `/ws/{doc_id}` 连接,
   初始帧为 `SEND 00000100`(step1) → `RECV 0001020000`(空 update)。
3. **双端协同**: 开两个标签页打开同一文档, 在 A 中输入文本, B 实时出现;
   光标在 A 中移动时, B 能看到 A 的多光标(彩色 caret)。
4. **Agent 链路**: 点击"启动文献检索", 结果含**真实文献条目**(优先 arXiv
   实时检索并标注来源, 无网络时回退本地 literature 库); 点击"导师审稿",
   输出学术规范检查意见(✅ 通过 / ❌ 需修改)。
5. **水印检测留痕**: 在"水印检测"面板点击"检测当前文档全文并留痕",
   返回 `is_ai_generated` / `confidence`, 生成检测历史记录, 且溯源链
   `verify` 仍为 `{"valid": true}`(新增 `watermark_checked` 日志)。
6. **溯源链**: "溯源链"面板展示操作日志哈希链, `verify` 返回
   `{"valid": true}`。
7. **文献引用**: "文献检索"面板搜索 → 点击"插入引用", GB/T 7714 引文进入
   编辑器正文。
8. **导出**: 顶栏"导出 Markdown", 下载文件含标题/正文/溯源校验状态/
   参考文献。

## 已知限制

- **服务端纯转发, 不持久化 Yjs 状态**: 文档 Yjs 增量不落库, 刷新后编辑器
  内容从数据库 `documents.content` 恢复(非 CRDT 增量); `yjs-state` 接口为
  骨架占位。
- **Agent 不调用真实 LLM**: ResearchAgent 检索真实文献库, Writer 返回
  预置草稿模板, Supervisor 使用规则引擎(非语义评审); 未接入
  BackgroundTasks/消息队列, 同步执行。
- **水印使用字符级 tokenizer**: 算法为 Kirchenbauer 论文级忠实实现(绿名单/
  z-score/p-value/bigram 去重), 但默认以 Unicode 码点作为 token 演示闭环,
  未接入真实 LLM 的 logits 与分词器(预留 tiktoken/transformers 接入点)。
- **无认证**: 演示用户写死在种子数据, AUTH 消息预留未启用。

## AI 模型预留

后端 `agent_orchestrator.py` 中 `_call_llm` 留有待接入口, 可切换:

- DeepSeek-V3 (OpenAI 兼容 API)
- 通义千问 (DashScope)
- 本地 vLLM / Ollama

## 后续接入点 (TODO)

- [ ] 服务端 Yjs 状态持久化与重启恢复 (`documents.yjs_state`)
- [ ] Agent 流式输出经 WebSocket 实时推送(而非轮询)
- [ ] 真实 LLM 调用 + Kirchenbauer 水印嵌入
- [ ] 用户认证 (JWT) 与 `User` 表对接
#   r e s e a r c h - c o l l a b 
 
 