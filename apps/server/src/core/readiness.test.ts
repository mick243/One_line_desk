import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { createTestApp, MOCK } from '../testing';
import { applyMigrations, pendingMigrations } from './db';
import { createPgliteDb } from './db/pglite';
import { errorSummary } from './logging';

// 출시 준비 서버 코드(1-C): 배포 준비(L-17)·마이그레이션 시작 적용 끄기(L-22)·로그 가리기(L-28)·보관 기간 지우기(L-33).

const DAY = 24 * 60 * 60_000;

describe('배포 준비(L-17)', () => {
  it('DB가 안 되면 /health는 503이에요', async () => {
    const t = await createTestApp();
    expect((await t.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const query = t.db.query.bind(t.db);
    t.db.query = async () => {
      throw new Error('db down');
    };
    try {
      const res = await t.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, db: 'pglite-error' });
    } finally {
      t.db.query = query;
      await t.close();
    }
  });

  it('API 응답에는 기본 머리(nosniff·no-store·no-referrer)가 붙어요', async () => {
    const t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/config/public' });
    expect(res.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    await t.close();
  });

  it('운영은 0.0.0.0에서 듣고, 개발은 localhost예요. 프록시는 넣은 것만 믿어요', () => {
    expect(loadConfig({}).host).toBe('localhost');
    expect(loadConfig({ HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: '10.0.0.0/8' }).trustProxy).toBe('10.0.0.0/8');
  });
});

describe('마이그레이션(L-22)', () => {
  it('시작 적용을 끄면 빠진 마이그레이션이 있을 때 뜨지 않고, 두 번 적용해도 한 번만 들어가요', async () => {
    const db = await createPgliteDb();
    try {
      const config = loadConfig({ DESK_MIGRATE_ON_START: 'false' });
      expect(config.migrateOnStart).toBe(false);
      await expect(buildApp({ config, db, seed: false })).rejects.toThrow(/npm run db:migrate/);
      expect((await pendingMigrations(db)).length).toBeGreaterThan(0);

      const first = await applyMigrations(db);
      expect(first.length).toBeGreaterThan(0);
      expect(await applyMigrations(db)).toEqual([]);
      expect(await pendingMigrations(db)).toEqual([]);

      const { app } = await buildApp({ config, db, seed: false, retentionTimer: false });
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      await app.close();
    } finally {
      await db.close();
    }
  });
});

describe('앱 로그 가리기(L-28)', () => {
  it('묻기 글·쿼리(OIDC 코드)·검색어·IP가 앱 로그에 남지 않아요', async () => {
    const lines: string[] = [];
    const t = await createTestApp({ logger: { level: 'debug', stream: { write: (line: string) => void lines.push(line) } } });
    const me = await t.loginAs(MOCK.dev);
    await me.call('POST', '/api/ask', { text: '법인카드 LOGCANARY1 잃어버렸어요' });
    await t.app.inject({ method: 'GET', url: '/api/auth/oidc/callback?code=LOGCANARY2&state=LOGCANARY3' });
    await me.call('POST', '/api/people/search', { query: 'LOGCANARY4' });
    await me.call('GET', '/api/pantry/board?floor=LOGCANARY5');
    await me.call('POST', '/api/navi/inquiries', { rowId: 'FIN-01', question: 'LOGCANARY6 \u0000', reason: '시험', requestId: randomUUID() });
    await t.close();

    const log = lines.join('\n');
    expect(lines.length).toBeGreaterThan(5);
    expect(log).toContain('/api/auth/oidc/callback');
    expect(log).not.toMatch(/LOGCANARY|code=|state=|remoteAddress|remotePort|127\.0\.0\.1|user-agent|cookie/i);
  });

  it('오류 요약에는 오류 글이 들어가지 않아요', () => {
    let err: unknown;
    try {
      new URL('LOGCANARY7 not a url');
    } catch (e) {
      err = e;
    }
    const summary = errorSummary(err);
    expect(summary.name).toBe('TypeError');
    expect(JSON.stringify(summary)).not.toContain('LOGCANARY7');
  });
});

describe('보관 기간 지우기(L-33)', () => {
  it('화면을 열지 않아도 정해진 시각에 91일 지난 문의·31일 지난 알림이 지워져요', async () => {
    const t = await createTestApp({ retentionTimer: false });
    await t.modules.find((m) => m.kind === 'navi')!.seed!();
    const doyun = await t.loginAs(MOCK.dev);
    const sent = await doyun.call('POST', '/api/navi/inquiries', { rowId: 'FIN-01', question: '보관 시험 문의', reason: '보관 시험', requestId: randomUUID() });
    expect(sent.status).toBe(200);
    const count = async (table: string) => (await t.db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;
    expect(await count('navi_inquiries')).toBe(1);
    expect(await count('notifications')).toBeGreaterThan(0);

    t.advance(29 * DAY);
    await t.runRetention();
    expect(await count('notifications')).toBeGreaterThan(0);

    t.advance(2 * DAY); // 31일
    await t.runRetention();
    expect(await count('notifications')).toBe(0);
    expect(await count('navi_inquiries')).toBe(1);

    t.advance(60 * DAY); // 91일
    await t.runRetention();
    expect(await count('navi_inquiries')).toBe(0);
    await t.close();
  });
});
