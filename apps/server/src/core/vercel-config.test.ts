import { readFileSync } from 'node:fs';
import { HTML_SECURITY_HEADERS } from '@one-line-desk/shared/web-headers';
import { describe, expect, it } from 'vitest';
import { ASSET_CACHE, HTML_CACHE, PLAIN_CACHE, SCREEN_PATHS } from './web-files';

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
// path-to-regexp의 이름 붙은 묶음 "/api/:path(...)"를 정규식으로 바꿔 봐요.
const apiPattern = new RegExp(`^${apiRewrite.source.replace(':path(', '(')}$`);

describe('vercel.json(웹 화면만 Vercel에 올린 시연)', () => {
  it('화면 보안 머리가 서버가 주는 한 벌(HTML_SECURITY_HEADERS)과 같아요', () => {
    const all = headersFor('/((?!api/).*)');
    for (const [key, value] of Object.entries(HTML_SECURITY_HEADERS)) expect(all[key], key).toBe(value);
    expect(all['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('캐시가 서버와 같아요: 화면 HTML은 저장하지 않고, /assets는 1년, 나머지는 하루예요', () => {
    expect(headersFor('/((?!api/).*)')['cache-control']).toBe(PLAIN_CACHE);
    expect(headersFor('/assets/(.*)')['cache-control']).toBe(ASSET_CACHE);
    for (const path of [...SCREEN_PATHS, '/index.html']) expect(headersFor(path)['cache-control'], path).toBe(HTML_CACHE);
  });

  it('index.html로 대신 답하는 주소는 서버의 화면 주소뿐이에요(모든 주소 받기 없음)', () => {
    const screens = vercel.rewrites.filter((r) => r.destination === '/index.html').map((r) => r.source);
    expect(['/', ...screens].sort()).toEqual([...SCREEN_PATHS].sort());
  });

  it('API는 /api만 시연 서버로 넘기고, 운영 설정(/api/ops)은 넘기지 않아요', () => {
    expect(apiRewrite.destination).toMatch(/^https:\/\/[^/]+\/api\/:path$/);
    expect(apiPattern.test('/api/me')).toBe(true);
    expect(apiPattern.test('/api/rooms/recheck')).toBe(true);
    expect(apiPattern.test('/api/opsx')).toBe(true);
    expect(apiPattern.test('/api/ops')).toBe(false);
    expect(apiPattern.test('/api/ops/settings')).toBe(false);
    // 헬스·MCP·인가 경로는 넘기지 않아요(시연은 MCP를 늘 꺼요).
    expect(vercel.rewrites.some((r) => /^\/(health|mcp|\.well-known|oauth\/(authorize|token|revoke))/.test(r.source))).toBe(false);
    expect(vercel.outputDirectory).toBe('apps/web/dist');
  });

  it('GitHub에 올려도 저절로 배포하지 않아요. 같은 커밋으로 시연 서버(Fly)를 먼저, Vercel을 나중에 직접 올려요', () => {
    expect(vercel.git?.deploymentEnabled).toBe(false);
  });
});
