import type { OrderPlanView } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db, Queryable } from '../../core/db';
import { createTestDb } from '../../core/db/test-db';
import type { DeskUser } from '../../core/user';
import { createTestApp, MOCK } from '../../testing';
import { OrderService } from './order/service';
import { createBoardService } from './service';
import { fakeUser, postActionOf } from './test-kit';

// [M2·M3·L10] 판 쓰기·합치기와 주문안 확정·만들기의 잠금(docs/REVIEW.md).
// 시험 DB(PGlite)는 연결이 하나라 트랜잭션이 차례로 돌아서 진짜 경쟁은 재현하지 못해요(REVIEW M1).
// 그래서 (1) 차례로 부른 결과(상태 검사·409)와 (2) 실행한 SQL 순서(잠금 → 묶음·상태 읽기 → 쓰기)를 같이 봐요.
// 실제 PostgreSQL(TEST_DATABASE_URL)에서 두 연결로 겹치는 경쟁 시험은 다음 일이에요.

interface SqlCall {
  sql: string;
  params: unknown[];
}

/** 실행한 SQL과 매개변수를 차례로 적는 DB 감싸개 */
function recordSql(inner: Db, log: SqlCall[]): Db {
  const wrap = (q: Queryable): Queryable => ({
    query<T>(sql: string, params?: unknown[]) {
      log.push({ sql, params: params ?? [] });
      return q.query<T>(sql, params);
    },
  });
  return {
    kind: inner.kind,
    query<T>(sql: string, params?: unknown[]) {
      log.push({ sql, params: params ?? [] });
      return inner.query<T>(sql, params);
    },
    exec: (sql) => inner.exec(sql),
    tx<T>(fn: (q: Queryable) => Promise<T>) {
      return inner.tx((q) => fn(wrap(q)));
    },
    close: () => inner.close(),
  };
}

const at = (log: SqlCall[], re: RegExp, from = 0) => log.findIndex((c, i) => i >= from && re.test(c.sql));

const SHARE_LOCK = /from pantry_cards .*for share/is;
const UPDATE_LOCK = /from pantry_cards .*for update/is;

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const log: SqlCall[] = [];
  const inner = await createTestDb();
  const t = await createTestApp({ db: recordSql(inner, log) });
  opened.push({
    async close() {
      await t.close();
      await inner.close();
    },
  });
  t.ctx.ops.patchValues({ rateLimitPerMinute: 100_000 });
  const svc = createBoardService(t.ctx);
  await svc.seed({ demoCards: false });
  const order = new OrderService(t.ctx);
  const fac = fakeUser('fac', { facilities: true });
  const post = async (who: DeskUser, name: string) =>
    t.ctx.plans.direct(who, postActionOf(await svc.draftForName(who, name)).proposalToken, { itemName: name });
  const bundle = async (name: string) => (await svc.board(fac)).items.find((i) => i.name === name)!;
  const votes = async () => (await t.db.query('select pseudonym_id, card_id from pantry_votes order by 1, 2')).rows;
  const states = async () => (await t.db.query<{ id: number; state: string }>('select id, state from pantry_cards order by id')).rows.map((r) => r.state);
  return { t, svc, order, fac, log, post, bundle, votes, states };
}

