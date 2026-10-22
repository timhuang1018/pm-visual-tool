import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = `http://127.0.0.1:${process.env.PORT ?? 4317}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/ui', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/ws': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  test: { root: '.', include: ['tests/**/*.test.ts'] },
} as any);
