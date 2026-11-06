import type { CafeOrderLineInput, CafeResponse, CafeSettleResponse, NotificationsResponse, PlanConfirmResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { pseudonymize } from '../../core/pseudonym';
import { createTestApp, MOCK } from '../../testing';

// F4 사내 카페 3묶음(11/6, PRD F4-5·완료 기준, ADR-29): [못 받았어요].
// 직원이 자기 주문이 나왔어요·가져감인 그날 [못 받았어요](고정 버튼, 사유 없음)를 누르면 총무 역할에게 알림이 가고,
// 총무가 S9에서 [청구에서 빼기]·[그대로 두기]를 눌러요. 뺀 주문은 청구 합계·한 달 한도·매출 합계에서 빠져요.
// 시계는 2026-10-26(월) 09:00(한국)에서 시작해요. 10월 주문은 11월 1일 0시 뒤 첫 보관 회차에서 청구돼요.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
type On = Extract<CafeResponse, { status: 'on' }>;

const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const LATTE2: CafeOrderLineInput[] = [{ menuId: 'latte', qty: 2, options: [] }]; // 5,000원
const AMERICANO1: CafeOrderLineInput[] = [{ menuId: 'americano', qty: 1, options: ['아이스'] }]; // 2,000원
const DAY = 24 * 60 * 60_000;

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  await t.modules.find((m) => m.kind === 'cafeteria')!.seed!();
  await t.ctx.ops.setModule('p_test-operator', 'cafeteria', 'on');
  const s = await people(t);
  expect((await s.barista.call('POST', '/api/cafe/board/open')).status).toBe(200);
  return { t, ...s };
}

/** 시계를 옮기면 세션이 끊겨서 모두 다시 로그인하고, 카페 판을 한 번 읽어 "영업 중"을 이어요. */
async function people(t: TestApp) {
  const staff = await t.loginAs(MOCK.staff);
  const dev = await t.loginAs(MOCK.dev);
  const hr = await t.loginAs(MOCK.hr);
  const facilities = await t.loginAs(MOCK.facilities);
  const barista = await t.loginAs(MOCK.barista);
  await barista.call('GET', '/api/cafe/board');
  return { staff, dev, hr, facilities, barista };
}

async function jumpTo(t: TestApp, iso: string) {
  t.advance(Date.parse(iso) - t.now());
  return people(t);
}

async function view(me: Session): Promise<On> {
  const res = await me.call('GET', '/api/cafe');
  expect(res.status).toBe(200);
  return res.body;
}

async function order(me: Session, lines: CafeOrderLineInput[]): Promise<string> {
  const slot = (await view(me)).slots[0]!.start;
  const p = await me.call('POST', '/api/cafe/order/propose', { lines, pickupSlot: slot });
  expect(p.status).toBe(200);
  const created = await me.call('POST', '/api/plans', { proposalToken: p.body.proposalToken });
  const done = (await me.call('POST', `/api/plans/${created.body.planId}/confirm`)).body as PlanConfirmResponse;
  if (done.status !== 'done') throw new Error(`주문이 들어가지 않았어요: ${done.status}`);
  return done.card.id.replace('cafe-order-', '');
}

/** 바리스타가 받기 → 다 됐어요(→ 가져갔어요) */
async function serve(barista: Session, id: string, picked = false) {
  for (const to of ['making', 'ready', ...(picked ? ['picked'] : [])])
    expect((await barista.call('POST', `/api/cafe/orders/${id}/status`, { to })).status).toBe(200);
}

const missed = (me: Session, id: string) => me.call('POST', `/api/cafe/orders/${id}/missed`);
const decide = (me: Session, id: string, how: 'remove' | 'keep') => me.call('POST', `/api/cafe/missed/${id}/${how}`);