describe('[M2] +1·거두기·게시는 묶음 대표 카드를 FOR SHARE로 잠근 뒤 상태(open)를 봐요', () => {
  it('[M2·I6] 주문안 확정 뒤에는 +1·거두기가 409(주문됨)이고 표 행은 그대로예요', async () => {
    const { svc, order, fac, post, bundle, votes } = await setup();
    const voter = fakeUser('v');
    await post(fakeUser('a'), '원두');
    const beans = await bundle('원두');
    await svc.vote(voter, beans.bundleId);
    await order.confirm(fac, (await order.create(fac, 1_000_000)).planId);

    const before = await votes();
    await expect(svc.vote(fakeUser('late'), beans.bundleId)).rejects.toMatchObject({ code: 'ordered', status: 409 });
    await expect(svc.withdraw(voter, beans.bundleId)).rejects.toMatchObject({ code: 'ordered', status: 409 });
    expect(await votes()).toEqual(before);
  });

  it('[M2] +1·거두기 SQL은 대표 카드 FOR SHARE 잠금 → 대표 다시 확인 → 표 쓰기 순서예요', async () => {
    const { svc, log, post, bundle } = await setup();
    const voter = fakeUser('v');
    await post(fakeUser('a'), '원두');
    const { bundleId } = await bundle('원두');

    log.length = 0;
    await svc.vote(voter, bundleId);
    const lock = at(log, SHARE_LOCK);
    expect(lock).toBeGreaterThan(-1);
    expect(log[lock]!.params).toEqual([[bundleId]]);
    // 잠근 뒤 대표가 그대로인지 다시 봐요(기다리는 사이 합치기·되돌리기가 끝났으면 처음부터 다시 해요).
    expect(at(log, /with recursive up/i, lock + 1)).toBeGreaterThan(lock);
    expect(at(log, /insert into pantry_votes/i)).toBeGreaterThan(lock);
    // 합치기·확정과 같은 FOR UPDATE는 쓰지 않아요(표끼리는 서로 막지 않아요, I8).
    expect(at(log, UPDATE_LOCK)).toBe(-1);

    log.length = 0;
    await svc.withdraw(voter, bundleId);
    const share = at(log, SHARE_LOCK);
    expect(share).toBeGreaterThan(-1);
    expect(at(log, /delete from pantry_votes/i)).toBeGreaterThan(share);
  });

  it('[M2] 게시 SQL은 같은 품목 후보 묶음을 FOR SHARE로 잠근 뒤 표시 행을 달고, 주문된 묶음에는 같은 품목 카드·표시 행이 없어요', async () => {
    const { t, svc, order, fac, log, post } = await setup();
    await post(fakeUser('a'), '제로콜라');
    await order.confirm(fac, (await order.create(fac, 1_000_000)).planId);
    // 주문된 묶음은 같은 품목 후보가 아니라서 바로 올라가고 표시 행도 없어요.
    expect((await post(fakeUser('b'), '코카콜라 제로 355')).status).toBe('done');
    expect((await t.db.query('select * from pantry_similar_flags')).rows).toEqual([]);

    // 열린 같은 품목: [새 요청으로] 게시가 대표 카드를 잠근 뒤 표시 행을 달아요.
    await post(fakeUser('c'), '녹차');
    const d = fakeUser('d');
    const same = await svc.draftForName(d, '녹차 티백');
    expect(same[0]!.variant).toBe('pantry-same');
    log.length = 0;
    expect((await t.ctx.plans.direct(d, postActionOf(same).proposalToken, { itemName: '녹차 티백' })).status).toBe('done');
    const lock = at(log, SHARE_LOCK);
    expect(lock).toBeGreaterThan(-1);
    expect(at(log, /insert into pantry_similar_flags/i)).toBeGreaterThan(lock);
    expect((await t.db.query('select source, state from pantry_similar_flags')).rows).toEqual([{ source: 'rule', state: 'showing' }]);
  });

  it('[M2·I8] 합치기 뒤 옛 대표 ID로 +1하면 새 묶음 대표에 붙고 409가 없어요', async () => {
    const { svc, fac, post, bundle } = await setup();
    await post(fakeUser('a'), '원두');
    await post(fakeUser('b'), '종이컵');
    const [x, y] = [await bundle('원두'), await bundle('종이컵')];
    const merged = await svc.merge(fac, { bundleIds: [x.bundleId, y.bundleId], versions: [x.bundleVersion, y.bundleVersion] });
    const old = merged.bundleId === x.bundleId ? y.bundleId : x.bundleId;
    const res = await svc.vote(fakeUser('v'), old);
    expect(res).toMatchObject({ bundleId: merged.bundleId, votes: 3, changed: true });
  });
});

