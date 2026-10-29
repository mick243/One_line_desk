import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// 설정 파일은 Vite가 묶어서 읽으니 shared의 ts 파일을 상대 경로로 가져와요.
import { HTML_SECURITY_HEADERS } from '../../packages/shared/src/web-headers';

// 개발에서는 웹(5190) 한 주소로 모든 경로를 받아요. API·MCP·인가 경로는 서버(3190)로 넘겨요.
// /oauth/consent는 웹 화면(동의 시트)이라 넘기지 않아요.
const server = 'http://localhost:3190';
// 동의 시트(/oauth/consent)를 다른 사이트가 틀(iframe)에 넣어 누르게 하지 못하게 해요(클릭재킹).
// 개발 서버는 고쳐 끼우기(HMR)에 인라인 스크립트를 써서 틀 막기만 붙여요.
const headers = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' };

export default defineConfig({
  plugins: [react()],
  // 이 화면의 판(배포 준비 회의 D1). 이미지를 만들 때 DESK_BUILD(커밋)를 넣어 서버와 같은 값을 가져요. 서버 판이 다르면 새 버전 띠를 띄워요.
  define: { __DESK_BUILD__: JSON.stringify(process.env.DESK_BUILD || 'dev') },
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
  // 미리보기(빌드 결과)는 운영과 같은 보안 머리 한 벌을 붙여요. CSP를 어기는 화면을 여기서 먼저 봐요(B1).
  preview: { headers: HTML_SECURITY_HEADERS },
});
