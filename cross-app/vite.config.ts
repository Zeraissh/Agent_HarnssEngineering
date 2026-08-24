import { defineConfig } from 'vite'

// Agent Harness Console：把仓库里 ui/public 的 Web UI 原样打包成
// 浏览器 / Electron / Capacitor 三端可用的外壳。没有框架运行时，只有 Vite。
const proxyTarget = process.env.AGENT_UI_PROXY_TARGET ?? 'http://127.0.0.1:4173'

export default defineConfig({
  // Electron file:// / Capacitor 都要求产物用相对路径，不能写死 /assets/...
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    // 允许手机通过局域网访问开发服务器（真机联调时有用）
    host: true,
    port: 5173,
    // 开发预览时把 /api 代理到本机 Harness UI 服务，免去跨源 CORS 配置；
    // 也顺带覆盖了 Electron 开发态（loadURL http://localhost:5173）。
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
})
