import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 빌드 결과물은 ../public 으로 출력 → server.js 가 그대로 정적 서빙한다.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // 개발 서버에서 API/SSE 를 로컬 Duet 서버로 프록시
      '/api': {
        target: 'http://127.0.0.1:4646',
        changeOrigin: true,
      },
    },
  },
});
