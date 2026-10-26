# AI 交接说明（给另一位 AI 协作者）

> 用途：让另一个 AI 能快速、安全地接手审查与本项目代码。
> 最后更新：2026-10（当前分支 main，最新提交见 `git log --oneline -1`）

---

## 0. 安全前提（务必先做）

以下文件**不要**交给外部 AI / 上传到任何在线服务：

| 文件 | 原因 |
|---|---|
| `backend/.env` | 含 `LLM_API_KEY` 等真实密钥 |
| `backend/.secrets/` | 含水印主密钥 |
| `backend/research_colab.db` | 含用户文档正文 |

推荐做法：复制一份"脱敏副本"再交接——

```bash
rsync -a --exclude '.env' --exclude '.secrets' --exclude '*.db' \
      --exclude 'node_modules' --exclude '__pycache__' \
      /path/to/research-collab/ /tmp/research-collab-handoff/
```

或在同一台机器上直接给路径（不联网传输），只要求对方"只读审查、不改敏感文件"。

---

## 1. 项目是什么

"智溯"——面向科研诚信的多 Agent 协同写作与 AIGC 版权溯源系统。

- 后端：FastAPI + SQLAlchemy(async) + SQLite（PostgreSQL 可选）+ LangGraph 单节点图
- 前端：React 18 + TypeScript + Vite + Tailwind + Tiptap/Yjs（实时协同）+ markdown-it
- 三大 Agent：调研（文献检索）、写作（结构化正文）、审核（红黄牌 + LLM 语义审稿）
- 水印：Kirchenbauer 字符级绿名单水印（每文档独立密钥），检测输出 z 统计量

## 2. 怎么跑起来

```bash
# 后端（8000）
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000

# 前端（5173，代理 /api 与 /ws 到 8000）
cd frontend
npm install
npm run dev -- --host 127.0.0.1
```

需要 LLM 时在 `backend/.env` 配置 `LLM_API_KEY`；不配置则自动降级为本地规则引擎（可离线演示）。

## 3. 怎么验证（任何改动都必须跑）

```bash
cd backend && python -m pytest tests/ -q        # 期望 162+ 全绿
cd frontend && npx tsc -b && npm run build      # 期望 0 错误
```

## 4. 关键代码位置（改之前先读）

| 功能 | 文件 |
|---|---|
| 流程状态机（9 态唯一权威） | `frontend/src/lib/agentFlow.ts` |
| Agent 面板容器（状态 + handler） | `frontend/src/components/Agent/AgentPanel.tsx` |
| 三个 Tab 视图 | `.../ResearchTab.tsx` `WriterTab.tsx` `ReviewTab.tsx` |
| Tab 元数据/主题色 | `.../AgentTabs.tsx` |
| 共享消息流/交接卡片 | `.../TabShared.tsx` |
| Agent 编排（Writer/Research/Supervisor 节点） | `backend/services/agent_orchestrator.py` |
| LLM 客户端与 prompt | `backend/services/llm_client.py` |
| 水印引擎（注入/检测/鲁棒性） | `backend/services/watermark_engine.py` |
| 学术审稿规则 | `backend/services/academic_review.py` |
| 文献检索（arXiv + 中文映射 + 入库） | `backend/api/literature.py` `backend/services/arxiv_client.py` |
| Agent 接口（invoke/review/polish/rewrite） | `backend/api/agents.py` |
| 水印接口（检测/参数/证据包/鲁棒性） | `backend/api/watermark.py` |

## 5. 不可破坏的约束

1. **严禁恢复 Agent 自动串联**：每次 invoke 只跑一个 Agent（单节点图），下一步必须由用户点击触发；状态机只允许在 `agentFlow.ts` 的流转表内推进。
2. **接口字段**：`/agents/invoke` 的 `writer_input = {user_topic, confirmed_literature, additional_requirements, watermark}` 是前后端契约；`/agents/review` 的 `text` 为显式审稿正文。
3. **数据库**：所有查询用参数绑定（SQLAlchemy 表达式），禁止字符串拼接 SQL；凭据只从环境变量读取。
4. **写作正文默认不加水印**（纯 LLM，保证流畅）；"带水印版本"是独立按钮触发的可选路径。

