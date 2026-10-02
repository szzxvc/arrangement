import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';
export default defineConfig({
  // Windows 目录联接需要统一为真实路径，避免资源被识别成绝对输出路径。
  root: realpathSync('.'),
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { outDir: 'dist' },
});
