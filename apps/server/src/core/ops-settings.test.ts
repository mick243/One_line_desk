import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { createTestApp, MOCK } from '../testing';
import type { Db } from './db';
import { createTestDb } from './db/test-db';
import { NAVI_OFF_ONLY_STANDALONE } from './ops-settings';

// 운영 설정 저장(L-14, QA-14·24·33): 재시작해도 값이 남고, 출시 기본값은 회의실 쓰기·MCP 끔이에요.
// 담당 찾기 끔은 같이 채워요 단독 모드에서만이고, 바꿀 때마다 감사 1줄이 남아요.

const dbs: Db[] = [];
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.close();
});

async function sharedDb(): Promise<Db> {
  const db = await createTestDb();
  dbs.push(db);
  return db;
}

async function opsAudit(db: Db): Promise<{ module: string | null; action: string; result: string }[]> {
  return (
    await db.query<{ module: string | null; action: string; result: string }>("select module, action, result from audit_log where channel = 'ops' order by id")
  ).rows;
}

describe('운영 설정 저장(L-14)', () => {
  it('서버를 다시 켜도 운영자가 바꾼 스위치·값·링크가 그대로예요(QA-33)', async () => {
    const db = await sharedDb();
    const first = await createTestApp({ db });
    const op = await first.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/switch', { module: 'rooms', value: 'link' })).status).toBe(200);
    expect((await op.call('PUT', '/api/ops/flag', { flag: 'roomsWrite', value: false })).status).toBe(200);
    expect((await op.call('PUT', '/api/ops/values', { rateLimitPerMinute: 30, employmentRecheckSeconds: 240 })).status).toBe(200);
    expect((await op.call('PUT', '/api/ops/link', { module: 'rooms', url: 'https://groupware.example.com/rooms' })).status).toBe(200);
    await first.close();

    const second = await createTestApp({ db });
    const s = second.ctx.ops.get();
    expect(s.modules.rooms).toBe('link');
    expect(s.roomsWrite).toBe(false);
    expect(s.values).toMatchObject({ rateLimitPerMinute: 30, employmentRecheckSeconds: 240, proposalTtlSeconds: 600 });
    expect(s.links.rooms).toBe('https://groupware.example.com/rooms');
    const pub = (await second.app.inject({ method: 'GET', url: '/api/config/public' })).json();
    expect(pub).toMatchObject({ modules: { rooms: 'link' }, roomsWrite: false });
    await second.close();

    // 바꿀 때마다 감사 1줄(값은 칸 이름=값, 링크는 결과만)
    expect(await opsAudit(db)).toEqual([
      { module: 'rooms', action: 'switch.set', result: 'link' },
      { module: null, action: 'roomsWrite.set', result: 'false' },
      { module: null, action: 'values.set', result: 'rateLimitPerMinute=30,employmentRecheckSeconds=240' },
      { module: 'rooms', action: 'link.set', result: 'ok' },
    ]);
  });

  it('운영(production)은 회의실 쓰기·MCP를 끈 출시 기본값에서 시작해요(CD-14)', async () => {
    const db = await sharedDb();
    const secrets = {
      SESSION_SECRET: 's'.repeat(40),
      PSEUDONYM_SECRET: 'p'.repeat(40),
      PROPOSAL_SECRET: 'q'.repeat(40),
      MCP_TOKEN_SECRET: 'm'.repeat(40),
      PUBLIC_BASE_URL: 'https://demo.example.com',
    };
    const prod = await buildApp({ config: loadConfig({ NODE_ENV: 'production', DESK_MOCK_LOGIN: 'true', ...secrets }), db, seed: false });
    const pub = (await prod.app.inject({ method: 'GET', url: '/api/config/public' })).json();
    expect(pub).toMatchObject({ roomsWrite: false, mcp: false });
    await prod.app.close();
    // 개발·시연 기본값은 회의실 쓰기를 켠 그대로예요.
    const dev = await createTestApp({ db: await sharedDb() });
    expect(dev.ctx.ops.get()).toMatchObject({ roomsWrite: true, mcp: false });
    await dev.close();
  });

  it('담당 찾기 끔은 같이 채워요 단독 모드에서만 돼요(QA-14). 막히면 아무것도 바뀌지 않아요', async () => {
    const t = await createTestApp({ db: await sharedDb() });
    const op = await t.loginAs(MOCK.operator);
    const navOff = await op.call('PUT', '/api/ops/switch', { module: 'navi', value: 'off' });
    expect(navOff).toEqual({ status: 409, body: { error: 'bad-combination', message: NAVI_OFF_ONLY_STANDALONE } });
    expect(t.ctx.ops.get().modules.navi).toBe('on');
    // 단독 모드: 공지·회의실을 먼저 끄고 담당 찾기를 꺼요.
    for (const module of ['notices', 'rooms', 'navi']) expect((await op.call('PUT', '/api/ops/switch', { module, value: 'off' })).status, module).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/config/public' })).json().standalone).toBe(true);
    // 나올 때는 담당 찾기를 먼저 켜요.
    expect((await op.call('PUT', '/api/ops/switch', { module: 'notices', value: 'on' })).status).toBe(409);
    for (const module of ['navi', 'notices', 'rooms']) expect((await op.call('PUT', '/api/ops/switch', { module, value: 'on' })).status, module).toBe(200);
    // 링크만은 단독 모드가 아니어도 돼요.
    expect((await op.call('PUT', '/api/ops/switch', { module: 'navi', value: 'link' })).status).toBe(200);
    expect((await opsAudit(t.db)).map((r) => `${r.module}:${r.result}`)).toEqual([
      'notices:off',
      'rooms:off',
      'navi:off',
      'navi:on',
      'notices:on',
      'rooms:on',
      'navi:link',
    ]);
    await t.close();
  });

  it('운영 값과 링크는 범위·https만 받고, 운영자만 바꿔요', async () => {
    const t = await createTestApp({ db: await sharedDb() });
    const op = await t.loginAs(MOCK.operator);
    for (const body of [{ employmentRecheckSeconds: 600 }, { rateLimitPerMinute: 0 }, { proposalTtlSeconds: 1.5 }, {}, { unknown: 1 }]) {
      expect((await op.call('PUT', '/api/ops/values', body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const url of ['http://groupware.example.com', 'javascript:alert(1)', 'https://user:pw@groupware.example.com', 'groupware']) {
      expect((await op.call('PUT', '/api/ops/link', { module: 'rooms', url })).status, url).toBe(400);
    }
    const staff = await t.loginAs(MOCK.staff);
    expect((await staff.call('PUT', '/api/ops/values', { rateLimitPerMinute: 30 })).status).toBe(403);
    expect((await staff.call('PUT', '/api/ops/link', { module: 'rooms', url: 'https://example.com' })).status).toBe(403);
    expect(await opsAudit(t.db)).toEqual([]);
    expect(t.ctx.ops.get().values.rateLimitPerMinute).toBe(20);
    await t.close();
  });
});
