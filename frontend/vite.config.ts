import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// 后端地址可配置: 默认 8000; 端口被其他项目占用时通过
// VITE_API_TARGET=http://127.0.0.1:8010 覆盖 (API/WS 代理同源)。
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:8000';
const WS_TARGET = API_TARGET.replace(/^http/, 'ws');

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: 5173,
    // 开发环境代理: API 与 WebSocket 均转发到 FastAPI
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/ws': {
        target: WS_TARGET,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
