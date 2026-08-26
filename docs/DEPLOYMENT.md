# 智溯 · 部署指南

> 面向科研诚信的多 Agent 实时协同与版权溯源系统 —— 本地 / Docker 部署说明。

## 目录

1. [架构与端口](#架构与端口)
2. [方式一：本地开发](#方式一本地开发)
3. [方式二：Docker 一键部署（推荐演示）](#方式二docker-一键部署推荐演示)
4. [环境变量](#环境变量)
5. [部署后自检](#部署后自检)
6. [常见问题](#常见问题)

---

## 架构与端口

```
浏览器 ── http://localhost:80 ──► Nginx (frontend 容器)
   │                              ├─ 静态资源: /usr/share/nginx/html (React 构建产物)
   │                              ├─ /api/*    ──► backend:8000 (REST)
   │                              └─ /ws/*     ──► backend:8000 (WebSocket 协同)
   └──────────────────────────────────────────► backend:8000 (FastAPI, 直连调试)
```

| 服务 | 端口 | 说明 |
|------|------|------|
| 前端 (Nginx) | 80 | SPA 静态托管 + `/api`、`/ws` 反向代理 |
| 后端 (uvicorn) | 8000 | FastAPI, 含 `/api/health` 健康检查 |
| 数据库 | — | 默认 SQLite (文件), 数据卷 `backend-data` 持久化 |

数据库连接策略（`backend/database.py`）：优先 PostgreSQL (asyncpg)，不可用时
自动回退 SQLite（路径由 `SQLITE_PATH` 配置，默认 `./research_colab.db`）。
首次启动（`main.py` lifespan）自动建表 + 写入演示用户/演示文档/文献种子。

---

## 方式一：本地开发

### 后端

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux

pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

> 若已配置 `backend/.env`（含 `LLM_API_KEY`），AI 写作水印注入 / 回译攻击 /
> Agent 编排能力可用；未配置时这些能力降级为提示，离线功能（水印检测、
> 溯源链、证据包、鲁棒性攻击矩阵）不受影响。

### 前端

```bash
cd frontend
npm install
npm run dev
```

访问 `http://localhost:5173`（Vite 已代理 `/api` 与 `/ws` → `localhost:8000`）。

### 运行测试

```bash
cd backend
python -m pytest tests/ -q       # 129 用例
cd frontend && npm run build     # tsc 类型检查 + vite build
```

GUI 实测脚本（Playwright + Chromium, 真实浏览器操作）见 `test-harness/`：
`gui_step11_robustness.mjs`、`gui_step12_params.mjs`、`gui_step13_evidence.mjs`。

---

## 方式二：Docker 一键部署（推荐演示）

前置：安装 Docker Desktop（或 Docker Engine + compose 插件）。

```bash
# 仓库根目录
cp .env.example .env     # 可选: 配置 LLM_API_KEY=sk-... (DeepSeek)
docker compose up -d --build
```

| 命令 | 说明 |
|------|------|
| `docker compose up -d --build` | 构建并后台启动前后端 |
| `docker compose logs -f backend` | 跟踪后端日志 |
| `docker compose down` | 停止并移除容器（数据卷保留） |
| `docker compose down -v` | 停止并**删除数据卷**（清空所有数据） |

访问：

- 前端：`http://localhost`
- 后端健康检查：`http://localhost:8000/api/health` → `{"status": "ok", ...}`

### 镜像说明

- **backend**：`python:3.12-slim` + `pip install -r requirements.txt`（含
  reportlab 证据包渲染；内置中文字体 `backend/fonts/simhei.ttf` 保证 PDF
  中文正常）；`uvicorn main:app` 启动。
- **frontend**：`node:20-alpine` 构建（`npm ci` + `npm run build`，共享类型
  `shared/` 一并拷入构建上下文）→ `nginx:alpine` 托管并反代。
  ⚠️ 前端镜像**构建上下文为仓库根目录**（`@shared` 别名指向 frontend 之外），
  必须用 `docker compose build` 或 `docker build -f frontend/Dockerfile .`。

### 数据持久化

SQLite 数据库文件位于后端容器 `/app/data/research_colab.db`（由环境变量
`SQLITE_PATH=/app/data/research_colab.db` 指定），挂载到命名卷 `backend-data`。
容器重建/升级不丢失文档与溯源链；`docker compose down -v` 才会清空。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_API_KEY` | 空 | DeepSeek API Key（`https://api.deepseek.com`），AI 能力开关 |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `LLM_MODEL` | `deepseek-chat` | 模型名 |
| `DATABASE_URL` | `postgresql+asyncpg://postgres:postgres@localhost:5432/research_colab` | 首选数据库 |
| `SQLITE_PATH` | `./research_colab.db` | PostgreSQL 不可用时的回退路径 |
| `WATERMARK_GAMMA` | `0.5` | 绿名单比例默认值 |
| `WATERMARK_DELTA` | `2.0` | logits 偏移强度（全局引擎） |
| `WATERMARK_LLM_DELTA` | `4.0` | 闭源 LLM logprobs 重采样偏移（实测 z∈[6.7,12.7]） |
| `WATERMARK_SECRET_KEY` | 内置 40 字节 | 全局回退密钥（旧文档回填用） |
| `HASHCHAIN_SALT` | 内置 | 溯源哈希链盐值 |

本地开发可在 `backend/.env` 配置（已 git-ignore）；Docker 部署在仓库根
`.env` 配置（`docker compose` 自动读取）。

---

## 部署后自检

```bash
# 1. 健康检查
curl http://localhost:8000/api/health

# 2. 文档列表 (应含演示文档与测试样例)
curl http://localhost:8000/api/documents

# 3. 溯源链哈希校验 (valid=true)
curl http://localhost:8000/api/watermark/documents/00000000-0000-4000-8000-0000000000a1/provenance/verify

# 4. 证据包导出 (PDF, 应输出 %PDF 文件)
curl -o demo.pdf "http://localhost:8000/api/watermark/documents/00000000-0000-4000-8000-0000000000a1/evidence?format=pdf"
head -c 4 demo.pdf    # -> %PDF

# 5. 一键演示脚本 (完整流程走查)
bash scripts/demo.sh http://localhost:8000
```

---

## 常见问题

**Q: 前端页面能打开但 API 404 / WebSocket 连不上？**
A: 确认后端容器健康：`docker compose ps`（backend 应为 healthy）、
`curl localhost:8000/api/health`。Nginx 反代 `/api/` 与 `/ws` 由
`frontend/nginx.conf` 提供，容器内服务名必须为 `backend`。

**Q: 证据包 PDF 中文乱码或报字体错误？**
A: 镜像已内置 `backend/fonts/simhei.ttf`（`evidence_package.py` 按
`backend/fonts → C:/Windows/Fonts` 顺序查找）。若删除该文件，请放回或
安装系统黑体。

**Q: AI 生成/回译按钮提示"未配置 API Key"？**
A: 在 `.env` 配置 `LLM_API_KEY=sk-...` 后 `docker compose up -d`（仅环境变量
变更无需重新构建镜像）。注意 Key 仅存本地，勿提交到 git（`.env` 已在
`.gitignore`）。

**Q: 端口 80 被占用？**
A: 修改 `docker-compose.yml` 中 frontend 的端口映射，如 `"8080:80"`，
访问 `http://localhost:8080`。

**Q: 想换用 PostgreSQL？**
A: 提供可用的 PG 实例后设置 `DATABASE_URL`，或在 compose 中新增
postgres 服务并替换连接串；表结构由 `init_db()` 自动创建（生产建议改用
Alembic 迁移）。
