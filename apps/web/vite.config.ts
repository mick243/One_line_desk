import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 개발에서는 웹(5190) 한 주소로 모든 경로를 받아요. API·MCP·인가 경로는 서버(3190)로 넘겨요.
// /oauth/consent는 웹 화면(동의 시트)이라 넘기지 않아요.
const server = 'http://localhost:3190';
// 동의 시트(/oauth/consent)를 다른 사이트가 틀(iframe)에 넣어 누르게 하지 못하게 해요(클릭재킹).
const headers = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' };

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    strictPort: true,
    headers,
    proxy: {
      '/api': server,
      '/health': server,
      '/mcp': server,
      '/.well-known': server,
      '^/oauth/(authorize|token|revoke)': server,
    },
  },
  preview: { headers },
});
