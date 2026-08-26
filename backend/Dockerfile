# 智溯 · 后端镜像 (FastAPI + SQLAlchemy async + uvicorn)
# 构建: docker build -t research-collab-backend ./backend
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# 先装依赖, 利用 Docker 层缓存 (requirements 变更才重建该层)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝后端代码 (含内置中文字体 fonts/simhei.ttf, 供证据包 PDF 渲染)
COPY . .

EXPOSE 8000

# PostgreSQL 不可用时自动回退 SQLite (路径由 SQLITE_PATH 配置, 见 docker-compose.yml)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