async function settle(me: Session, month?: string): Promise<CafeSettleResponse> {
  const res = await me.call('GET', `/api/cafe/settle${month ? `?month=${month}` : ''}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function titles(me: Session): Promise<string[]> {
  return ((await me.call('GET', '/api/notifications')).body as NotificationsResponse).items.map((i) => i.title);
}

async function bills(t: TestApp) {
  const { rows } = await t.db.query<{ id: string; pseudonym_id: string; total_won: number; order_count: number; status: string }>(
    'select id::text as id, pseudonym_id, total_won, order_count, status from cafe_bills order by id',
  );
  return rows;
}

/** 청구 합계 다시 세기: 그 사람 그 달 주문 행(취소·청구에서 뺀 주문 뺌) */
async function recount(t: TestApp, pseudonymId: string, month: string) {
  const { rows } = await t.db.query<{ won: number; n: number }>(
    `select coalesce(sum(total_won), 0)::int as won, count(*)::int as n from cafe_orders
      where pseudonym_id = $1 and status <> 'cancelled' and missed_status is distinct from 'removed' and to_char(order_day, 'YYYY-MM') = $2`,
    [pseudonymId, month],
  );
  return rows[0]!;
}

const pid = (t: TestApp, subject: string) => pseudonymize(t.ctx.config.pseudonymSecret, subject);

describe('[F4-5] [못 받았어요] 신고', () => {
  it('[F4-5] 본인 주문이고 그날 나왔어요·가져감일 때만 돼요(사유 없이 고정 버튼). 두 번 눌러도 한 번이에요', async () => {
    const { t, staff, dev, barista } = await setup();
    const waiting = await order(staff, AMERICANO1);
    expect((await missed(staff, waiting)).body).toMatchObject({ error: 'not-ready', message: '음료가 나온 뒤에 누를 수 있어요' });
    expect((await view(staff)).orders[0]).toMatchObject({ status: 'waiting', missed: null, canReportMissed: false });

    await serve(barista, waiting);
    expect((await view(staff)).orders[0]).toMatchObject({ status: 'ready', missed: null, canReportMissed: true });
    // 남의 주문은 있는지도 알려 주지 않아요.
    expect((await missed(dev, waiting)).status).toBe(404);
    const first = await missed(staff, waiting);
    expect(first).toEqual({ status: 200, body: { id: waiting, missed: 'reported' } });
    expect(await missed(staff, waiting)).toEqual(first);
    expect((await view(staff)).orders[0]).toMatchObject({ missed: 'reported', canReportMissed: false });

    // 가져감도 돼요. 다음 날에는 안 돼요(총무에게 직접 말해요). 취소한 주문은 안 돼요.
    const picked = await order(staff, LATTE2);
    await serve(barista, picked, true);
    const cancelled = await order(staff, LATTE2);
    expect((await staff.call('POST', `/api/cafe/orders/${cancelled}/cancel`)).status).toBe(200);
    expect((await missed(staff, cancelled)).status).toBe(409);
    const s2 = await jumpTo(t, '2026-10-27T09:00:00+09:00');
    expect((await missed(s2.staff, picked)).body).toMatchObject({ error: 'not-today' });
    // 카페 판에는 신고 칸이 없어요(번호·메뉴·옵션·픽업 칸만).
    expect(JSON.stringify((await s2.barista.call('GET', '/api/cafe/board')).body)).not.toContain('missed');
  });

  it('[F4-5·ADR-29 시험] 총무 역할에게만 "카페 못 받은 주문 확인 요청이 왔어요"가 가고, 알림에 이름·메뉴·금액이 없어요', async () => {
    const { t, staff, dev, facilities, barista } = await setup();
    const id = await order(staff, AMERICANO1);
    await serve(barista, id);
    expect((await missed(staff, id)).status).toBe(200);
    expect(await titles(facilities)).toEqual(['카페 못 받은 주문 확인 요청이 왔어요']);
    for (const me of [dev, barista]) expect(await titles(me)).toEqual([]);
    // 신고한 본인에게는 "나왔어요" 알림만 있어요.
    expect(await titles(staff)).toEqual(['주문한 음료가 나왔어요']);
    const { rows } = await t.db.query('select * from notifications');
    const text = JSON.stringify(rows);
    // 알림 글에는 종류만 있어요(보낸 사람 빼기용 가명 ID 칸만 있고, 이름·메뉴·금액은 없어요).
    for (const secret of ['하늘', '재무팀', '아메리카노', '아이스', '2,000', '2000', '원']) expect(text).not.toContain(secret);
    const { rows: roleRows } = await t.db.query<{ audience_role: string; page: string }>(
      "select audience_role, page from notifications where title = '카페 못 받은 주문 확인 요청이 왔어요'",
    );
    expect(roleRows).toEqual([{ audience_role: 'facilities', page: 'cafe-settle' }]);
  });
});

describe('[F4-5] 총무의 [못 받았어요] 확인', () => {
  it('[F4 완료 기준] 총무가 아니면 403이에요. 처리는 한 번이고, 내 신고는 다른 총무가 처리해요', async () => {
    const { staff, dev, facilities, barista } = await setup();
    const id = await order(staff, AMERICANO1);
    await serve(barista, id);
    await missed(staff, id);
    for (const me of [staff, dev, barista]) {
      expect((await decide(me, id, 'remove')).status).toBe(403);
      expect((await decide(me, id, 'keep')).status).toBe(403);
    }
    const removed = await decide(facilities, id, 'remove');
    expect(removed).toEqual({ status: 200, body: { id, status: 'removed' } });
    expect(await decide(facilities, id, 'remove')).toEqual(removed);
    expect((await decide(facilities, id, 'keep')).body).toMatchObject({ error: 'already-decided' });
    // 신고하지 않은 주문은 처리할 게 없어요.
    const plain = await order(dev, AMERICANO1);
    expect((await decide(facilities, plain, 'remove')).status).toBe(404);

    // 총무 본인이 신고한 주문은 다른 총무가 처리해요.
    const own = await order(facilities, AMERICANO1);
    await serve(barista, own);
    expect((await missed(facilities, own)).status).toBe(200);
    expect((await decide(facilities, own, 'remove')).body).toMatchObject({ error: 'own-request', message: '내 신고는 다른 총무가 처리해요' });
  });

  it('[F4-5·ADR-20] S9 "못 받았어요 확인" 칸에 픽업 번호·메뉴·픽업 칸·이름(디렉터리)이 있고, 볼 때·처리할 때 접속기록에 가명 ID가 남아요', async () => {
    const { t, staff, facilities, barista } = await setup();
    const id = await order(staff, AMERICANO1);
    await serve(barista, id);
    await missed(staff, id);
    const s = await settle(facilities);
    expect(s.missed).toEqual([
      {
        id,
        dayLabel: '10월 26일(월)',
        pickupNo: 1,
        lines: [{ name: '아메리카노', options: ['아이스'], qty: 1 }],
        pickupLabel: '09:10–09:20',
        name: '가상 직원 하늘',
        totalWon: 2000,
        status: 'reported',
        reportedLabel: '10월 26일(월) 09:00',
      },
    ]);
    expect((await decide(facilities, id, 'keep')).status).toBe(200);
    expect((await settle(facilities)).missed.map((m) => m.status)).toEqual(['kept']);
    const { rows } = await t.db.query<{ action: string; subject_refs: string[] }>(
      "select action, subject_refs from access_log where action like 'cafe.%' order by id",
    );
    const ref = `person:${pid(t, MOCK.staff)}`;
    expect(rows).toEqual([
      { action: 'cafe.settle', subject_refs: [ref] },
      { action: 'cafe.update', subject_refs: [ref] },
      { action: 'cafe.settle', subject_refs: [ref] },
    ]);
    // 처리한 신고는 7일 동안 보이고 그 뒤 칸에서 빠져요(그대로 둔 주문은 청구서 보관 규칙을 따라 남아요).
    const later = await jumpTo(t, '2026-11-03T09:00:00+09:00');
    expect((await settle(later.facilities)).missed).toEqual([]);
    expect((await t.db.query('select 1 from cafe_orders where id = $1', [id])).rows).toHaveLength(1);
  });

  it('[F4-5·F4 완료 기준] 뺀 주문은 이번 달 합계·한도·청구서·매출 합계에서 빠지고, 청구 합계는 주문 행에서 다시 센 값과 같아요. 그대로 두면 남아요', async () => {
    const { t, staff, dev, facilities, barista } = await setup();
    t.ctx.ops.patchValues({ cafeMonthlyLimitWon: 10_000 });
    await order(staff, LATTE2);
    const lost = await order(staff, AMERICANO1);
    await serve(barista, lost, true);
    const kept = await order(dev, AMERICANO1);
    await serve(barista, kept, true);
    await missed(staff, lost);
    await missed(dev, kept);
    expect((await view(staff)).monthTotalWon).toBe(7000);
    expect((await decide(facilities, lost, 'remove')).status).toBe(200);
    expect((await decide(facilities, kept, 'keep')).status).toBe(200);

    const mine = await view(staff);
    expect(mine.monthTotalWon).toBe(5000);
    expect(mine.billing.leftWon).toBe(5000);
    expect((await view(dev)).monthTotalWon).toBe(2000);
    // 한도(1만 원): 뺀 2,000원만큼 다시 주문할 수 있어요(라테 둘 5,000원 = 남은 한도 5,000원).
    expect((await staff.call('POST', '/api/cafe/order/propose', { lines: LATTE2, pickupSlot: mine.slots[1]!.start })).status).toBe(200);
    expect(await titles(staff)).toContain('못 받은 카페 주문을 청구에서 뺐어요');
    expect(await titles(dev)).toContain('못 받은 카페 주문은 청구에 그대로 있어요');

    // 11월 1일 청구: 뺀 주문은 청구서·건별 내역·매출 합계에 없어요.
    const nov = await jumpTo(t, '2026-11-01T00:30:00+09:00');
    expect(await t.runRetention()).toEqual([]);
    const all = await bills(t);
    const staffBill = all.find((b) => b.pseudonym_id === pid(t, MOCK.staff))!;
    const devBill = all.find((b) => b.pseudonym_id === pid(t, MOCK.dev))!;
    expect([staffBill.total_won, staffBill.order_count]).toEqual([5000, 1]);
    expect([devBill.total_won, devBill.order_count]).toEqual([2000, 1]);
    for (const [subject, bill] of [
      [MOCK.staff, staffBill],
      [MOCK.dev, devBill],
    ] as const)
      expect(await recount(t, pid(t, subject), '2026-10')).toEqual({ won: bill.total_won, n: bill.order_count });
    const myBill = (await view(nov.staff)).billing.bills[0]!;
    expect(myBill.orders.map((o) => o.totalWon)).toEqual([5000]);
    const csv = await t.app.inject({ method: 'GET', url: '/api/cafe/sales.csv?month=2026-10', headers: { cookie: nov.facilities.cookie } });
    expect(csv.body).toContain('카페라테,2,5000');
    expect(csv.body).toContain('합계,,3,7000');
  });

  it('[F4-5] 청구서가 나온 뒤에 빼면 입금 확인 전 청구서는 합계를 주문 행에서 다시 세고(0원이면 입금 확인), 입금을 확인한 청구서에서는 빼지 않아요', async () => {
    const { t } = await setup();
    const oct31 = await jumpTo(t, '2026-10-31T09:00:00+09:00');
    await oct31.barista.call('POST', '/api/cafe/board/open');
    await order(oct31.staff, LATTE2);
    const staffLost = await order(oct31.staff, AMERICANO1);
    const devLost = await order(oct31.dev, AMERICANO1);
    const hrLost = await order(oct31.hr, AMERICANO1);
    for (const id of [staffLost, devLost, hrLost]) await serve(oct31.barista, id);
    await missed(oct31.staff, staffLost);
    await missed(oct31.dev, devLost);
    await missed(oct31.hr, hrLost);

    const nov = await jumpTo(t, '2026-11-01T00:30:00+09:00');
    expect(await t.runRetention()).toEqual([]);
    const byPerson = async () => new Map((await bills(t)).map((b) => [b.pseudonym_id, b]));
    let now = await byPerson();
    expect(now.get(pid(t, MOCK.staff))).toMatchObject({ total_won: 7000, order_count: 2, status: 'unpaid' });
    expect(now.get(pid(t, MOCK.dev))).toMatchObject({ total_won: 2000, status: 'unpaid' });

    // 지후는 먼저 입금했어요. 입금을 확인한 청구서에서는 빼지 않아요(앱은 돈을 돌려주지 않아요). 그대로 두기는 돼요.
    const hrBill = now.get(pid(t, MOCK.hr))!;
    expect((await nov.facilities.call('POST', `/api/cafe/bills/${hrBill.id}/paid`)).status).toBe(200);
    const blocked = await decide(nov.facilities, hrLost, 'remove');
    expect(blocked.body).toMatchObject({ error: 'bill-paid' });
    expect((await t.db.query<{ missed_status: string }>('select missed_status from cafe_orders where id = $1', [hrLost])).rows[0]!.missed_status).toBe(
      'reported',
    );
    expect((await decide(nov.facilities, hrLost, 'keep')).status).toBe(200);

    expect((await decide(nov.facilities, staffLost, 'remove')).status).toBe(200);
    expect((await decide(nov.facilities, devLost, 'remove')).status).toBe(200);
    now = await byPerson();
    expect(now.get(pid(t, MOCK.staff))).toMatchObject({ total_won: 5000, order_count: 1, status: 'unpaid' });
    expect(await recount(t, pid(t, MOCK.staff), '2026-10')).toEqual({ won: 5000, n: 1 });
    // 도윤은 낼 게 없어져서 입금 확인이에요(처음부터 0원인 청구서와 같아요). 기한이 지나도 막히지 않아요.
    expect(now.get(pid(t, MOCK.dev))).toMatchObject({ total_won: 0, order_count: 0, status: 'paid' });
    const late = await jumpTo(t, '2026-11-09T09:00:00+09:00');
    expect((await view(late.dev)).billing.blocked).toBe(false);
    expect((await view(late.staff)).billing.blocked).toBe(true);
  });
});

describe('[ADR-21·29] [못 받았어요] 보관', () => {
  it('[ADR-29 시험] 청구에서 뺀 주문은 뺀 뒤 7일에 지워지고, 그대로 둔 주문·신고만 한 주문은 다른 주문처럼 입금 확인 전에는 남아요', async () => {
    const { t, staff, dev, facilities, barista } = await setup();
    const removed = await order(staff, AMERICANO1);
    const kept = await order(dev, AMERICANO1);
    const reported = await order(dev, LATTE2);
    for (const id of [removed, kept, reported]) await serve(barista, id);
    await missed(staff, removed);
    await missed(dev, kept);
    await missed(dev, reported);
    await decide(facilities, removed, 'remove');
    await decide(facilities, kept, 'keep');
    t.advance(7 * DAY - 60_000);
    expect(await t.runRetention()).toEqual([]);
    const ids = async () => (await t.db.query<{ id: string }>('select id::text as id from cafe_orders order by id')).rows.map((r) => r.id);
    expect(await ids()).toEqual([removed, kept, reported]);
    t.advance(2 * 60_000);
    expect(await t.runRetention()).toEqual([]);
    expect(await ids()).toEqual([kept, reported]);
  });
});

describe('[F4-14] 퇴사', () => {
  it('[F4-14] 재직 확인에서 빠진 사람의 미납 청구서는 S9에 "재직 확인 안 됨"으로 보여요(급여·퇴직금 공제는 하지 않아요)', async () => {
    const { t, staff, dev } = await setup();
    await order(staff, LATTE2);
    await order(dev, AMERICANO1);
    const nov = await jumpTo(t, '2026-11-01T00:30:00+09:00');
    expect(await t.runRetention()).toEqual([]);
    t.adapters.employees.setActive(MOCK.dev, false);
    const s = await settle(nov.facilities, '2026-10');
    expect(s.bills.map((b) => [b.name, b.active])).toEqual([
      ['가상 직원 도윤', false],
      ['가상 직원 하늘', true],
    ]);
  });
});
