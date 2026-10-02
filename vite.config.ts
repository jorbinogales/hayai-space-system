import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // La API (server/) corre en :3001; el front llama a /api sin CORS.
  server: { proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: false } } },
})
