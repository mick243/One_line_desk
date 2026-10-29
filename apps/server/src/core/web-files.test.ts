import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { HTML_SECURITY_HEADERS, NON_HTML_CSP } from '@one-line-desk/shared/web-headers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_WEB_DIST, loadConfig } from '../config';
import { createTestApp } from '../testing';
import { logPath } from './logging';
import { ASSET_CACHE, HTML_CACHE, PLAIN_CACHE, pickEncoding } from './web-files';

// 서버가 웹 화면 파일도 줘요(10/29 배포 준비 회의 A3·B1, 쟁점 1·3). 가짜 dist 폴더로 경로·캐시·압축·보안 머리를 봐요.

const INDEX = '<!doctype html><html lang="ko"><head><script type="module" src="/assets/index-abc.js"></script></head><body><div id="root"></div></body></html>';
const SCRIPT = `export const rows = [${Array.from({ length: 200 }, (_, i) => `"줄 ${i}"`).join(',')}];\n`;
const FONT = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7919) % 251));
const ROOM_SVG = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="10" height="10"/>'.repeat(60)}</svg>`;

let dist: string;
type TestApp = Awaited<ReturnType<typeof createTestApp>>;
let t: TestApp;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'desk-dist-'));
  mkdirSync(join(dist, 'assets'));
  mkdirSync(join(dist, 'rooms'));
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, 'assets', 'index-abc.js'), SCRIPT);
  writeFileSync(join(dist, 'assets', 'index-abc.js.map'), '{"version":3}');
  writeFileSync(join(dist, 'assets', 'font-abc.woff2'), FONT);
  writeFileSync(join(dist, 'rooms', 'room-a.svg'), ROOM_SVG);
  writeFileSync(join(dist, '.hidden'), 'secret');
  t = await createTestApp({ webDir: dist });
});

afterAll(async () => {
  await t?.close();
  rmSync(dist, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });

describe('서버가 웹 화면 파일을 줘요(배포 준비 회의 A3·B1)', () => {
  it.each(['/', '/oauth/consent?req=abc', '/r/eyJqdGkiOiJ4In0.sig'])('화면 주소 %s는 index.html을 저장하지 않는 응답과 보안 머리 한 벌로 줘요', async (url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe(HTML_CACHE);
    expect(res.body).toBe(INDEX);
    expect(res.headers).toMatchObject(HTML_SECURITY_HEADERS);
  });

  it('해시 붙은 파일은 1년 동안 그대로 두고, 미리 압축한 것을 br → gzip → 원본 순으로 골라요', async () => {
    const br = await get('/assets/index-abc.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.statusCode).toBe(200);
    expect(br.headers).toMatchObject({
      'cache-control': ASSET_CACHE,
      'content-encoding': 'br',
      vary: 'accept-encoding',
      'content-type': 'text/javascript; charset=utf-8',
    });
    expect(brotliDecompressSync(br.rawPayload).toString()).toBe(SCRIPT);
    expect(br.rawPayload.length).toBeLessThan(Buffer.byteLength(SCRIPT));

    const gzip = await get('/assets/index-abc.js', { 'accept-encoding': 'br;q=0, gzip' });
    expect(gzip.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gzip.rawPayload).toString()).toBe(SCRIPT);

    const plain = await get('/assets/index-abc.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toBe(SCRIPT);
    // 파일 응답은 문서로 열려도 아무것도 불러오지 못해요.
    expect(plain.headers['content-security-policy']).toBe(NON_HTML_CSP);
  });

  it('글꼴(woff2)은 이미 압축돼 있어서 다시 압축하지 않아요', async () => {
    const res = await get('/assets/font-abc.woff2', { 'accept-encoding': 'br, gzip' });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ 'content-type': 'font/woff2', 'cache-control': ASSET_CACHE });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.rawPayload.equals(FONT)).toBe(true);
  });

  it('dist 뿌리의 해시 없는 파일(회의실 그림)은 하루만 둬요', async () => {
    const res = await get('/rooms/room-a.svg', { 'accept-encoding': 'br' });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ 'content-type': 'image/svg+xml', 'cache-control': PLAIN_CACHE, 'content-encoding': 'br' });
  });

  it.each([
    '/assets/missing-xyz.js',
    '/assets/index-abc.js.map',
    '/.hidden',
    '/index.html',
    '/assets/../index.html',
    '/assets/%2e%2e/.hidden',
    '/some-page',
    '/api/no-such-route',
  ])('표에 없는 주소 %s는 404이고 index.html을 대신 주지 않아요', async (url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).not.toMatch(/text\/html/);
    expect(res.body).not.toContain('<div id="root">');
    expect(res.body).not.toContain('secret');
  });

  it('API 응답에는 HTML CSP가 아니라 아무것도 못 불러오는 CSP를 붙여요', async () => {
    const res = await get('/api/config/public');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(NON_HTML_CSP);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('HEAD도 같은 머리로 답하고 본문은 없어요', async () => {
    const res = await t.app.inject({ method: 'HEAD', url: '/assets/index-abc.js', headers: { 'accept-encoding': 'br' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(ASSET_CACHE);
    expect(res.body).toBe('');
  });

  it('화면 파일 폴더가 비었으면 서버가 뜨지 않아요', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'desk-empty-'));
    try {
      await expect(createTestApp({ webDir: empty })).rejects.toThrow(/웹 화면 파일이 없어요/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('웹 화면 파일 설정과 로그', () => {
  it('운영은 기본으로 apps/web/dist를 주고, 개발은 Vite가 줘서 비워 둬요. DESK_WEB_DIST로 바꿔요', () => {
    expect(DEFAULT_WEB_DIST.replaceAll('\\', '/')).toMatch(/apps\/web\/dist$/);
    const secrets = { SESSION_SECRET: 's'.repeat(40), PSEUDONYM_SECRET: 'p'.repeat(40), PROPOSAL_SECRET: 'q'.repeat(40), MCP_TOKEN_SECRET: 'm'.repeat(40) };
    const demo = { NODE_ENV: 'production', DESK_MOCK_LOGIN: 'true', PUBLIC_BASE_URL: 'https://desk.example.com', ...secrets };
    expect(loadConfig(demo).webDist).toBe(DEFAULT_WEB_DIST);
    expect(loadConfig({}).webDist).toBeUndefined();
    expect(loadConfig({ DESK_WEB_DIST: '/srv/web' }).webDist).toBe('/srv/web');
  });

  it('accept-encoding에서 q=0으로 거절한 압축은 고르지 않아요', () => {
    const both = { br: Buffer.alloc(1), gzip: Buffer.alloc(1) };
    expect(pickEncoding('br, gzip', both)).toBe('br');
    expect(pickEncoding('gzip;q=1.0, br;q=0', both)).toBe('gzip');
    expect(pickEncoding('identity', both)).toBeUndefined();
    expect(pickEncoding(undefined, both)).toBeUndefined();
    expect(pickEncoding('br', {})).toBeUndefined();
  });

  it('앱 확인 링크(/r/<토큰>)는 로그에 토큰 대신 자리 표시로 남아요', () => {
    expect(logPath('/r/eyJ1IjoicHNlLTEifQ.sig?x=1')).toBe('/r/:token');
    expect(logPath('/rooms/room-a.svg')).toBe('/rooms/room-a.svg');
    expect(logPath('/api/rooms?q=1')).toBe('/api/rooms');
  });
});
