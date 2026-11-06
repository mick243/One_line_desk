import type {
  CafeBoardResponse,
  CafeOrderLineInput,
  CafeResponse,
  CafeSettleResponse,
  NotificationsResponse,
  PlanConfirmResponse,
  PlanCreateResponse,
} from '@one-line-desk/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pseudonymize } from '../../core/pseudonym';
import { createTestApp, MOCK } from '../../testing';

// F4 사내 카페 2묶음(11/6, PRD F4 세부 요구 6~12·완료 기준, ADR-29 "시험으로 지키는 것"): 청구·입금 확인·한도·미납 막기·알림·보관·총무 정산.
// 시계는 2026-10-26(월) 09:00(한국)에서 시작해요. 10월 주문은 11월 1일 0시 뒤 첫 보관 회차에서 청구돼요(기한 11월 7일, 8일부터 막힘).

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
type On = Extract<CafeResponse, { status: 'on' }>;

const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const LATTE2: CafeOrderLineInput[] = [{ menuId: 'latte', qty: 2, options: [] }]; // 5,000원
const VANILLA1: CafeOrderLineInput[] = [{ menuId: 'vanilla-latte', qty: 1, options: ['샷 추가'] }]; // 3,000원
const AMERICANO1: CafeOrderLineInput[] = [{ menuId: 'americano', qty: 1, options: ['아이스'] }]; // 2,000원
const AMERICANO2: CafeOrderLineInput[] = [{ menuId: 'americano', qty: 2, options: [] }]; // 4,000원

const ALLOWED_TITLES = [
  '카페 청구서가 나왔어요',
  '카페 값 납부 기한이 지났어요',
  '카페 값 입금을 확인했어요',
  '카페 한도 요청이 왔어요',
  '카페 한도를 늘렸어요',
  '카페 한도 요청이 반려됐어요',
  '주문한 음료가 나왔어요',
];

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
  const facilities = await t.loginAs(MOCK.facilities);
  const barista = await t.loginAs(MOCK.barista);
  await barista.call('GET', '/api/cafe/board');
  return { staff, dev, facilities, barista };
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

async function propose(me: Session, lines: CafeOrderLineInput[]) {
  const slot = (await view(me)).slots[0]!.start;
  return me.call('POST', '/api/cafe/order/propose', { lines, pickupSlot: slot });
}

async function planFor(
  me: Session,
  lines: CafeOrderLineInput[],
): Promise<{ planId: string; sheet: Extract<PlanCreateResponse, { status: 'sheet' }>['sheet'] }> {
  const p = await propose(me, lines);
  expect(p.status).toBe(200);
  const created = await me.call('POST', '/api/plans', { proposalToken: p.body.proposalToken });
  expect(created.status).toBe(200);
  if (created.body.status !== 'sheet') throw new Error('확인 시트가 아니에요');
  return { planId: created.body.planId, sheet: created.body.sheet };
}

async function confirm(me: Session, planId: string): Promise<PlanConfirmResponse> {
  const res = await me.call('POST', `/api/plans/${planId}/confirm`);
  expect(res.status).toBe(200);
  return res.body;
}

async function order(me: Session, lines: CafeOrderLineInput[]): Promise<PlanConfirmResponse> {
  return confirm(me, (await planFor(me, lines)).planId);
}

const idOf = (res: PlanConfirmResponse) => {
  if (res.status !== 'done') throw new Error(`주문이 들어가지 않았어요: ${res.status}`);
  return res.card.id.replace('cafe-order-', '');
};

async function bills(t: TestApp) {
  const { rows } = await t.db.query<{
    id: string;
    pseudonym_id: string;
    month: string;
    total_won: number;
    order_count: number;
    code: string;
    due_on: string;
    status: string;
  }>('select id::text as id, pseudonym_id, month, total_won, order_count, code, due_on::text as due_on, status from cafe_bills order by id');
  return rows;
}

