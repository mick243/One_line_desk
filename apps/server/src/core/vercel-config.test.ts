import { readFileSync } from 'node:fs';
import { HTML_SECURITY_HEADERS } from '@one-line-desk/shared/web-headers';
import { describe, expect, it } from 'vitest';
import { ASSET_CACHE, DEMO_SCREEN_PATHS, HTML_CACHE, PLAIN_CACHE, SCREEN_PATHS } from './web-files';

// 웹 화면만 Vercel에 올린 시연(10/30 Vercel 배포 회의). vercel.json은 TS를 가져오지 못해서 값을 옮겨 적었어요.
// 서버가 화면을 줄 때(web-files.ts)와 같은 머리·캐시·화면 주소인지 여기서 지켜요.

interface Rule {
  source: string;
  destination?: string;
  headers?: { key: string; value: string }[];
}
const vercel = JSON.parse(readFileSync(new URL('../../../../vercel.json', import.meta.url), 'utf8')) as {
  outputDirectory: string;
  git?: { deploymentEnabled?: boolean };
  rewrites: Rule[];
  headers: Rule[];
};
const headersFor = (source: string) => Object.fromEntries((vercel.headers.find((r) => r.source === source)?.headers ?? []).map((h) => [h.key, h.value]));
const apiRewrite = vercel.rewrites.find((r) => r.source.startsWith('/api/'))!;
// 화면 보안·캐시 머리를 붙이는 규칙. API·MCP·인가 경로는 빼요(서버 머리 그대로, 11/2).
const HTML_RULE = '/((?!api/|mcp$|[.]well-known/|oauth/(?:authorize|token|revoke)$).*)';
const htmlPattern = new RegExp(`^${HTML_RULE}$`);
// path-to-regexp의 이름 붙은 묶음 "/api/:path(...)"를 정규식으로 바꿔 봐요.
const apiPattern = new RegExp(`^${apiRewrite.source.replace(':path(', '(')}$`);

describe('vercel.json(웹 화면만 Vercel에 올린 시연)', () => {
  it('화면 보안 머리가 서버가 주는 한 벌(HTML_SECURITY_HEADERS)과 같아요', () => {
    const all = headersFor(HTML_RULE);
    for (const [key, value] of Object.entries(HTML_SECURITY_HEADERS)) expect(all[key], key).toBe(value);
    expect(all['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('캐시가 서버와 같아요: 화면 HTML은 저장하지 않고, /assets는 1년, 나머지는 하루예요', () => {
    expect(headersFor(HTML_RULE)['cache-control']).toBe(PLAIN_CACHE);
    expect(headersFor('/assets/(.*)')['cache-control']).toBe(ASSET_CACHE);
    for (const path of [...SCREEN_PATHS, ...DEMO_SCREEN_PATHS, '/index.html']) expect(headersFor(path)['cache-control'], path).toBe(HTML_CACHE);
  });

  it('index.html로 대신 답하는 주소는 서버의 화면 주소뿐이에요(모든 주소 받기 없음). Vercel은 시연이라 가상 그룹웨어 화면도 넘겨요(11/6)', () => {
    const screens = vercel.rewrites.filter((r) => r.destination === '/index.html').map((r) => r.source);
    expect(['/', ...screens].sort()).toEqual([...SCREEN_PATHS, ...DEMO_SCREEN_PATHS].sort());
    // 가상 그룹웨어 화면 주소에도 화면 보안 머리가 붙어요(API가 아니에요). API(/api/demo/groupware/*)는 /api 규칙으로 시연 서버로 가요.
    for (const path of DEMO_SCREEN_PATHS) expect(htmlPattern.test(path), path).toBe(true);
    expect(apiPattern.test('/api/demo/groupware/inbox')).toBe(true);
  });

  it('API는 /api만 시연 서버로 넘기고, 운영 설정(/api/ops)은 넘기지 않아요', () => {
    expect(apiRewrite.destination).toMatch(/^https:\/\/[^/]+\/api\/:path$/);
    expect(apiPattern.test('/api/me')).toBe(true);
    expect(apiPattern.test('/api/rooms/recheck')).toBe(true);
    expect(apiPattern.test('/api/opsx')).toBe(true);
    expect(apiPattern.test('/api/ops')).toBe(false);
    expect(apiPattern.test('/api/ops/settings')).toBe(false);
    // 헬스는 넘기지 않아요. 동의 시트(/oauth/consent)는 웹 화면이에요.
    expect(vercel.rewrites.some((r) => /^\/health/.test(r.source))).toBe(false);
    expect(vercel.rewrites.find((r) => r.source === '/oauth/consent')?.destination).toBe('/index.html');
    expect(vercel.outputDirectory).toBe('apps/web/dist');
  });

  it('운영자 API 가운데 관리자 AI 정답률(11/5 시험) 두 경로만 넘겨요. 운영 설정·MCP 운영 API는 계속 막아요', () => {
    const opsRules = vercel.rewrites.filter((r) => r.source.startsWith('/api/ops'));
    expect(opsRules).toHaveLength(1);
    const server = apiRewrite.destination!.replace(/\/api\/:path$/, '');
    expect(opsRules[0]!.destination).toBe(`${server}/api/ops/:path`);
    const pattern = new RegExp(`^${opsRules[0]!.source.replace(':path(', '(')}$`);
    for (const p of ['/api/ops/ai-eval', '/api/ops/ai-eval/run']) expect(pattern.test(p), p).toBe(true);
    for (const p of [
      '/api/ops',
      '/api/ops/settings',
      '/api/ops/switch',
      '/api/ops/mcp/clients',
      '/api/ops/ai-evalx',
      '/api/ops/ai-eval/runs',
      '/api/ops/ai-eval/x',
    ])
      expect(pattern.test(p), p).toBe(false);
  });

  it('MCP·인가 경로는 시연 서버로 넘기고, 화면 보안·캐시 머리를 붙이지 않아요(11/2, 발급자가 Vercel 주소라서)', () => {
    // 10/30 회의는 "MCP 단계 전엔 닫아요"였어요. 11/2 MCP 연결 단계에서 시연도 열어요(MCP 스위치는 따로 운영자가 켜요).
    const server = apiRewrite.destination!.replace(/\/api\/:path$/, '');
    const proxied = Object.fromEntries(
      vercel.rewrites.filter((r) => r.destination?.startsWith(server) && r !== apiRewrite).map((r) => [r.source, r.destination]),
    );
    expect(proxied['/mcp']).toBe(`${server}/mcp`);
    expect(
      Object.keys(proxied).some((s) => s.startsWith('/.well-known/') && s.includes('oauth-authorization-server') && s.includes('oauth-protected-resource')),
    ).toBe(true);
    expect(Object.keys(proxied).some((s) => s.startsWith('/oauth/') && /authorize\|token\|revoke/.test(s))).toBe(true);
    expect(Object.keys(proxied).some((s) => s.includes('consent') || s.includes('register'))).toBe(false);
    for (const path of ['/mcp', '/.well-known/oauth-authorization-server', '/oauth/authorize', '/oauth/token', '/oauth/revoke', '/api/me']) {
      expect(htmlPattern.test(path), path).toBe(false);
    }
    for (const path of ['/', '/oauth/consent', '/r/abc', '/mcpx', '/oauth/tokens']) expect(htmlPattern.test(path), path).toBe(true);
  });

  it('GitHub에 올려도 저절로 배포하지 않아요. 같은 커밋으로 시연 서버(Fly)를 먼저, Vercel을 나중에 직접 올려요', () => {
    expect(vercel.git?.deploymentEnabled).toBe(false);
  });
});
