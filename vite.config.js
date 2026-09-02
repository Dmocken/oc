import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // /api 原样转发到 offerbiu 后端，解决跨域
      '/api': {
        target: 'https://www.offerbiu.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