async function settle(me: Session, month?: string): Promise<CafeSettleResponse> {
  const res = await me.call('GET', `/api/cafe/settle${month ? `?month=${month}` : ''}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function notes(me: Session): Promise<NotificationsResponse> {
  return (await me.call('GET', '/api/notifications')).body;
}

async function csv(t: TestApp, me: Session, month: string) {
  const res = await t.app.inject({ method: 'GET', url: `/api/cafe/sales.csv?month=${month}`, headers: { cookie: me.cookie } });
  return { status: res.statusCode, type: String(res.headers['content-type']), body: res.body };
}

const pid = (t: TestApp, subject: string) => pseudonymize(t.ctx.config.pseudonymSecret, subject);

/** 10월에 하늘(재무팀) 8,000원(라테 둘 + 바닐라라테, 아메리카노는 취소)·도윤(개발팀) 2,000원을 주문하고 11월 1일 0시 30분에 보관 회차를 돌려요. */
async function octoberBills() {
  const s = await setup();
  const { t, staff, dev } = s;
  await order(staff, LATTE2);
  const cancelled = idOf(await order(staff, AMERICANO1));
  expect((await staff.call('POST', `/api/cafe/orders/${cancelled}/cancel`)).status).toBe(200);
  await order(staff, VANILLA1);
  await order(dev, AMERICANO1);
  const nov = await jumpTo(t, '2026-11-01T00:30:00+09:00');
  expect(await t.runRetention()).toEqual([]);
  return { ...s, ...nov };
}

describe('[F4-6] 매달 1일 청구', () => {
  it('[F4 완료 기준] 1일 0시 뒤 처음 돌 때 지난달 청구서를 한 번 만들고, 취소 주문은 빼고, 합계가 주문 행에서 다시 센 값과 같아요', async () => {
    const s = await setup();
    const { t, staff, dev } = s;
    await order(staff, LATTE2);
    const cancelled = idOf(await order(staff, AMERICANO1));
    await staff.call('POST', `/api/cafe/orders/${cancelled}/cancel`);
    await order(staff, VANILLA1);
    await order(dev, AMERICANO1);

    // 말일 밤에는 아직 청구하지 않아요.
    await jumpTo(t, '2026-10-31T23:30:00+09:00');
    expect(await t.runRetention()).toEqual([]);
    expect(await bills(t)).toEqual([]);

    const nov = await jumpTo(t, '2026-11-01T00:30:00+09:00');
    expect(await t.runRetention()).toEqual([]);
    // 다시 돌아도(5분 뒤 재시도·다음 회차) 한 번이에요.
    expect(await t.runRetention()).toEqual([]);
    t.advance(60 * 60_000);
    expect(await t.runRetention()).toEqual([]);

    const made = await bills(t);
    expect(made.map((b) => [b.pseudonym_id, b.month, b.total_won, b.order_count, b.due_on, b.status])).toEqual([
      [pid(t, MOCK.dev), '2026-10', 2000, 1, '2026-11-07', 'unpaid'],
      [pid(t, MOCK.staff), '2026-10', 8000, 2, '2026-11-07', 'unpaid'],
    ]);
    for (const b of made) expect(b.code).toMatch(/^[A-Z0-9]{5}$/);
    expect(new Set(made.map((b) => b.code)).size).toBe(2);

    // 청구 합계 = 주문 행(취소 뺌)에서 다시 센 값
    for (const b of made) {
      const { rows } = await t.db.query<{ won: number; n: number }>(
        "select coalesce(sum(total_won), 0)::int as won, count(*)::int as n from cafe_orders where pseudonym_id = $1 and status <> 'cancelled' and to_char(order_day, 'YYYY-MM') = $2",
        [b.pseudonym_id, b.month],
      );
      expect([rows[0]!.won, rows[0]!.n]).toEqual([b.total_won, b.order_count]);
    }

    // 본인 화면: 달·합계·건별 내역·입금 코드·기한·상태·계좌 안내
    const mine = (await view(nov.staff)).billing;
    expect(mine.bills).toHaveLength(1);
    expect(mine.bills[0]).toMatchObject({ month: '2026-10', monthLabel: '10월', totalWon: 8000, count: 2, status: 'unpaid', dueLabel: '11월 7일(토)' });
    expect(mine.bills[0]!.code).toBe(made.find((b) => b.pseudonym_id === pid(t, MOCK.staff))!.code);
    expect(mine.bills[0]!.orders.map((o) => [o.dayLabel, o.totalWon])).toEqual([
      ['10월 26일(월)', 5000],
      ['10월 26일(월)', 3000],
    ]);
    expect(mine.account).toBe('계좌는 총무에게 물어봐 주세요');
    expect(mine.blocked).toBe(false);
    // 남의 청구서는 보이지 않아요.
    expect(JSON.stringify(mine)).not.toContain(made.find((b) => b.pseudonym_id === pid(t, MOCK.dev))!.code);

    // 1일에 한 주문은 다음 달 청구예요.
    await nov.barista.call('GET', '/api/cafe/board');
    await order(nov.staff, AMERICANO1);
    t.advance(60 * 60_000);
    await t.runRetention();
    expect(await bills(t)).toHaveLength(2);
    expect((await view(nov.staff)).monthTotalWon).toBe(2000);
  });

  it('[ADR-29] 청구 알림은 본인에게 한 번만 가고, 제목에 금액·메뉴·입금 코드가 없어요', async () => {
    const { t, staff, dev, facilities, barista } = await octoberBills();
    await t.runRetention();
    const staffNotes = (await notes(staff)).items;
    expect(staffNotes.map((n) => [n.title, n.page])).toEqual([['카페 청구서가 나왔어요', 'cafe']]);
    expect((await notes(dev)).items.map((n) => n.title)).toEqual(['카페 청구서가 나왔어요']);
    // 총무·바리스타에게는 남의 청구 알림이 가지 않아요.
    expect((await notes(facilities)).items).toEqual([]);
    expect((await notes(barista)).items).toEqual([]);
    const { rows } = await t.db.query<{ audience_pseudonym: string | null; audience_department: string | null; audience_role: string | null }>(
      "select audience_pseudonym, audience_department, audience_role from notifications where module = 'cafeteria'",
    );
    expect(rows.every((r) => r.audience_pseudonym !== null && r.audience_department === null && r.audience_role === null)).toBe(true);
  });
});

describe('[F4-8] 기한과 미납 막기', () => {
  it('[F4 완료 기준] 기한(7일)까지는 주문되고, 8일부터 미납자의 새 주문 0건(제안·확인 시트·실행), [입금 확인] 뒤에는 바로 주문돼요', async () => {
    const { t } = await octoberBills();

    // 7일 밤: 기한 안이라 주문돼요. 확인 시트를 하나 열어 둬요.
    let p = await jumpTo(t, '2026-11-07T23:57:00+09:00');
    expect((await view(p.staff)).billing.blocked).toBe(false);
    expect((await order(p.staff, AMERICANO1)).status).toBe('done');
    const openSheet = await planFor(p.staff, AMERICANO1);
    const token = (await propose(p.staff, AMERICANO1)).body.proposalToken as string;

    // 8일 0시: 실행·확인 시트·제안이 모두 막혀요.
    t.advance(4 * 60_000);
    await p.barista.call('GET', '/api/cafe/board');
    const ran = await confirm(p.staff, openSheet.planId);
    expect(ran.status).toBe('blocked');
    if (ran.status === 'blocked') expect(ran.card.headline).toBe('지난달 카페 값을 아직 내지 않아서 새 주문을 받을 수 없어요');
    const sheet = await p.staff.call('POST', '/api/plans', { proposalToken: token });
    expect(sheet.status).toBe(409);
    expect(sheet.body.message).toBe('지난달 카페 값을 아직 내지 않아서 새 주문을 받을 수 없어요');

    p = await jumpTo(t, '2026-11-08T09:00:00+09:00');
    const proposed = await propose(p.staff, AMERICANO1);
    expect(proposed.status).toBe(409);
    expect(proposed.body).toEqual({ error: 'cafe-unpaid', message: '지난달 카페 값을 아직 내지 않아서 새 주문을 받을 수 없어요' });
    const mine = (await view(p.staff)).billing;
    expect(mine.blocked).toBe(true);
    expect(mine.bills[0]!.status).toBe('overdue');
    const novemberOrders = async () =>
      (await t.db.query("select 1 from cafe_orders where pseudonym_id = $1 and order_day >= '2026-11-08'", [pid(t, MOCK.staff)])).rows.length;
    expect(await novemberOrders()).toBe(0);

    // 총무가 [입금 확인]을 누르면 바로 풀려요.
    const bill = (await settle(p.facilities)).bills.find((b) => b.name === '가상 직원 하늘')!;
    expect(bill.status).toBe('overdue');
    const paid = await p.facilities.call('POST', `/api/cafe/bills/${bill.id}/paid`);
    expect(paid).toEqual({ status: 200, body: { id: bill.id, status: 'paid' } });
    expect((await view(p.staff)).billing.blocked).toBe(false);
    expect((await order(p.staff, AMERICANO1)).status).toBe('done');
    expect(await novemberOrders()).toBe(1);
    // 두 번 눌러도 한 번이에요.
    expect((await p.facilities.call('POST', `/api/cafe/bills/${bill.id}/paid`)).body).toEqual({ id: bill.id, status: 'paid' });
    expect((await notes(p.staff)).items.filter((n) => n.title === '카페 값 입금을 확인했어요')).toHaveLength(1);
    // 도윤은 아직 미납이라 막혀 있어요.
    expect((await propose(p.dev, AMERICANO1)).status).toBe(409);
  });

  it('[F4-9] 기한 다음 날 한 번, 그 뒤 주 1회만 알려요(같은 날 다시 돌아도 한 번). 입금 확인 뒤에는 멈춰요', async () => {
    const { t } = await octoberBills();
    const sent = async () =>
      (
        await t.db.query<{ kind: string; seq: number }>(
          'select n.kind, n.seq from cafe_bill_notices n join cafe_bills b on b.id = n.bill_id where b.pseudonym_id = $1 order by n.kind, n.seq',
          [pid(t, MOCK.staff)],
        )
      ).rows.map((r) => `${r.kind}:${r.seq}`);
    expect(await sent()).toEqual(['issued:0']);

    await jumpTo(t, '2026-11-07T22:00:00+09:00');
    await t.runRetention();
    expect(await sent()).toEqual(['issued:0']);

    let p = await jumpTo(t, '2026-11-08T00:20:00+09:00');
    await t.runRetention();
    await t.runRetention();
    expect(await sent()).toEqual(['issued:0', 'overdue:0']);
    expect((await notes(p.staff)).items.filter((n) => n.title === '카페 값 납부 기한이 지났어요')).toHaveLength(1);

    await jumpTo(t, '2026-11-14T23:00:00+09:00');
    await t.runRetention();
    expect(await sent()).toEqual(['issued:0', 'overdue:0']);

    p = await jumpTo(t, '2026-11-15T01:00:00+09:00');
    await t.runRetention();
    expect(await sent()).toEqual(['issued:0', 'overdue:0', 'overdue:1']);
    // 8일 알림은 7일이 지나 지워졌고(알림 보관 7일), 15일 알림이 새로 왔어요.
    const titles = (await notes(p.staff)).items.map((n) => n.title);
    expect(titles).toEqual(['카페 값 납부 기한이 지났어요']);

    // 입금 확인 뒤에는 더 알리지 않아요.
    const bill = (await settle(p.facilities)).bills.find((b) => b.name === '가상 직원 하늘')!;
    await p.facilities.call('POST', `/api/cafe/bills/${bill.id}/paid`);
    await jumpTo(t, '2026-11-22T02:00:00+09:00');
    await t.runRetention();
    // 청구서가 7일 뒤 지워져서 보낸 기록도 같이 지워졌어요. 도윤 것만 남아요.
    expect(await sent()).toEqual([]);
    const { rows } = await t.db.query<{ seq: number }>(
      "select n.seq from cafe_bill_notices n join cafe_bills b on b.id = n.bill_id where b.pseudonym_id = $1 and n.kind = 'overdue' order by n.seq",
      [pid(t, MOCK.dev)],
    );
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
  });
});

describe('[F4-10] 한 달 한도', () => {
  it('[F4 완료 기준] 한도를 넘는 주문 0건: 제안·확인 시트·실행이 막히고, 확인 시트에 남은 한도가 보여요', async () => {
    const { t, staff } = await setup();
    t.ctx.ops.patchValues({ cafeMonthlyLimitWon: 10_000 });
    await order(staff, LATTE2);
    expect((await view(staff)).billing).toMatchObject({ limitWon: 10_000, leftWon: 5_000 });

    const over = await propose(staff, [{ menuId: 'vanilla-latte', qty: 2, options: [] }]);
    expect(over.status).toBe(409);
    expect(over.body).toEqual({ error: 'cafe-limit', message: '이번 달 한도(10,000원)를 넘어서 주문할 수 없어요. 필요하면 한도를 늘려 달라고 할 수 있어요' });

    const fits = await planFor(staff, AMERICANO2);
    expect(fits.sheet.lines).toContain('이번 달 지금까지 5,000원 · 남은 한도 5,000원');
    // 시트를 연 뒤 다른 주문으로 한도가 차면 실행이 막혀요.
    expect((await order(staff, AMERICANO1)).status).toBe('done');
    const blocked = await confirm(staff, fits.planId);
    expect(blocked.status).toBe('blocked');
    if (blocked.status === 'blocked') {
      expect(blocked.card.headline).toBe('이번 달 한도(10,000원)를 넘어서 주문할 수 없어요. 필요하면 한도를 늘려 달라고 할 수 있어요');
      expect(blocked.card.fields).toContainEqual({ name: '남은 한도', value: '3,000원' });
    }
    const { rows } = await t.db.query<{ won: number }>("select coalesce(sum(total_won), 0)::int as won from cafe_orders where status <> 'cancelled'");
    expect(rows[0]!.won).toBe(7_000);
  });

  it('[F4 완료 기준] 두 탭에서 동시에 주문해도 한도를 넘지 않아요(주문 잠금)', async () => {
    const { t, staff } = await setup();
    t.ctx.ops.patchValues({ cafeMonthlyLimitWon: 10_000 });
    await order(staff, LATTE2);
    // 탭마다 확인 시트를 열어요. 하나씩 보면 둘 다 한도 안(5,000 + 4,000)이에요.
    const a = await planFor(staff, AMERICANO2);
    const b = await planFor(staff, AMERICANO2);
    const results = await Promise.all([confirm(staff, a.planId), confirm(staff, b.planId)]);
    expect(results.map((r) => r.status).sort()).toEqual(['blocked', 'done']);
    const { rows } = await t.db.query<{ won: number }>("select coalesce(sum(total_won), 0)::int as won from cafe_orders where status <> 'cancelled'");
    expect(rows[0]!.won).toBe(9_000);
    expect(rows[0]!.won).toBeLessThanOrEqual(10_000);
  });

  it('[F4-10] 금액만 적어 한도를 늘려 달라고 하고, 총무가 [늘려 주기]하면 그 달에만 늘어요', async () => {
    const { t, staff, dev, facilities } = await setup();
    t.ctx.ops.patchValues({ cafeMonthlyLimitWon: 10_000 });
    await order(staff, LATTE2);

    expect((await staff.call('POST', '/api/cafe/limit/request', { amountWon: 10_000 })).status).toBe(400);
    expect((await staff.call('POST', '/api/cafe/limit/request', { amountWon: 30_000, reason: '회의가 많아요' })).status).toBe(400);
    expect((await staff.call('POST', '/api/cafe/limit/request', { amountWon: 30_000 })).body).toEqual({ status: 'pending', amountWon: 30_000 });
    expect((await staff.call('POST', '/api/cafe/limit/request', { amountWon: 40_000 })).status).toBe(409);
    expect((await view(staff)).billing.request).toEqual({ amountWon: 30_000, status: 'pending' });

    // 총무에게만 "카페 한도 요청이 왔어요"(이름·금액 없음)가 가요.
    expect((await notes(facilities)).items.map((n) => [n.title, n.page])).toEqual([['카페 한도 요청이 왔어요', 'cafe-settle']]);
    expect((await notes(dev)).items).toEqual([]);
    expect((await notes(staff)).items).toEqual([]);

    const req = (await settle(facilities)).requests;
    expect(req).toEqual([
      expect.objectContaining({ name: '가상 직원 하늘', monthLabel: '10월', amountWon: 30_000, limitWon: 10_000, status: 'pending', current: true }),
    ]);
    expect((await facilities.call('POST', `/api/cafe/limit/${req[0]!.id}/approve`)).body).toEqual({ id: req[0]!.id, status: 'approved' });
    expect((await facilities.call('POST', `/api/cafe/limit/${req[0]!.id}/approve`)).body).toEqual({ id: req[0]!.id, status: 'approved' });
    expect((await facilities.call('POST', `/api/cafe/limit/${req[0]!.id}/reject`)).status).toBe(409);
    expect((await notes(staff)).items.map((n) => n.title)).toEqual(['카페 한도를 늘렸어요']);

    const after = (await view(staff)).billing;
    expect(after).toMatchObject({ limitWon: 30_000, leftWon: 25_000, request: { amountWon: 30_000, status: 'approved' } });
    expect((await order(staff, [{ menuId: 'vanilla-latte', qty: 5, options: [] }])).status).toBe('done');

    // 다음 달에는 운영 값 한도로 돌아가요.
    const nov = await jumpTo(t, '2026-11-02T10:00:00+09:00');
    await t.runRetention();
    expect((await view(nov.staff)).billing).toMatchObject({ limitWon: 10_000, request: null });
    expect((await t.db.query('select 1 from cafe_month_limits')).rows).toEqual([]);
  });

  it('[F4-10] [안 돼요]면 한도가 그대로이고, 지난달 요청은 늘릴 수 없고, 내 요청은 내가 처리하지 않아요', async () => {
    const { t, dev, facilities } = await setup();
    expect((await dev.call('POST', '/api/cafe/limit/request', { amountWon: 600_000 })).status).toBe(200);
    const [r] = (await settle(facilities)).requests;
    expect((await facilities.call('POST', `/api/cafe/limit/${r!.id}/reject`)).body).toEqual({ id: r!.id, status: 'rejected' });
    expect((await notes(dev)).items.map((n) => n.title)).toEqual(['카페 한도 요청이 반려됐어요']);
    expect((await view(dev)).billing).toMatchObject({ limitWon: 500_000, request: { amountWon: 600_000, status: 'rejected' } });
    expect((await facilities.call('POST', `/api/cafe/limit/${r!.id}/approve`)).status).toBe(409);

    // 총무 자신의 요청: 자기에게는 알림이 가지 않고(도윤 요청 알림 하나뿐), 자기가 처리하지 못해요.
    expect((await facilities.call('POST', '/api/cafe/limit/request', { amountWon: 700_000 })).status).toBe(200);
    expect((await notes(facilities)).items.map((n) => n.title)).toEqual(['카페 한도 요청이 왔어요']);
    const own = (await settle(facilities)).requests.find((x) => x.status === 'pending')!;
    expect((await facilities.call('POST', `/api/cafe/limit/${own.id}/approve`)).status).toBe(403);

    // 지난달(10월) 대기 요청은 11월에 늘릴 수 없어요.
    expect((await dev.call('POST', '/api/cafe/limit/request', { amountWon: 650_000 })).status).toBe(200);
    const nov = await jumpTo(t, '2026-11-01T09:00:00+09:00');
    const late = (await settle(nov.facilities)).requests.find((x) => x.amountWon === 650_000)!;
    expect(late.current).toBe(false);
    const res = await nov.facilities.call('POST', `/api/cafe/limit/${late.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('지난달 요청이라 늘릴 수 없어요. 늘린 한도는 그 달에만 써요');
  });
});

