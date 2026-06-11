import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 代理全局 WebSocket 事件流
      '/api/v1/events': {
        target: 'ws://localhost:18080',
        ws: true,
      },
      // 代理各配置实例的 WebSocket 实时日志流以及普通 HTTP 配置请求
      '/api/v1/configs': {
        target: 'http://localhost:18080',
        changeOrigin: true,
        ws: true, // 允许升级为 WebSocket
      },
      // 代理其他通用 API 请求
      '/api': {
        target: 'http://localhost:18080',
        changeOrigin: true,
      },
    },
  },
})