## 6. 已知问题 / 现状（截至当前提交）

| 项 | 状态 |
|---|---|
| 纯 LLM 写作正文 | 流畅、结构化（标题/参考文献/正文，自动分段） |
| 带水印版本 | z≈4.3–4.5（阈值 4.0 可检出），正文需 ≥1400 字，仍有少量重复虚词/缺字瑕疵 |
| 检测统计口径 | 已改为标准全量 token（不去重），z 值整体高于历史版本，属预期变更 |
| 中文检索 | 领域词中英映射 + jieba 分词本地降级，未收录词可能只命中本地库 |
| 在线检索结果 | 自动写本地文献库（URL 去重），库会持续增长 |
| 审稿 | 规则红黄牌 + LLM 语义意见（warning/info，不产生红牌） |
| 网络 | 开发机到 github.com 偶发阻断，推送需重试；与代码无关 |
| 数据库历史 | `backend/research_colab.db` 曾在早期提交中被纳入版本库（含演示数据） |

## 7. 推荐工作流（给接手 AI 的硬性要求）

1. **先只读审查**：输出问题清单（`文件:行号`、严重级、影响、建议修法），不改代码。
2. 等人类确认修复范围后，**小步修改**（一次一个问题），每改一处跑相关测试。
3. 全量验证：`pytest` + `tsc -b` + `npm run build` 必须通过。
4. 汇报必须包含**真实测试输出**，禁止只说"已修复"。
5. 不要触碰 `.env` / `.secrets` / `*.db`；不要 `git push`，除非人类明确要求。

## 8. 可直接粘贴给另一位 AI 的提示词

```text
你是本项目的代码审查与修复助手。项目：智溯（FastAPI + React 多 Agent 科研协同写作
与 AIGC 水印溯源），代码在 <路径>。请先阅读 docs/AI交接说明.md，再按以下要求工作：

【第一阶段：只读审查，不改代码】
逐项检查并输出问题清单（每条含 文件:行号、严重级 P0/P1/P2、影响、建议修法）：
1. 流程状态机（frontend/src/lib/agentFlow.ts）与各 handler 的调用一致性；
2. 前后端接口字段是否完全对齐（/agents/invoke、/agents/review、/agents/polish、
   /agents/rewrite、/literature/search、/watermark/*）；
3. 水印注入/检测链路：注入端与检测端的绿名单口径、密钥来源、边界情况（空文本、
   超长文本、含公式文本）；
4. 安全：SQL 注入、越权访问文档、密钥泄露、外部 URL 请求（仅 http/https，禁止
   内网地址）、前端 XSS（dangerouslySetInnerHTML 的数据来源）；
5. 并发与状态：Agent 轮询、文档切换竞态、Yjs 写入重复。

【第二阶段：修复（等我确认清单后再做）】
- 一次只改一个问题；每处修改附简短说明；
- 改完必须运行：cd backend && python -m pytest tests/ -q；
  cd frontend && npx tsc -b && npm run build；
- 汇报时粘贴真实输出，不要只说"已通过"；
- 不得修改 backend/.env、backend/.secrets、*.db；不得 git push。

【禁止】
- 恢复 Agent 自动串联或改动状态机流转表；
- 引入新的第三方依赖而不说明理由。
```

---

## 9. 交接检查清单

- [ ] 已排除 `.env` / `.secrets` / `*.db`（或确认在本机只读）
- [ ] 对方已阅读本文档
- [ ] 对方先给出审查报告，人类确认后再动代码
- [ ] 每轮改动后测试全绿、diff 已人工过目
