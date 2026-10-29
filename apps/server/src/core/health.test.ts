import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { createTestApp, MOCK } from '../testing';
import { createTestDb } from './db/test-db';

// 배포 준비 회의(10/29) A5·C5·D1: 살아 있음과 받을 준비, 첫 보관 회차, 요청 번호, 떠 있는 판.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('건강 확인: 살아 있음과 받을 준비(배포 준비 회의 A5)', () => {
  it('live는 DB를 보지 않고, ready는 DB가 안 되거나 1초 안에 답하지 않으면 503이에요. 안쪽 정보(AI 공급자)는 내보내지 않아요', async () => {
    const t = await createTestApp();
    const query = t.db.query.bind(t.db);
    try {
      const ready = await t.app.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ ok: true, db: `${t.db.kind}-connected`, retention: 'done', build: 'dev', rulesVersion: expect.any(Number) });
      expect((await t.app.inject({ method: 'GET', url: '/health' })).json()).toEqual(ready.json());

      t.db.query = async () => {
        throw new Error('db down');
      };
      expect((await t.app.inject({ method: 'GET', url: '/health/live' })).json()).toEqual({ ok: true });
      const down = await t.app.inject({ method: 'GET', url: '/health/ready' });
      expect(down.statusCode).toBe(503);
      expect(down.json()).toMatchObject({ ok: false, db: `${t.db.kind}-error` });

      // 풀이 차서 DB가 답하지 않을 때도 관문 검사 시간 안에 503으로 답해요.
      t.db.query = () => new Promise(() => undefined);
      const hung = await t.app.inject({ method: 'GET', url: '/health/ready' });
      expect(hung.statusCode).toBe(503);
    } finally {
      t.db.query = query;
      await t.close();
    }
  });

  it('첫 보관 회차는 듣기 시작한 뒤에 돌고, 끝날 때까지 ready가 503이에요(앞선 회의 A6)', async () => {
    const db = await createTestDb();
    const { app } = await buildApp({ config: loadConfig({}), db, seed: false });
    try {
      const before = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(before.statusCode).toBe(503);
      expect(before.json()).toMatchObject({ retention: 'pending' });
      expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
      await app.listen({ port: 0, host: '127.0.0.1' });
      await vi.waitFor(async () => expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200), { timeout: 15_000, interval: 50 });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('보관 단계 하나가 실패해도 나머지 단계는 지우고, 실패한 단계 이름을 돌려줘요', async () => {
    const t = await createTestApp();
    try {
      vi.spyOn(t.ctx.notify, 'purge').mockRejectedValueOnce(new Error('boom'));
      const audit = vi.spyOn(t.ctx.audit, 'purge');
      const access = vi.spyOn(t.ctx.access, 'purge');
      expect(await t.runRetention()).toEqual(['notifications']);
      expect(audit).toHaveBeenCalledOnce();
      expect(access).toHaveBeenCalledOnce();
      expect(await t.runRetention()).toEqual([]);
    } finally {
      await t.close();
    }
  });
});

describe('요청 번호와 떠 있는 판(배포 준비 회의 C5·D1)', () => {
  it('요청 번호는 무작위(UUID)이고 응답 머리로 돌려줘요. 들어온 요청 번호 머리는 믿지 않고, 접속기록에도 무작위 번호가 남아요', async () => {
    const t = await createTestApp();
    try {
      const a = await t.app.inject({ method: 'GET', url: '/api/config/public', headers: { 'request-id': 'forged-id', 'x-request-id': 'forged-id' } });
      const b = await t.app.inject({ method: 'GET', url: '/api/config/public' });
      expect(a.headers['x-request-id']).toMatch(UUID);
      expect(b.headers['x-request-id']).toMatch(UUID);
      expect(b.headers['x-request-id']).not.toBe(a.headers['x-request-id']);
      expect(a.headers['x-desk-build']).toBe('dev');

      await t.loginAs(MOCK.staff);
      const { rows } = await t.db.query<{ request_id: string | null }>("select request_id from access_log where action = 'login'");
      expect(rows.at(-1)?.request_id).toMatch(UUID);
    } finally {
      await t.close();
    }
  });

  it('판은 DESK_BUILD에서 오고(없으면 dev), 응답 머리에 실을 수 있는 글자만 받아요', () => {
    expect(loadConfig({}).build).toBe('dev');
    expect(loadConfig({ DESK_BUILD: 'a1b2c3d' }).build).toBe('a1b2c3d');
    expect(() => loadConfig({ DESK_BUILD: 'bad value' })).toThrow(/DESK_BUILD/);
  });
});
