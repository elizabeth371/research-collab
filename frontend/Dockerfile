# 智溯 · 前端镜像 (React 18 + Vite 构建 -> Nginx 托管静态资源 + 反代 /api 与 /ws)
# 注意: 构建上下文为仓库根目录 (共享类型 @shared 在 frontend 之外), 使用:
#   docker build -f frontend/Dockerfile -t research-collab-frontend .
# 或直接 docker compose build
FROM node:20-alpine AS build

WORKDIR /app

# 依赖层缓存
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# 共享类型 + 前端源码
COPY shared ./shared
COPY frontend ./frontend

WORKDIR /app/frontend
# Vite 别名 @shared -> ../shared (= /app/shared)
RUN npm run build

# ---- 生产阶段: Nginx ----
FROM nginx:alpine

COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