describe('[F4-11] 총무 정산 화면(등급 2 예외)', () => {
  it('[F4 완료 기준] 총무가 아닌 사람이 정산·[입금 확인]·[늘려 주기]·[안 돼요]·메뉴 관리·매출 CSV를 부르면 403이에요', async () => {
    const { t, staff, dev, barista } = await octoberBills();
    const [bill] = await bills(t);
    expect((await dev.call('POST', '/api/cafe/limit/request', { amountWon: 600_000 })).status).toBe(200);
    const { rows } = await t.db.query<{ id: string }>('select id::text as id from cafe_limit_requests');
    const operator = await t.loginAs(MOCK.operator);
    for (const me of [staff, dev, barista, operator]) {
      expect((await me.call('GET', '/api/cafe/settle')).status).toBe(403);
      expect((await me.call('GET', '/api/cafe/settle?month=2026-10')).status).toBe(403);
      expect((await me.call('POST', `/api/cafe/bills/${bill!.id}/paid`)).status).toBe(403);
      expect((await me.call('POST', `/api/cafe/limit/${rows[0]!.id}/approve`)).status).toBe(403);
      expect((await me.call('POST', `/api/cafe/limit/${rows[0]!.id}/reject`)).status).toBe(403);
      expect((await me.call('POST', '/api/cafe/menu', { name: '쑥라테', priceWon: 3000, options: [] })).status).toBe(403);
      expect((await me.call('PUT', '/api/cafe/menu/latte', { name: '카페라테', priceWon: 100, options: [], active: true })).status).toBe(403);
      expect((await csv(t, me, '2026-10')).status).toBe(403);
    }
    expect((await bills(t)).map((b) => b.status)).toEqual(['unpaid', 'unpaid']);
    expect((await t.db.query("select 1 from cafe_limit_requests where status = 'pending'")).rows).toHaveLength(1);
    expect((await t.db.query("select 1 from cafe_menu where price_won = 100 or name = '쑥라테'")).rows).toEqual([]);
    expect((await t.db.query("select 1 from access_log where action like 'cafe.%'")).rows).toEqual([]);
  });

  it('[ADR-29] 카페가 꺼지면 정산 화면도 닫혀요(409)', async () => {
    const { t, facilities } = await octoberBills();
    await t.ctx.ops.setModule('p_test-operator', 'cafeteria', 'off');
    expect((await facilities.call('GET', '/api/cafe/settle')).status).toBe(409);
    expect((await csv(t, facilities, '2026-10')).status).toBe(409);
  });

  it('[F4-11] 정산 화면에 이름·청구액·입금 코드·납부 상태가 보이고, 이름은 저장하지 않고 그때 붙여요', async () => {
    const { t, facilities } = await octoberBills();
    const view = await settle(facilities);
    expect(view.month).toBe('2026-10');
    expect(view.months.map((m) => m.month)).toEqual(['2026-11', '2026-10']);
    const codes = await bills(t);
    expect(view.bills.map((b) => [b.name, b.totalWon, b.count, b.status, b.dueLabel])).toEqual([
      ['가상 직원 도윤', 2000, 1, 'unpaid', '11월 7일(토)'],
      ['가상 직원 하늘', 8000, 2, 'unpaid', '11월 7일(토)'],
    ]);
    expect(view.bills.map((b) => b.code).sort()).toEqual(codes.map((b) => b.code).sort());
    expect(view.summary).toEqual({ count: 2, totalWon: 10_000, paidWon: 0, overdue: 0 });
    expect(view.salesMonth).toBe('2026-10');
    // DB 어디에도 이름이 없어요.
    for (const table of ['cafe_bills', 'cafe_orders', 'cafe_limit_requests', 'cafe_bill_notices']) {
      const { rows } = await t.db.query(`select * from ${table}`);
      expect(JSON.stringify(rows)).not.toContain('하늘');
      expect(JSON.stringify(rows)).not.toContain('도윤');
    }
  });

  it('[ADR-20·29 시험] 정산 화면을 열 때·[입금 확인]·매출 CSV마다 접속기록에 남고, 금액·이름·입금 코드는 없어요', async () => {
    const { t, facilities } = await octoberBills();
    const before = (await t.db.query("select 1 from access_log where action like 'cafe.%'")).rows.length;
    expect(before).toBe(0);
    const v = await settle(facilities);
    await settle(facilities, '2026-10');
    const bill = v.bills.find((b) => b.name === '가상 직원 하늘')!;
    await facilities.call('POST', `/api/cafe/bills/${bill.id}/paid`);
    expect((await csv(t, facilities, '2026-10')).status).toBe(200);

    const { rows } = await t.db.query<{ pseudonym_id: string; action: string; subject_refs: string[] }>(
      "select pseudonym_id, action, subject_refs from access_log where action like 'cafe.%' order by id",
    );
    const me = pid(t, MOCK.facilities);
    const people = [`person:${pid(t, MOCK.dev)}`, `person:${pid(t, MOCK.staff)}`].sort();
    expect(rows.map((r) => [r.pseudonym_id, r.action, [...r.subject_refs].sort()])).toEqual([
      [me, 'cafe.settle', people],
      [me, 'cafe.settle', people],
      [me, 'cafe.update', [`person:${pid(t, MOCK.staff)}`]],
      [me, 'cafe.sales', []],
    ]);
    const text = JSON.stringify((await t.db.query("select * from access_log where action like 'cafe.%'")).rows);
    for (const secret of ['8000', '8,000', '2000', '원', '하늘', '도윤', ...v.bills.map((b) => b.code)]) expect(text).not.toContain(secret);
  });

  it('[ADR-29 시험] 감사 로그에는 모듈·동작·결과만 남고 금액·입금 코드·메뉴는 없어요', async () => {
    const { t, staff, facilities } = await octoberBills();
    const v = await settle(facilities);
    await facilities.call('POST', `/api/cafe/bills/${v.bills[0]!.id}/paid`);
    await staff.call('POST', '/api/cafe/limit/request', { amountWon: 777_000 });
    const req = (await settle(facilities)).requests[0]!;
    await facilities.call('POST', `/api/cafe/limit/${req.id}/approve`);
    await facilities.call('POST', '/api/cafe/menu', { name: '쑥라테', priceWon: 3300, options: ['아이스'] });
    await facilities.call('PUT', '/api/cafe/menu/latte', { name: '카페라테', priceWon: 2700, options: ['아이스'], active: true });
    const { rows } = await t.db.query<Record<string, unknown>>(
      "select pseudonym_id, channel, module, action, tool, client_id, plan_id::text as plan_id, result from audit_log where module = 'cafeteria' and action in ('bill-paid', 'limit-request', 'limit-approve', 'menu-add', 'menu-update') order by id",
    );
    expect(rows.map((r) => [r.action, r.result])).toEqual([
      ['bill-paid', 'paid'],
      ['limit-request', 'done'],
      ['limit-approve', 'approved'],
      ['menu-add', 'done'],
      ['menu-update', 'done'],
    ]);
    const text = JSON.stringify((await t.db.query("select * from audit_log where module = 'cafeteria'")).rows);
    for (const secret of ['777000', '777,000', '3300', '2700', '8000', '원', '쑥라테', '카페라테', ...v.bills.map((b) => b.code)])
      expect(text).not.toContain(secret);
  });

  it('[F4-12] 매출 합계 CSV는 날·메뉴별 잔 수·금액이고 이름·가명 ID가 없어요. 합계가 청구서 합계와 같아요', async () => {
    const { t, facilities } = await octoberBills();
    const file = await csv(t, facilities, '2026-10');
    expect(file.status).toBe(200);
    expect(file.type).toContain('text/csv');
    expect(file.body.charCodeAt(0)).toBe(0xfeff);
    const lines = file.body.slice(1).trim().split(String.fromCharCode(13, 10));
    expect(lines[0]).toBe('날짜,메뉴,잔 수,금액(원)');
    expect(lines.slice(1)).toEqual(['2026-10-26,바닐라라테,1,3000', '2026-10-26,아메리카노,1,2000', '2026-10-26,카페라테,2,5000', '합계,,4,10000']);
    expect((await bills(t)).reduce((s, b) => s + b.total_won, 0)).toBe(10_000);
    for (const secret of ['하늘', '도윤', 'p_', pid(t, MOCK.staff), pid(t, MOCK.dev), 'mock|']) expect(file.body).not.toContain(secret);
    expect((await csv(t, facilities, '2026-13')).status).toBe(400);
  });
});

