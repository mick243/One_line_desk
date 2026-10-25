import { afterEach, describe, expect, it } from 'vitest';
import { createMockAdapters } from './adapters';
import { buildApp } from './app';
import { loadConfig } from './config';

const config = { ...loadConfig({}), databaseUrl: undefined };
let clock = Date.UTC(2026, 9, 26, 0, 0, 0);
const apps: { close(): Promise<unknown> }[] = [];

async function setup() {
  const adapters = createMockAdapters();
  const built = await buildApp({ config, adapters, now: () => clock });
  apps.push(built.app);
  return { ...built, adapters };
}

async function login(app: Awaited<ReturnType<typeof setup>>['app'], idpSubject = 'mock|emp-001') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { idpSubject } });
  expect(res.statusCode).toBe(200);
  const setCookie = String(res.headers['set-cookie']);
  const cookie = setCookie.split(';')[0]!;
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { cookie, setCookie, csrf: me.json().csrfToken as string, me: me.json() };
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe('서버 뼈대', () => {
  it('DB 없이도 뜨고 건강 확인에 알려 줘요', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ ok: true, db: 'none', rulesVersion: 1 });
  });

  it('로그인 전에는 /api/me가 막혀요', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
  });

  it('모의 로그인은 httpOnly 세션 쿠키만 주고, 역할은 서버가 계산해요', async () => {
    const { app } = await setup();
    const { setCookie, me } = await login(app, 'mock|emp-003');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(me).toMatchObject({ displayName: '가상 총무 서연', roles: ['employee', 'facilities', 'chart-owner'] });
  });

  it('쓰기 요청은 CSRF 토큰이 없으면 막혀요', async () => {
    const { app } = await setup();
    const { cookie } = await login(app);
    const res = await app.inject({ method: 'POST', url: '/api/ask', headers: { cookie }, payload: { text: '법인카드 잃어버렸어요' } });
    expect(res.statusCode).toBe(403);
  });

  it('키·토큰이 든 질문은 서버에서도 잠그고, 감사 로그에는 내용이 남지 않아요', async () => {
    const { app, ctx } = await setup();
    const { cookie, csrf } = await login(app);
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    const res = await app.inject({
      method: 'POST',
      url: '/api/ask',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { text: `키 ${secret} 가 안 돼요` },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().locks[0].kind).toBe('key-token');
    const log = JSON.stringify(ctx.audit.recent());
    expect(log).toContain('"result":"locked"');
    expect(log).not.toContain(secret);
  });

  it('평범한 질문은 아직 라우터가 없어서 501이에요', async () => {
    const { app } = await setup();
    const { cookie, csrf } = await login(app);
    const res = await app.inject({ method: 'POST', url: '/api/ask', headers: { cookie, 'x-csrf-token': csrf }, payload: { text: '법인카드 잃어버렸어요' } });
    expect(res.statusCode).toBe(501);
  });

  it('퇴사하면 재확인 간격이 지난 뒤 첫 요청에서 끊겨요', async () => {
    const { app, adapters } = await setup();
    const { cookie } = await login(app);
    adapters.employees.setActive('mock|emp-001', false);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    clock += 5 * 60 * 1000;
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('모든 기기 로그아웃은 다른 기기 세션도 지워요', async () => {
    const { app } = await setup();
    const phone = await login(app);
    const laptop = await login(app);
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: { cookie: phone.cookie, 'x-csrf-token': phone.csrf } });
    expect(res.json()).toMatchObject({ ok: true, sessions: 2 });
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: laptop.cookie } })).statusCode).toBe(401);
  });

  it('공개 설정은 모의 데이터 목록을 알려 주고, 운영 설정은 운영자만 봐요', async () => {
    const { app } = await setup();
    const pub = (await app.inject({ method: 'GET', url: '/api/config/public' })).json();
    expect(pub.standalone).toBe(false);
    expect(pub.demoData.length).toBeGreaterThan(0);

    const staff = await login(app, 'mock|emp-001');
    expect((await app.inject({ method: 'GET', url: '/api/ops/settings', headers: { cookie: staff.cookie } })).statusCode).toBe(403);
    const operator = await login(app, 'mock|emp-005');
    const ops = await app.inject({ method: 'GET', url: '/api/ops/settings', headers: { cookie: operator.cookie } });
    expect(ops.json()).toMatchObject({ mcp: false, mcpTools: [] });
  });
});
