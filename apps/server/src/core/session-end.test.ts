import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { createTestApp, MOCK } from '../testing';
import { createTestDb } from './db/test-db';
import { RESTARTED } from './guard';

// 배포 준비 회의(10/29) B2·B3·B5: 운영 세션 쿠키, 재시작으로 끊긴 세션, 없는 주소의 응답과 로그.

const SECRETS = { SESSION_SECRET: 's'.repeat(40), PSEUDONYM_SECRET: 'p'.repeat(40), PROPOSAL_SECRET: 'q'.repeat(40), MCP_TOKEN_SECRET: 'm'.repeat(40) };
const setCookies = (res: { headers: Record<string, unknown> }) => [res.headers['set-cookie'] ?? []].flat() as string[];

describe('세션이 끝난 이유와 세션 쿠키(배포 준비 회의 B2·B3)', () => {
  it('서버가 다시 뜨면(배포) 남은 세션 쿠키는 재시작 이유로 401이에요. 8시간 만료·위조 쿠키는 재시작이 아니에요', async () => {
    const db = await createTestDb();
    try {
      const first = await createTestApp({ db });
      const before = await first.loginAs(MOCK.staff);
      await first.close();

      const second = await createTestApp({ db });
      try {
        const me = (cookie: string) => second.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
        const restarted = await me(before.cookie);
        expect(restarted.statusCode).toBe(401);
        expect(restarted.json()).toEqual(RESTARTED);

        // 같은 기동에서 8시간이 지나 끝난 세션은 그냥 로그인 필요예요.
        const fresh = await second.loginAs(MOCK.staff);
        second.advance(8 * 60 * 60_000 + 1);
        const expired = (await me(fresh.cookie)).json();
        expect(expired).toMatchObject({ error: 'login-required' });
        expect(expired.reason).toBeUndefined();

        // 서명이 틀린 쿠키는 이유를 알려 주지 않아요.
        const forged = (await me(`${before.cookie.split('=')[0]}=xyz.forged`)).json();
        expect(forged.reason).toBeUndefined();
      } finally {
        await second.close();
      }
    } finally {
      await db.close();
    }
  });

  it('운영 세션 쿠키는 __Host- 이름에 Secure·HttpOnly·SameSite=Lax이고 만료가 없어요. 로그아웃은 같은 속성으로 지우고 다시 인증 표시를 남겨요', async () => {
    const db = await createTestDb();
    const config = loadConfig({ NODE_ENV: 'production', DESK_MOCK_LOGIN: 'true', PUBLIC_BASE_URL: 'https://desk.example.com', ...SECRETS });
    const { app } = await buildApp({ config, db, seed: false, retentionTimer: false });
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { idpSubject: MOCK.staff } });
      expect(login.statusCode).toBe(200);
      const sid = setCookies(login).find((c) => c.startsWith('__Host-desk_sid='))!;
      expect(sid).toBeDefined();
      expect(sid).toMatch(/; Path=\//);
      expect(sid).toMatch(/; Secure/);
      expect(sid).toMatch(/; HttpOnly/);
      expect(sid).toMatch(/; SameSite=Lax/);
      expect(sid).not.toMatch(/Max-Age|Expires/i);
      expect(sid).not.toMatch(/Domain=/i);

      const cookie = sid.split(';')[0]!;
      const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
      const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-csrf-token': me.csrfToken } });
      expect(out.statusCode).toBe(200);
      // __Host- 쿠키는 Secure·Path=/가 같아야 브라우저가 지워요.
      const cleared = setCookies(out).find((c) => c.startsWith('__Host-desk_sid='))!;
      expect(cleared).toMatch(/^__Host-desk_sid=;/);
      expect(cleared).toMatch(/; Secure/);
      expect(cleared).toMatch(/; Path=\//);
      expect(setCookies(out).some((c) => /^__Host-desk_reauth=.+; /.test(c) && c.includes('Secure'))).toBe(true);
    } finally {
      await app.close();
      await db.close();
    }
  });
});

describe('없는 주소와 읽지 못하는 주소(배포 준비 회의 B5)', () => {
  it('응답과 로그에 쿼리·주소를 넣지 않고 내용 없는 404·400으로 답해요', async () => {
    const lines: string[] = [];
    const t = await createTestApp({ logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } } });
    try {
      const missing = await t.app.inject({ method: 'GET', url: '/api/no-such-route?q=CANARY-404' });
      expect(missing.statusCode).toBe(404);
      // /api에 없는 경로는 대개 옛 화면이라 새로 고치라고 해요(D2).
      expect(missing.json()).toEqual({ error: 'not-found', message: '화면이 옛 버전이에요. 새로 고친 뒤 다시 해 주세요' });
      expect((await t.app.inject({ method: 'GET', url: '/no-such-page?q=CANARY-404' })).json()).toEqual({ error: 'not-found', message: '찾는 주소가 없어요' });

      const bad = await t.app.inject({ method: 'GET', url: '/api/%zz?q=CANARY-400' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toEqual({ error: 'bad-request', message: '요청 형식이 맞지 않아요' });

      const log = lines.join('\n');
      expect(log).toContain('/api/no-such-route');
      expect(log).not.toContain('CANARY');
      expect(`${missing.body}${bad.body}`).not.toContain('CANARY');
      expect(bad.body).not.toContain('%zz');
    } finally {
      await t.close();
    }
  });
});