describe('[M3] 주문안 확정은 넣을 묶음의 대표 카드를 FOR UPDATE로 먼저 잠근 뒤 묶음·버전을 읽어요', () => {
  it('[M3·R3] 주문안을 만든 뒤 합치기가 먼저 끝나면 확정이 409(order-stale)이고 아무것도 바뀌지 않아요', async () => {
    const { t, svc, order, fac, post, bundle, states } = await setup();
    for (const [i, name] of ['원두', '종이컵', '녹차'].entries()) await post(fakeUser(`p${i}`), name);
    const plan = await order.create(fac, 1_000_000);
    const [x, y] = [await bundle('원두'), await bundle('종이컵')];
    await svc.merge(fakeUser('fac2', { facilities: true }), { bundleIds: [x.bundleId, y.bundleId], versions: [x.bundleVersion, y.bundleVersion] });

    await expect(order.confirm(fac, plan.planId)).rejects.toMatchObject({ code: 'order-stale', status: 409 });
    expect(await states()).toEqual(['open', 'open', 'open']);
    expect((await t.db.query("select count(*)::int as n from pantry_cycles where state = 'closed'")).rows[0]).toEqual({ n: 0 });
  });

  it('[M3·R3] 확정이 먼저 끝나면 그 묶음이 든 합치기가 409(conflict)예요', async () => {
    const { svc, order, fac, post, bundle } = await setup();
    await post(fakeUser('a'), '원두');
    const beans = await bundle('원두');
    await order.confirm(fac, (await order.create(fac, 1_000_000)).planId);
    await post(fakeUser('b'), '종이컵');
    const cup = await bundle('종이컵');
    // 화면이 확정 전에 본 버전 그대로 합치기를 눌러도, 주문된 묶음이라 409예요.
    await expect(svc.merge(fac, { bundleIds: [beans.bundleId, cup.bundleId], versions: [beans.bundleVersion, cup.bundleVersion] })).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
  });

  it('[M3] 확정 SQL은 대표·묶인 카드 FOR UPDATE(ID 순) → 묶음·버전 다시 읽기 → 주문됨 바꾸기 순서예요', async () => {
    const { svc, order, fac, log, post, bundle } = await setup();
    for (const [i, name] of ['원두', '종이컵', '녹차'].entries()) await post(fakeUser(`p${i}`), name);
    const [x, y, tea] = [await bundle('원두'), await bundle('종이컵'), await bundle('녹차')];
    await svc.merge(fac, { bundleIds: [x.bundleId, y.bundleId], versions: [x.bundleVersion, y.bundleVersion] });
    const plan: OrderPlanView = await order.create(fac, 1_000_000);
    expect(plan.lines.filter((l) => l.included)).toHaveLength(2);

    log.length = 0;
    await order.confirm(fac, plan.planId);
    const lock = at(log, UPDATE_LOCK);
    expect(lock).toBeGreaterThan(-1);
    // 묶인 카드까지 ID 순서로 한 번에 잠가요(되돌리기와 같은 순서라 서로 기다리다 멈추지 않아요).
    expect(log[lock]!.params).toEqual([[x.bundleId, y.bundleId, tea.bundleId].sort((a, b) => a - b)]);
    const reread = at(log, /with recursive edges/i, lock + 1);
    expect(reread).toBeGreaterThan(lock);
    expect(at(log, /update pantry_cards set state = 'ordered'/i)).toBeGreaterThan(reread);
  });
});

describe('[L10] 주문안을 동시에 두 번 만들어도 500이 없어요', () => {
  it('[L10] 두 만들기를 동시에 보내면 둘 다 성공하고, 고치는 중인 초안은 하나예요(차례로 처리)', async () => {
    const { t, post } = await setup();
    await post(fakeUser('a'), '원두');
    const facilities = await t.loginAs(MOCK.facilities);
    const both = await Promise.all([60_000, 70_000].map((budget) => facilities.call('POST', '/api/pantry/order/plans', { budget })));
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    const { rows } = await t.db.query<{ status: string }>('select status from pantry_order_plans order by status');
    expect(rows.map((r) => r.status)).toEqual(['draft', 'replaced']);
  });

  it('[L10] 만들기 SQL은 주문안 만들기 잠금(advisory) → 묶음 읽기 → 옛 초안 replaced → 새 초안 넣기 순서예요', async () => {
    const { order, fac, log, post } = await setup();
    await post(fakeUser('a'), '원두');
    log.length = 0;
    await order.create(fac, 60_000);
    const lock = log.findIndex((c) => /pg_advisory_xact_lock/i.test(c.sql) && c.params[0] === 'pantry:order-plan-create');
    expect(lock).toBeGreaterThan(-1);
    const read = at(log, /with recursive edges/i, lock + 1);
    expect(read).toBeGreaterThan(lock);
    const replace = at(log, /set status = 'replaced'/i);
    expect(replace).toBeGreaterThan(read);
    expect(at(log, /insert into pantry_order_plans/i)).toBeGreaterThan(replace);
  });
});