describe('[ADR-21·29] 보관', () => {
  it('[F4 완료 기준] [입금 확인] 7일 뒤 그 사람 그 달 주문·청구서가 0건이고, 미납 청구와 주문은 남아요', async () => {
    const { t } = await octoberBills();
    let p = await jumpTo(t, '2026-11-03T10:00:00+09:00');
    const v = await settle(p.facilities);
    const staffBill = v.bills.find((b) => b.name === '가상 직원 하늘')!;
    await p.facilities.call('POST', `/api/cafe/bills/${staffBill.id}/paid`);
    // 11월 주문은 지우지 않아요.
    expect((await order(p.staff, AMERICANO1)).status).toBe('done');

    const rowsOf = async (subject: string) => ({
      orders: (
        await t.db.query<{ day: string }>('select order_day::text as day from cafe_orders where pseudonym_id = $1 order by id', [pid(t, subject)])
      ).rows.map((r) => r.day),
      bills: (await t.db.query<{ month: string }>('select month from cafe_bills where pseudonym_id = $1', [pid(t, subject)])).rows.map((r) => r.month),
    });

    await jumpTo(t, '2026-11-10T09:59:00+09:00');
    await t.runRetention();
    expect(await rowsOf(MOCK.staff)).toEqual({ orders: ['2026-10-26', '2026-10-26', '2026-11-03'], bills: ['2026-10'] });

    p = await jumpTo(t, '2026-11-10T10:01:00+09:00');
    expect(await t.runRetention()).toEqual([]);
    expect(await rowsOf(MOCK.staff)).toEqual({ orders: ['2026-11-03'], bills: [] });
    // 도윤은 미납이라 그대로 남아요.
    expect(await rowsOf(MOCK.dev)).toEqual({ orders: ['2026-10-26'], bills: ['2026-10'] });
    expect((await view(p.staff)).billing.bills).toEqual([]);
  });

  it('[ADR-21·29] 한도 요청은 처리(대기 중이면 만든) 뒤 7일에 지워져요', async () => {
    const { t, staff } = await setup();
    // 10/26 09:00 하늘 요청 → 10/27 09:00 늘려 주기, 도윤 요청(대기)
    await staff.call('POST', '/api/cafe/limit/request', { amountWon: 600_000 });
    t.advance(24 * 60 * 60_000);
    const s2 = await people(t);
    await s2.dev.call('POST', '/api/cafe/limit/request', { amountWon: 600_000 });
    const r = (await settle(s2.facilities)).requests.find((x) => x.name === '가상 직원 하늘')!;
    await s2.facilities.call('POST', `/api/cafe/limit/${r.id}/approve`);
    const left = async () => (await t.db.query<{ status: string }>('select status from cafe_limit_requests order by id')).rows.map((x) => x.status);
    // 11/2 09:30: 하늘 요청은 만든 지 7일이 지났지만 처리한 지 7일이 안 돼서 남아요.
    await jumpTo(t, '2026-11-02T09:30:00+09:00');
    await t.runRetention();
    expect(await left()).toEqual(['approved', 'pending']);
    await jumpTo(t, '2026-11-03T09:30:00+09:00');
    await t.runRetention();
    expect(await left()).toEqual([]);
  });
});

