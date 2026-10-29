import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { insertCard, insertFlag, insertMerge, insertVote } from '../modules/pantry/repo';
import { createTestApp, MOCK } from '../testing';
import { applyMigrations, pendingMigrations } from './db';
import { createPgliteDb } from './db/pglite';
import { errorSummary } from './logging';

// 출시 준비 서버 코드(1-C): 배포 준비(L-17)·마이그레이션 시작 적용 끄기(L-22)·로그 가리기(L-28)·보관 기간 지우기(L-33).

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

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
      expect(res.json()).toMatchObject({ ok: false, db: `${t.db.kind}-error` });
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

describe('보관 기간 지우기(L-33, ADR-21 7일)', () => {
  const count = async (t: TestApp, table: string, where = 'true') =>
    (await t.db.query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`)).rows[0]!.n;
  const ago = (t: TestApp, ms: number) => new Date(t.now() - ms).toISOString();

  it('화면을 열지 않아도 정해진 시각에 7일 지난 문의·알림이 지워져요', async () => {
    const t = await createTestApp({ retentionTimer: false });
    await t.modules.find((m) => m.kind === 'navi')!.seed!();
    const doyun = await t.loginAs(MOCK.dev);
    const sent = await doyun.call('POST', '/api/navi/inquiries', { rowId: 'FIN-01', question: '보관 시험 문의', reason: '보관 시험', requestId: randomUUID() });
    expect(sent.status).toBe(200);
    expect(await count(t, 'navi_inquiries')).toBe(1);
    expect(await count(t, 'notifications')).toBeGreaterThan(0);

    t.advance(6 * DAY);
    await t.runRetention();
    expect(await count(t, 'notifications')).toBeGreaterThan(0);
    expect(await count(t, 'navi_inquiries')).toBe(1);

    t.advance(2 * DAY); // 8일
    await t.runRetention();
    expect(await count(t, 'notifications')).toBe(0);
    expect(await count(t, 'navi_inquiries')).toBe(0);
    await t.close();
  });

  it('회의실은 끝난 지 7일 지난 예약과 취소한 지 7일 지난 이력만 지우고, 앞으로 할 예약은 남겨요', async () => {
    const t = await createTestApp({ retentionTimer: false });
    await t.modules.find((m) => m.kind === 'rooms')!.seed!();
    const doyun = await t.loginAs(MOCK.dev);
    // 시계는 10월 26일(월) 09:00. 내일(27일) 15~16시와 다음 주 수요일(11월 4일) 15~16시를 채팅으로 잡아요.
    for (const text of ['내일 3시 6명 잡아 줘', '다음 주 수요일 3시 4명 잡아 줘']) {
      const res = await doyun.call('POST', '/api/rooms/chat', { text, requestId: randomUUID() });
      expect(res.status).toBe(200);
    }
    const mine = "source = 'app'";
    expect(await count(t, 'room_reservations', mine)).toBe(2);
    await t.db.query(
      "insert into room_reservation_history (id, room_id, slot, pseudonym_id, plan_id, created_at, cancelled_at) values (999001, '3A', tstzrange($1, $2, '[)'), 'p_test', $3, $1, $1)",
      [ago(t, 8 * DAY), ago(t, 8 * DAY - HOUR), randomUUID()],
    );

    t.advance(8 * DAY + 6 * HOUR); // 11월 3일 15:00: 27일 회의는 끝난 지 6일 23시간
    await t.runRetention();
    expect(await count(t, 'room_reservations', mine)).toBe(2);
    expect(await count(t, 'room_reservation_history')).toBe(0);

    t.advance(2 * HOUR); // 끝난 지 7일 1시간
    await t.runRetention();
    expect(await count(t, 'room_reservations', mine)).toBe(1);
    const left = await t.db.query<{ starts: Date }>("select lower(slot) as starts from room_reservations where source = 'app'");
    expect(new Date(left.rows[0]!.starts).toISOString()).toBe('2026-11-04T06:00:00.000Z');
    await t.close();
  });

  it('같이 채워요는 올린 지 7일 지난 요청·주문 확정 7일 지난 요청·주문안을 지우고, 묶음이 바뀌면 남은 카드 번호를 올려요', async () => {
    const t = await createTestApp({ retentionTimer: false });
    const card = async (name: string, createdAgo: number) =>
      (await insertCard(t.db, {
        floor: '3층',
        itemName: name,
        catalogItemId: null,
        authorPseudonymId: 'p_test_a',
        postedCycleNo: 1,
        postKey: randomUUID(),
        createdAt: ago(t, createdAgo),
      }))!;
    const oldOpen = await card('오래된 요청', 8 * DAY);
    const newOpen = await card('새 요청', 1 * DAY);
    const merged = await card('새로 합친 요청', 2 * DAY);
    const oldOrdered = await card('지난주 주문', 12 * DAY);
    const newOrdered = await card('이번 주 주문', 12 * DAY);
    const leftOut = await card('예산 초과로 빠진 요청', 9 * DAY);
    await insertVote(t.db, 'p_test_b', oldOpen, ago(t, 8 * DAY));
    await insertVote(t.db, 'p_test_b', newOpen, ago(t, 1 * DAY));
    await insertFlag(t.db, oldOpen, newOpen, 'rule');
    await insertMerge(t.db, merged, oldOpen, 'p_test_f', ago(t, 2 * DAY));
    await t.db.query("update pantry_cards set state = 'ordered' where id = any($1::bigint[])", [[oldOrdered, newOrdered]]);
    await t.db.query('update pantry_cards set ordered_batch_at = $2 where id = $1', [oldOrdered, ago(t, 8 * DAY)]);
    await t.db.query('update pantry_cards set ordered_batch_at = $2 where id = $1', [newOrdered, ago(t, 2 * DAY)]);
    const plan = async (status: string, createdAgo: number, confirmedAgo: number | null, bundles: number[]) => {
      const id = randomUUID();
      await t.db.query(
        "insert into pantry_order_plans (id, status, budget, floor_basis, created_at, confirmed_at) values ($1, $2, 100000, '[]'::jsonb, $3, $4)",
        [id, status, ago(t, createdAgo), confirmedAgo === null ? null : ago(t, confirmedAgo)],
      );
      for (const [i, bundle] of bundles.entries()) {
        await t.db.query(
          `insert into pantry_order_lines (plan_id, line_no, bundle_id, bundle_version, floor, item_name, votes, quantity, amount, included, reason, rank, explanation, explanation_source)
           values ($1, $2, $3, 0, '3층', '품목', 1, 1, 1000, true, '표 대비 값', $2, '설명', 'template')`,
          [id, i + 1, bundle],
        );
      }
      return id;
    };
    const oldConfirmed = await plan('confirmed', 9 * DAY, 8 * DAY, [oldOrdered]);
    const newConfirmed = await plan('confirmed', 3 * DAY, 2 * DAY, [newOrdered, leftOut]);
    const draft = await plan('draft', 1 * DAY, null, [oldOpen, newOpen]);

    await t.runRetention();
    const ids = (await t.db.query<{ id: number }>('select id from pantry_cards order by id')).rows.map((r) => Number(r.id));
    expect(ids).toEqual([newOpen, merged, newOrdered, leftOut]);
    const plans = (await t.db.query<{ id: string }>('select id from pantry_order_plans')).rows.map((r) => r.id);
    expect(plans).toEqual([newConfirmed]);
    expect(plans).not.toContain(oldConfirmed);
    expect(plans).not.toContain(draft);
    expect(await count(t, 'pantry_votes')).toBe(1);
    expect(await count(t, 'pantry_similar_flags')).toBe(0);
    expect(await count(t, 'pantry_merges')).toBe(0);
    const version = await t.db.query<{ v: number }>('select bundle_version as v from pantry_cards where id = $1', [merged]);
    expect(version.rows[0]!.v).toBe(1);

    // 예산 초과로 빠진 요청은 그 주문안이 지워질 때(확정 7일 뒤) 같이 지워져요.
    t.advance(6 * DAY + HOUR); // 새 요청도 올린 지 7일 1시간
    await t.runRetention();
    const after = (await t.db.query<{ id: number }>('select id from pantry_cards order by id')).rows.map((r) => Number(r.id));
    expect(after).toEqual([]);
    expect(await count(t, 'pantry_order_plans')).toBe(0);
    await t.close();
  });

  it('감사 기록·실행 영수증·끝난 plan·AI 사용량·"틀렸어요"·시연 받은편지함은 7일, 접속기록은 1년이에요', async () => {
    const t = await createTestApp({ retentionTimer: false });
    const old = ago(t, 8 * DAY);
    const recent = ago(t, 1 * DAY);
    for (const at of [old, recent]) {
      await t.db.query("insert into audit_log (at, pseudonym_id, channel, result) values ($1, 'p_test', 'ask', 'ok')", [at]);
      await t.db.query(
        "insert into action_receipts (idempotency_key, pseudonym_id, module, action, result, created_at) values ($1, 'p_test', 'rooms', 'reserve', '{}'::jsonb, $2)",
        [randomUUID(), at],
      );
      await t.db.query("insert into ai_usage (at, module, purpose, provider, ok) values ($1, 'navi', 'pick', 'fake', true)", [at]);
      await t.db.query("insert into navi_feedback (predicted_kind, reason_code, at) values ('navi', 'not-listed', $1)", [at]);
      await t.db.query(
        "insert into plans (id, pseudonym_id, module, action, params, created_at, expires_at, state) values ($1, 'p_test', 'rooms', 'reserve', '{}'::jsonb, $2, $2, 'done')",
        [randomUUID(), at],
      );
      await t.db.query("insert into mock_messenger_messages (to_email, text, sent_at) values ('demo@corp.example', '시연', $1)", [at]);
      await t.db.query(
        "insert into mock_calendar_events (uid, title, starts_at, ends_at, location, organizer_email, updated_at) values ($1, '시연 회의', $2, $2, '3A', 'demo@corp.example', $2)",
        [randomUUID(), at],
      );
      await t.db.query("insert into access_log (at, pseudonym_id, action) values ($1, 'p_test', 'login')", [at]);
    }
    // 실행 중인 plan은 오래돼도 남겨요.
    await t.db.query(
      "insert into plans (id, pseudonym_id, module, action, params, created_at, expires_at, state) values ($1, 'p_test', 'rooms', 'reserve', '{}'::jsonb, $2, $2, 'executing')",
      [randomUUID(), old],
    );

    await t.runRetention();
    for (const table of ['audit_log', 'action_receipts', 'ai_usage', 'navi_feedback', 'mock_messenger_messages', 'mock_calendar_events']) {
      expect(await count(t, table), table).toBe(1);
    }
    expect(await count(t, 'plans')).toBe(2);
    expect(await count(t, 'plans', "state = 'executing'")).toBe(1);
    expect(await count(t, 'access_log')).toBe(2);
    await t.close();
  });
});
