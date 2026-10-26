import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createTestDb } from './core/db/test-db';
import { createTestApp, MOCK } from './testing';

const opened: { close(): Promise<void> }[] = [];
async function setup() {
  const t = await createTestApp();
  opened.push(t);
  return t;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

describe('공통 바닥', () => {
  it('건강 확인에 DB와 AI 공급자를 알려 줘요', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ ok: true, db: 'pglite-connected', ai: 'fake', rulesVersion: 1 });
  });

  it('로그인 전에는 /api/me가 막혀요', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
  });

  it('[ADR-13] 모의 로그인은 httpOnly 세션 쿠키만 주고, 역할은 서버가 계산해요', async () => {
    const t = await setup();
    const { setCookie, me } = await t.loginAs(MOCK.facilities);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(me).toMatchObject({ displayName: '가상 총무 서연', roles: ['employee', 'facilities', 'chart-owner'] });
  });

  it('[ADR-13] 쓰기 요청은 CSRF 토큰이 없으면 막혀요', async () => {
    const t = await setup();
    const { cookie } = await t.loginAs(MOCK.staff);
    const res = await t.app.inject({ method: 'POST', url: '/api/ask', headers: { cookie }, payload: { text: '법인카드 잃어버렸어요' } });
    expect(res.statusCode).toBe(403);
  });

  it('[ADR-10·11 시험] 키·토큰이 든 질문은 서버에서도 잠그고, 감사 로그에는 내용이 남지 않아요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    const res = await me.call('POST', '/api/ask', { text: `키 ${secret} 가 안 돼요` });
    expect(res.status).toBe(422);
    expect(res.body.locks[0].kind).toBe('key-token');
    const { rows } = await t.db.query('select * from audit_log');
    expect(JSON.stringify(rows)).toContain('"result":"locked"');
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it('[ADR-10 시험] 묻기 원문은 DB 어디에도 남지 않아요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const canary = '카나리문자열QX7';
    expect((await me.call('POST', '/api/ask', { text: `법인카드 잃어버렸어요 ${canary}` })).status).toBe(200);
    const { rows: tables } = await t.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'");
    for (const { table_name } of tables) {
      const { rows } = await t.db.query(`select * from ${table_name}`);
      expect(JSON.stringify(rows), table_name).not.toContain(canary);
    }
  });

  it('[ADR-13 시험] 퇴사하면 재확인 간격이 지난 뒤 첫 요청에서 끊겨요', async () => {
    const t = await setup();
    const { cookie } = await t.loginAs(MOCK.staff);
    t.adapters.employees.setActive(MOCK.staff, false);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    t.advance(5 * 60 * 1000);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('[ADR-13 시험] 모든 기기 로그아웃은 다른 기기 세션도 지워요', async () => {
    const t = await setup();
    const phone = await t.loginAs(MOCK.staff);
    const laptop = await t.loginAs(MOCK.staff);
    expect((await phone.call('POST', '/api/auth/logout-all')).body).toMatchObject({ ok: true, sessions: 2 });
    expect((await laptop.call('GET', '/api/me')).status).toBe(401);
  });

  it('[R7] 공개 설정은 모의 데이터 목록을 알려 주고, 운영 설정은 운영자만 봐요', async () => {
    const t = await setup();
    const pub = (await t.app.inject({ method: 'GET', url: '/api/config/public' })).json();
    expect(pub).toMatchObject({ standalone: false, mcp: false });
    expect(pub.demoData.length).toBeGreaterThan(0);

    expect((await (await t.loginAs(MOCK.staff)).call('GET', '/api/ops/settings')).status).toBe(403);
    const ops = await (await t.loginAs(MOCK.operator)).call('GET', '/api/ops/settings');
    expect(ops.body).toMatchObject({ mcp: false, mcpTools: [] });
  });

  it('[ADR-13 시험] 운영 환경은 DESK_MOCK_LOGIN=true 없이 모의 로그인으로 뜨지 않아요', async () => {
    const secrets = { SESSION_SECRET: 's'.repeat(40), PSEUDONYM_SECRET: 'p'.repeat(40), PROPOSAL_SECRET: 'q'.repeat(40), MCP_TOKEN_SECRET: 'm'.repeat(40) };
    const db = await createTestDb();
    try {
      await expect(buildApp({ config: loadConfig({ NODE_ENV: 'production', ...secrets }), db, seed: false })).rejects.toThrow(/모의 로그인/);
      const demo = await buildApp({ config: loadConfig({ NODE_ENV: 'production', DESK_MOCK_LOGIN: 'true', ...secrets }), db, seed: false });
      expect((await demo.app.inject({ method: 'GET', url: '/api/auth/mock-users' })).statusCode).toBe(200);
      await demo.app.close();
    } finally {
      await db.close();
    }
  });
});