describe('[F4-2] 메뉴·직원가 관리(총무)', () => {
  it('메뉴를 더하고 이름·직원가·옵션·파는지를 바꿔요. 값이 바뀌면 이미 연 확인 시트는 막히고, 공통 입력 검사를 지나야 해요', async () => {
    const { t, staff, facilities } = await setup();
    const added = await facilities.call('POST', '/api/cafe/menu', { name: ' 쑥라테 ', priceWon: 3300, options: ['아이스', '핫'] });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ name: '쑥라테', priceWon: 3300, options: ['아이스', '핫'], active: true, soldOut: false });
    const id = added.body.id as string;
    expect((await view(staff)).menu.find((m) => m.id === id)).toMatchObject({ name: '쑥라테', priceWon: 3300 });

    const open = await planFor(staff, [{ menuId: id, qty: 1, options: ['아이스'] }]);
    expect((await facilities.call('PUT', `/api/cafe/menu/${id}`, { name: '쑥라테', priceWon: 3500, options: ['아이스', '핫'], active: true })).status).toBe(
      200,
    );
    expect((await confirm(staff, open.planId)).status).toBe('blocked');
    expect((await order(staff, [{ menuId: id, qty: 1, options: ['아이스'] }])).status).toBe('done');
    expect((await t.db.query<{ total_won: number }>('select total_won from cafe_orders')).rows).toEqual([{ total_won: 3500 }]);

    // 쓰지 않게 하면 메뉴에서 빠지고, 총무 화면에는 남아요.
    expect((await facilities.call('PUT', `/api/cafe/menu/${id}`, { name: '쑥라테', priceWon: 3500, options: [], active: false })).status).toBe(200);
    expect((await view(staff)).menu.some((m) => m.id === id)).toBe(false);
    expect((await settle(facilities)).menu.find((m) => m.id === id)).toMatchObject({ active: false });

    // 입력 검사: 전화번호·주민번호 같은 글자, 같은 옵션 두 번, 너무 긴 이름은 거부해요.
    expect((await facilities.call('POST', '/api/cafe/menu', { name: '라테 900101-1234567', priceWon: 3000, options: [] })).status).toBe(400);
    expect((await facilities.call('POST', '/api/cafe/menu', { name: '라테', priceWon: 3000, options: ['someone@corp.example'] })).status).toBe(400);
    expect((await facilities.call('POST', '/api/cafe/menu', { name: '라테', priceWon: 3000, options: ['핫', '핫'] })).status).toBe(400);
    expect((await facilities.call('POST', '/api/cafe/menu', { name: '라'.repeat(41), priceWon: 3000, options: [] })).status).toBe(400);
    expect((await facilities.call('POST', '/api/cafe/menu', { name: '라테', priceWon: -1, options: [] })).status).toBe(400);
    expect((await facilities.call('PUT', '/api/cafe/menu/no-such', { name: '라테', priceWon: 1000, options: [], active: true })).status).toBe(404);
  });
});

