import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 本地/根路径部署用 '/'；GitHub Pages 子路径构建时设 BASE_PATH=/WriterTools/
  base: process.env.BASE_PATH || '/',
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { target: 'es2022' },
});