describe('[F4 완료 기준] 이름·금액을 다른 사람·AI에 내보내지 않아요', () => {
  it('카페 판(바리스타) 응답·알림에 금액·입금 코드가 없고, 미납자가 카페 판에 보이지 않아요', async () => {
    const { t } = await octoberBills();
    const p = await jumpTo(t, '2026-11-08T09:00:00+09:00');
    await t.runRetention();
    const board = (await p.barista.call('GET', '/api/cafe/board')).body as CafeBoardResponse;
    const text = JSON.stringify(board) + JSON.stringify(await notes(p.barista));
    for (const secret of ['원', '8000', '8,000', '2000', 'won', 'Won', 'unpaid', 'overdue', 'bill', '하늘', '도윤', ...(await bills(t)).map((b) => b.code)])
      expect(text).not.toContain(secret);
  });

  it('모든 카페 알림 제목은 정해진 글이고 금액·메뉴·입금 코드가 없어요', async () => {
    const { t, dev, facilities } = await octoberBills();
    await dev.call('POST', '/api/cafe/limit/request', { amountWon: 600_000 });
    const r = (await settle(facilities)).requests[0]!;
    await facilities.call('POST', `/api/cafe/limit/${r.id}/approve`);
    const v = await settle(facilities);
    await facilities.call('POST', `/api/cafe/bills/${v.bills[0]!.id}/paid`);
    // 8일 0시 20분: 1일 알림이 아직 지워지기 전이에요(알림 보관 7일).
    await jumpTo(t, '2026-11-08T00:20:00+09:00');
    await t.runRetention();
    const { rows } = await t.db.query<{ title: string }>("select title from notifications where module = 'cafeteria' order by id");
    expect(rows.map((r) => r.title)).toEqual([
      '카페 청구서가 나왔어요',
      '카페 청구서가 나왔어요',
      '카페 한도 요청이 왔어요',
      '카페 한도를 늘렸어요',
      '카페 값 입금을 확인했어요',
      '카페 값 납부 기한이 지났어요',
    ]);
    for (const row of rows) expect(ALLOWED_TITLES).toContain(row.title);
    const text = JSON.stringify(rows);
    for (const secret of ['원', '0', '8', '2', '라테', '아메리카노', ...(await bills(t)).map((b) => b.code)]) expect(text).not.toContain(secret);
  });

  it('[ADR-10·18] 청구·한도·정산 전 과정에서 AI 게이트웨이를 부르지 않아요', async () => {
    const t0 = await setup();
    const spy = vi.spyOn(t0.t.ctx.gateway, 'structured');
    await order(t0.staff, LATTE2);
    await t0.staff.call('POST', '/api/cafe/limit/request', { amountWon: 600_000 });
    const p = await jumpTo(t0.t, '2026-11-01T01:00:00+09:00');
    await t0.t.runRetention();
    await view(p.staff);
    const v = await settle(p.facilities);
    await p.facilities.call('POST', `/api/cafe/bills/${v.bills[0]!.id}/paid`);
    await csv(t0.t, p.facilities, '2026-10');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('[ADR-12] 회사 계좌 안내(운영 설정)', () => {
  it('운영자만 바꾸고, 80자·줄바꿈 없음만 받고, 직원 청구에 그대로 보여요. 감사 로그에는 글이 없어요', async () => {
    const { t, staff } = await setup();
    const operator = await t.loginAs(MOCK.operator);
    const text = '가상은행 000-0000-0000 (주)가상회사';
    expect((await staff.call('PUT', '/api/ops/cafe-account', { text })).status).toBe(403);
    expect((await operator.call('PUT', '/api/ops/cafe-account', { text: '첫 줄\n둘째 줄' })).status).toBe(400);
    expect((await operator.call('PUT', '/api/ops/cafe-account', { text: '가'.repeat(81) })).status).toBe(400);
    expect((await operator.call('PUT', '/api/ops/cafe-account', { text })).status).toBe(200);
    expect((await view(staff)).billing.account).toBe(text);
    expect((await operator.call('PUT', '/api/ops/cafe-account', { text: '' })).status).toBe(200);
    expect((await view(staff)).billing.account).toBe('계좌는 총무에게 물어봐 주세요');
    const audit = JSON.stringify((await t.db.query("select * from audit_log where action = 'cafeAccount.set'")).rows);
    expect(audit).not.toContain('가상은행');
    expect(audit).toContain('cleared');
    // 운영 값 범위
    expect((await operator.call('PUT', '/api/ops/values', { cafeMonthlyLimitWon: 9_999 })).status).toBe(400);
    expect((await operator.call('PUT', '/api/ops/values', { cafeDueDays: 29 })).status).toBe(400);
    expect((await operator.call('PUT', '/api/ops/values', { cafeMonthlyLimitWon: 300_000, cafeDueDays: 10 })).status).toBe(200);
    expect((await view(staff)).billing).toMatchObject({ limitWon: 300_000, dueDays: 10 });
  });
});
