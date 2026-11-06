import type {
  CafeBoardResponse,
  CafeOrderLineInput,
  CafeResponse,
  NotificationsResponse,
  PlanConfirmResponse,
  PlanCreateResponse,
} from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { pseudonymize } from '../../core/pseudonym';
import { computeRoles } from '../../core/roles';
import { createTestApp, MOCK } from '../../testing';

// F4 사내 카페 주문 1묶음(11/6, PRD F4 완료 기준·ADR-29 "시험으로 지키는 것").
// 시계는 2026-10-26(월) 09:00(한국)이에요. 고를 수 있는 첫 픽업 칸은 09:10이에요.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;

const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const AMERICANO: CafeOrderLineInput = { menuId: 'americano', qty: 1, options: ['아이스'] };
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function setup(opts: { on?: boolean } = {}) {
  const t = await createTestApp();
  opened.push(t);
  await t.modules.find((m) => m.kind === 'cafeteria')!.seed!();
  if (opts.on ?? true) await t.ctx.ops.setModule('p_test-operator', 'cafeteria', 'on');
  const staff = await t.loginAs(MOCK.staff);
  const barista = await t.loginAs(MOCK.barista);
  return { t, staff, barista };
}

async function openCafe(barista: Session) {
  expect((await barista.call('POST', '/api/cafe/board/open')).status).toBe(200);
}

async function view(me: Session): Promise<Extract<CafeResponse, { status: 'on' }>> {
  const res = await me.call('GET', '/api/cafe');
  expect(res.status).toBe(200);
  return res.body;
}

async function propose(me: Session, lines: CafeOrderLineInput[] = [AMERICANO], slotIndex = 0) {
  const slot = (await view(me)).slots[slotIndex]!.start;
  return me.call('POST', '/api/cafe/order/propose', { lines, pickupSlot: slot });
}

async function sheet(me: Session, token: string): Promise<{ status: number; body: PlanCreateResponse & { error?: string; message?: string } }> {
  return me.call('POST', '/api/plans', { proposalToken: token });
}

async function planFor(me: Session, lines?: CafeOrderLineInput[], slotIndex?: number): Promise<string> {
  const p = await propose(me, lines, slotIndex);
  expect(p.status).toBe(200);
  const created = await sheet(me, p.body.proposalToken);
  expect(created.status).toBe(200);
  if (created.body.status !== 'sheet') throw new Error('확인 시트가 아니에요');
  return created.body.planId;
}

async function confirm(me: Session, planId: string): Promise<PlanConfirmResponse> {
  const res = await me.call('POST', `/api/plans/${planId}/confirm`);
  expect(res.status).toBe(200);
  return res.body;
}

async function order(me: Session, lines?: CafeOrderLineInput[], slotIndex?: number): Promise<PlanConfirmResponse> {
  return confirm(me, await planFor(me, lines, slotIndex));
}

async function orders(t: TestApp) {
  const { rows } = await t.db.query<{ id: string; pseudonym_id: string; pickup_no: number; total_won: number; status: string; order_day: string }>(
    'select id::text as id, pseudonym_id, pickup_no, total_won, status, order_day::text as order_day from cafe_orders order by id',
  );
  return rows;
}

const idOf = (res: PlanConfirmResponse) => {
  if (res.status !== 'done') throw new Error(`주문이 들어가지 않았어요: ${res.status}`);
  return res.card.id.replace('cafe-order-', '');
};

describe('[F4] 영업 중에만 주문', () => {
  it('[ADR-29 시험] 바리스타가 영업을 시작하지 않았으면 제안 0건, 영업 끝 뒤에는 확인 시트·실행도 막혀요', async () => {
    const { t, staff, barista } = await setup();
    expect((await view(staff)).open).toBe(false);
    const closed = await propose(staff);
    expect(closed.status).toBe(409);
    expect(closed.body.message).toBe('지금은 카페가 주문을 받지 않아요');

    await openCafe(barista);
    expect((await view(staff)).open).toBe(true);
    const p = await propose(staff);
    expect(p.status).toBe(200);
    // 토큰을 받은 뒤 영업이 끝나면 확인 시트가 막혀요.
    expect((await barista.call('POST', '/api/cafe/board/close')).status).toBe(200);
    const blockedSheet = await sheet(staff, p.body.proposalToken);
    expect(blockedSheet.status).toBe(409);
    expect(blockedSheet.body.message).toBe('지금은 카페가 주문을 받지 않아요');

    // 확인 시트를 연 뒤 영업이 끝나면 [주문하기]가 막힘이에요.
    await openCafe(barista);
    const planId = await planFor(staff);
    expect((await barista.call('POST', '/api/cafe/board/close')).status).toBe(200);
    const res = await confirm(staff, planId);
    expect(res.status).toBe('blocked');
    if (res.status === 'blocked') expect(res.card.headline).toBe('지금은 카페가 주문을 받지 않아요');
    expect(await orders(t)).toEqual([]);
  });

  it('[ADR-29 시험] 카페 판이 2분 넘게 서버에 안 보이면 주문 받기가 자동으로 멈춰요(제안·실행 0건)', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    const planId = await planFor(staff);
    t.advance(2 * MINUTE + 1000);
    // 판을 읽지 않은 채 2분이 지났어요. 확인 시트를 이미 열었어도 실행이 막혀요.
    const res = await confirm(staff, planId);
    expect(res.status).toBe('blocked');
    expect((await propose(staff)).status).toBe(409);
    expect((await view(staff)).open).toBe(false);
    expect(await orders(t)).toEqual([]);

    // 판이 다시 보이면(3초마다 읽기) 다시 받아요.
    expect((await barista.call('GET', '/api/cafe/board')).status).toBe(200);
    expect((await view(staff)).open).toBe(true);
    expect((await order(staff)).status).toBe('done');
  });
});

describe('[F4] 확인 시트로만 들어가는 주문', () => {
  it('[F4 완료 기준] 확인 없이·남의 plan으로·만료된 plan으로는 주문 0건, 같은 plan을 두 번 보내도 1건이에요', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    // 제안 토큰만으로는 아무것도 쓰지 않아요.
    const p = await propose(staff);
    expect(p.status).toBe(200);
    expect(await orders(t)).toEqual([]);

    // 남이 받은 제안은 열 수 없어요.
    const dev = await t.loginAs(MOCK.dev);
    expect((await sheet(dev, p.body.proposalToken)).status).toBe(403);

    // 확인 시트를 열기만 해도 0건이에요.
    const created = await sheet(staff, p.body.proposalToken);
    expect(created.body.status).toBe('sheet');
    expect(await orders(t)).toEqual([]);
    if (created.body.status !== 'sheet') return;
    // 남의 plan을 확인하면 찾지 못해요.
    expect((await dev.call('POST', `/api/plans/${created.body.planId}/confirm`)).status).toBe(404);
    expect(await orders(t)).toEqual([]);

    // 같은 plan을 두 번(동시에) 보내도 1건이고 같은 결과예요.
    const [a, b] = await Promise.all([confirm(staff, created.body.planId), confirm(staff, created.body.planId)]);
    expect(a.status).toBe('done');
    expect(b).toEqual(a);
    expect(await confirm(staff, created.body.planId)).toEqual(a);
    expect(await orders(t)).toHaveLength(1);

    // 만료된 plan은 실행하지 않아요.
    await barista.call('GET', '/api/cafe/board');
    const late = await planFor(staff);
    t.advance(11 * MINUTE);
    const expired = await confirm(staff, late);
    expect(expired.status).toBe('expired');
    expect(await orders(t)).toHaveLength(1);
  });

  it('[F4-1] 확인 시트에 메뉴·옵션·수량·합계·픽업 칸·이번 달 지금까지와 꼬리 문구가 있고, 자동 실행 목록이 아니에요', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    expect((await order(staff, [{ menuId: 'latte', qty: 1, options: [] }])).status).toBe('done');
    const p = await propose(staff, [{ menuId: 'americano', qty: 2, options: ['연하게', '아이스'] }], 1);
    const created = await sheet(staff, p.body.proposalToken);
    if (created.body.status !== 'sheet') throw new Error('확인 시트가 아니에요');
    expect(created.body.sheet).toEqual({
      title: '이대로 주문할까요?',
      lines: ['아메리카노(아이스·연하게) × 2 · 4,000원', '합계 4,000원', '픽업 09:20–09:30', '이번 달 지금까지 2,500원'],
      confirmLabel: '주문하기',
      note: '이번 달 카페 값은 다음 달 1일에 청구돼요. 7일 안에 회사 계좌로 보내 주세요',
    });
    // 돈이 걸려서 채팅 자동 실행(ADR-19)으로는 부를 수 없어요.
    const staffUser = {
      sessionId: 's',
      pseudonymId: 'p_x',
      idpSubject: MOCK.staff,
      displayName: 'x',
      department: 'x',
      floor: '3층',
      roles: ['employee' as const],
    };
    await expect(t.ctx.plans.auto(staffUser, 'cafeteria', 'order', {}, 'request-0001')).rejects.toThrow('자동으로 실행할 수 없는 일이에요');
  });

  it('[F4-2] 금액은 서버가 메뉴 직원가 × 수량으로 계산해요. 화면이 금액을 보낼 수 없고, 값이 바뀌면 본 값과 달라서 막혀요', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    const slot = (await view(staff)).slots[0]!.start;
    const withPrice = await staff.call('POST', '/api/cafe/order/propose', {
      lines: [{ ...AMERICANO, priceWon: 10 }],
      pickupSlot: slot,
    });
    expect(withPrice.status).toBe(400);
    const withTotal = await staff.call('POST', '/api/cafe/order/propose', { lines: [AMERICANO], pickupSlot: slot, totalWon: 10 });
    expect(withTotal.status).toBe(400);

    const done = await order(staff, [
      { menuId: 'americano', qty: 2, options: [] },
      { menuId: 'vanilla-latte', qty: 1, options: ['샷 추가'] },
    ]);
    expect(done.status).toBe('done');
    expect((await orders(t))[0]!.total_won).toBe(2000 * 2 + 3000);
    if (done.status === 'done') expect(done.card.fields).toContainEqual({ name: '합계', value: '7,000원' });

    // 확인 시트를 연 뒤 직원가가 바뀌면 사람이 본 값과 달라서 실행하지 않아요(ADR-03).
    const planId = await planFor(staff);
    await t.db.query("update cafe_menu set price_won = 2200 where id = 'americano'");
    const changed = await confirm(staff, planId);
    expect(changed.status).toBe('blocked');
    expect(await orders(t)).toHaveLength(1);
    // 다시 고르면 지금 값으로 들어가요.
    expect((await order(staff)).status).toBe('done');
    expect((await orders(t))[1]!.total_won).toBe(2200);
  });

  it('메뉴가 정한 옵션만, 줄 5개·잔 5개까지만 받아요', async () => {
    const { staff, barista } = await setup();
    await openCafe(barista);
    expect((await propose(staff, [{ menuId: 'cold-brew', qty: 1, options: ['핫'] }])).status).toBe(400);
    expect((await propose(staff, [{ menuId: 'americano', qty: 6, options: [] }])).status).toBe(400);
    expect((await propose(staff, [{ menuId: 'americano', qty: 1, options: ['아이스 <script>'] }])).status).toBe(400);
    expect((await propose(staff, [AMERICANO, AMERICANO])).status).toBe(400);
    const six = ['americano', 'latte', 'vanilla-latte', 'cold-brew', 'green-tea-latte', 'iced-tea'].map((menuId) => ({ menuId, qty: 1, options: [] }));
    expect((await propose(staff, six)).status).toBe(400);
    expect((await propose(staff, [{ menuId: 'no-such', qty: 1, options: [] }])).status).toBe(409);
  });
});

describe('[F4-3] 품절과 픽업 칸 상한', () => {
  it('품절이면 새 제안이 막히고, 확인 시트를 연 뒤 품절이 되면 실행도 막혀요', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    const planId = await planFor(staff);
    expect((await barista.call('PUT', '/api/cafe/menu/americano/sold-out', { soldOut: true })).status).toBe(200);
    expect((await view(staff)).menu.find((m) => m.id === 'americano')?.soldOut).toBe(true);
    const res = await confirm(staff, planId);
    expect(res.status).toBe('blocked');
    const p = await propose(staff);
    expect(p.status).toBe(409);
    expect(p.body.error).toBe('sold-out');
    expect(await orders(t)).toEqual([]);
    expect((await barista.call('PUT', '/api/cafe/menu/americano/sold-out', { soldOut: false })).status).toBe(200);
    expect((await propose(staff)).status).toBe(200);
  });

  it('[ADR-29 시험] 같은 칸에 두 사람이 동시에 주문해도 칸 잔 수 상한을 넘지 않아요. 꽉 찬 칸은 고를 수 없고 다음 칸을 권해요', async () => {
    const { t, staff, barista } = await setup();
    t.ctx.ops.patchValues({ cafeSlotCapacity: 3 });
    await openCafe(barista);
    const dev = await t.loginAs(MOCK.dev);
    const two = [{ menuId: 'latte', qty: 2, options: [] }];
    const [a, b] = [await planFor(staff, two), await planFor(dev, two)];
    const [ra, rb] = await Promise.all([confirm(staff, a), confirm(dev, b)]);
    expect([ra.status, rb.status].sort()).toEqual(['blocked', 'done']);
    const blocked = ra.status === 'blocked' ? ra : rb;
    if (blocked.status === 'blocked') expect(blocked.card.fields).toContainEqual({ name: '비어 있는 다음 칸', value: '09:20–09:30' });
    expect(await orders(t)).toHaveLength(1);

    // 남은 한 잔은 받아요. 그 뒤로는 꽉 차서 고를 수 없어요.
    expect((await order(dev, [{ menuId: 'latte', qty: 1, options: [] }])).status).toBe('done');
    const slots = (await view(staff)).slots;
    expect(slots[0]).toMatchObject({ label: '09:10', left: 0, full: true });
    expect(slots[1]).toMatchObject({ label: '09:20', left: 3, full: false });
    const full = await propose(staff);
    expect(full.status).toBe(409);
    expect(full.body.message).toBe('그 픽업 시간은 꽉 찼어요. 다음 칸(09:20)을 골라 주세요');
    // 지나간 칸이나 정해진 10분 칸이 아닌 시각은 고를 수 없어요.
    expect((await staff.call('POST', '/api/cafe/order/propose', { lines: [AMERICANO], pickupSlot: '2026-10-26T09:15:00+09:00' })).status).toBe(400);
    expect((await staff.call('POST', '/api/cafe/order/propose', { lines: [AMERICANO], pickupSlot: '2026-10-26T08:50:00+09:00' })).status).toBe(400);
  });
});

describe('[F4-4] 카페 판(바리스타)', () => {
  it('[F4 완료 기준] 바리스타가 아닌 사람이 카페 판 경로를 부르면 403이에요', async () => {
    const { t, staff } = await setup();
    const facilities = await t.loginAs(MOCK.facilities);
    for (const me of [staff, facilities]) {
      expect((await me.call('GET', '/api/cafe/board')).status).toBe(403);
      expect((await me.call('POST', '/api/cafe/board/open')).status).toBe(403);
      expect((await me.call('POST', '/api/cafe/board/close')).status).toBe(403);
      expect((await me.call('POST', '/api/cafe/orders/1/status', { to: 'making' })).status).toBe(403);
      expect((await me.call('PUT', '/api/cafe/menu/americano/sold-out', { soldOut: true })).status).toBe(403);
    }
    const { rows } = await t.db.query<{ open: boolean }>('select open from cafe_duty');
    expect(rows).toEqual([{ open: false }]);
  });

  it('[F4 완료 기준] 카페 판 응답에는 주문한 사람의 가명 ID·이름·금액이 없어요(번호·메뉴·옵션·픽업 칸만)', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    expect((await order(staff, [{ menuId: 'americano', qty: 2, options: ['아이스', '샷 추가'] }])).status).toBe('done');
    const res = await barista.call('GET', '/api/cafe/board');
    const board = res.body as CafeBoardResponse;
    expect(board.orders).toEqual([
      {
        id: expect.any(String),
        pickupNo: 1,
        lines: [{ name: '아메리카노', options: ['아이스', '샷 추가'], qty: 2 }],
        pickupLabel: '09:10–09:20',
        status: 'waiting',
        orderedAt: '09:00',
      },
    ]);
    const text = JSON.stringify(res.body);
    const staffPseudonym = pseudonymize(t.ctx.config.pseudonymSecret, MOCK.staff);
    for (const secret of [staffPseudonym, '가상 직원 하늘', '하늘', 'haneul', '재무팀', '원', '4000', '4,000', '2000', 'price', 'total', 'won', 'pseudonym']) {
      expect(text).not.toContain(secret);
    }
  });

  it('[F4-4] 상태는 접수 대기 → 만드는 중 → 나왔어요 → 가져감 순서로만 바뀌고, 나왔어요 알림 글에는 메뉴·금액이 없어요', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    const id = idOf(await order(staff));
    const step = (to: string) => barista.call('POST', `/api/cafe/orders/${id}/status`, { to });

    // 건너뛰기(접수 대기 → 나왔어요)·없는 상태·되돌리기는 안 돼요.
    expect((await step('ready')).status).toBe(409);
    expect((await step('picked')).status).toBe(409);
    expect((await step('waiting')).status).toBe(400);
    expect((await step('cancelled')).status).toBe(400);
    expect((await step('making')).status).toBe(200);
    // 같은 버튼을 두 번 눌러도 한 번이에요.
    expect((await step('making')).body).toEqual({ id, status: 'making' });
    expect((await t.db.query('select 1 from cafe_orders where id = $1 and status = $2', [id, 'making'])).rows).toHaveLength(1);

    const before = (await staff.call('GET', '/api/notifications')).body as NotificationsResponse;
    expect(before.items).toEqual([]);
    expect((await step('ready')).status).toBe(200);
    expect((await barista.call('POST', `/api/cafe/orders/${id}/status`, { to: 'making' })).status).toBe(409);

    const after = (await staff.call('GET', '/api/notifications')).body as NotificationsResponse;
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ title: '주문한 음료가 나왔어요', page: 'cafe', read: false });
    const { rows } = await t.db.query<{ title: string; module: string }>('select title, module from notifications');
    expect(rows).toEqual([{ title: '주문한 음료가 나왔어요', module: 'cafeteria' }]);
    for (const secret of ['아메리카노', '아이스', '2,000', '2000', '원', '픽업']) expect(JSON.stringify(after)).not.toContain(secret);
    // 바리스타에게는 알림이 가지 않아요.
    expect(((await barista.call('GET', '/api/notifications')).body as NotificationsResponse).items).toEqual([]);

    expect((await step('picked')).status).toBe(200);
    expect(((await barista.call('GET', '/api/cafe/board')).body as CafeBoardResponse).orders).toEqual([]);
    expect((await view(staff)).orders[0]).toMatchObject({ status: 'picked', cancellable: false });
  });

  it('[ADR-29] 등록된 바리스타는 역할 cafe예요(IdP 역할 그룹 /역할/cafe)', async () => {
    const { barista, staff } = await setup();
    expect(barista.me).toMatchObject({ displayName: '가상 바리스타 하준', department: '카페팀', floor: '1층' });
    expect(barista.me.roles).toEqual(['employee', 'cafe']);
    expect(staff.me.roles).not.toContain('cafe');
    expect(computeRoles({ idpSubject: 'x', displayName: 'x', department: 'x', floor: '1층', groups: ['cafe'] }, new Set())).toContain('cafe');
    expect(computeRoles({ idpSubject: 'x', displayName: 'x', department: 'x', floor: '1층', groups: [] }, new Set())).not.toContain('cafe');
  });
});

describe('[F4] 취소·번호·이번 달 합계', () => {
  it('[F4-4] 취소는 본인 주문이고 카페가 받기 전(접수 대기)일 때만 돼요', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    const dev = await t.loginAs(MOCK.dev);
    const first = idOf(await order(staff));
    const second = idOf(await order(staff));

    expect((await dev.call('POST', `/api/cafe/orders/${first}/cancel`)).status).toBe(404);
    const cancelled = await staff.call('POST', `/api/cafe/orders/${first}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'done', card: { label: '확정', headline: '주문을 취소했어요 · 픽업 번호 1' } });
    // 같은 버튼을 다시 눌러도 같은 결과예요.
    expect((await staff.call('POST', `/api/cafe/orders/${first}/cancel`)).body).toEqual(cancelled.body);

    expect((await barista.call('POST', `/api/cafe/orders/${second}/status`, { to: 'making' })).status).toBe(200);
    const taken = await staff.call('POST', `/api/cafe/orders/${second}/cancel`);
    expect(taken.status).toBe(409);
    expect(taken.body.message).toBe('카페가 이미 받아서 취소할 수 없어요');
    expect((await orders(t)).map((o) => o.status)).toEqual(['cancelled', 'making']);
    // 취소한 주문은 카페 판에서 빠져요.
    expect(((await barista.call('GET', '/api/cafe/board')).body as CafeBoardResponse).orders.map((o) => o.id)).toEqual([second]);
  });

  it('[F4-3] 픽업 번호는 한국 날짜마다 1부터예요', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    await order(staff);
    await order(staff);
    // 다음 날 09:00(쉬는 시간이 지나 다시 로그인해요)
    t.advance(DAY);
    const staff2 = await t.loginAs(MOCK.staff);
    const barista2 = await t.loginAs(MOCK.barista);
    await openCafe(barista2);
    const next = await order(staff2);
    if (next.status === 'done') expect(next.card.headline).toBe('주문했어요 · 픽업 번호 1');
    expect((await orders(t)).map((o) => [o.order_day, o.pickup_no])).toEqual([
      ['2026-10-26', 1],
      ['2026-10-26', 2],
      ['2026-10-27', 1],
    ]);
    // 카페 판은 오늘 주문만 보여요.
    expect(((await barista2.call('GET', '/api/cafe/board')).body as CafeBoardResponse).orders.map((o) => o.pickupNo)).toEqual([1]);
  });

  it('[F4-1] "이번 달 지금까지"는 취소를 뺀 내 주문 합계를 주문 행에서 셌어요(남의 주문·지난달 빼고)', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    const dev = await t.loginAs(MOCK.dev);
    await order(staff, [{ menuId: 'latte', qty: 2, options: [] }]);
    const cancelled = idOf(await order(staff, [{ menuId: 'americano', qty: 1, options: [] }]));
    await staff.call('POST', `/api/cafe/orders/${cancelled}/cancel`);
    await order(dev, [{ menuId: 'vanilla-latte', qty: 1, options: [] }]);
    const mine = await view(staff);
    expect(mine.monthTotalWon).toBe(5000);
    expect(mine.orders.map((o) => [o.pickupNo, o.status, o.cancellable])).toEqual([
      [2, 'cancelled', false],
      [1, 'waiting', true],
    ]);
    expect((await view(dev)).monthTotalWon).toBe(3000);
    const recount = await t.db.query<{ won: number }>(
      "select coalesce(sum(total_won), 0)::int as won from cafe_orders where pseudonym_id = $1 and status <> 'cancelled'",
      [pseudonymize(t.ctx.config.pseudonymSecret, MOCK.staff)],
    );
    expect(recount.rows[0]!.won).toBe(mine.monthTotalWon);
    // 다음 달로 넘어가면 0부터 세요.
    t.advance(6 * DAY);
    expect((await view(await t.loginAs(MOCK.staff))).monthTotalWon).toBe(0);
  });
});

describe('[F4-15] 스위치', () => {
  it('[R4] 카페가 끔(출시 기본)이면 직원·카페 판 경로가 닫히고, 링크만이면 카페 안내 링크 카드만 와요', async () => {
    const { t, staff, barista } = await setup({ on: false });
    expect(t.ctx.ops.get().modules.cafeteria).toBe('off');
    expect((await staff.call('GET', '/api/cafe')).status).toBe(409);
    expect((await staff.call('POST', '/api/cafe/order/propose', { lines: [AMERICANO], pickupSlot: '2026-10-26T09:10:00+09:00' })).status).toBe(409);
    expect((await barista.call('GET', '/api/cafe/board')).status).toBe(409);
    expect((await barista.call('POST', '/api/cafe/board/open')).status).toBe(409);
    expect((await barista.call('PUT', '/api/cafe/menu/americano/sold-out', { soldOut: true })).status).toBe(409);

    await t.ctx.ops.setModule('p_test-operator', 'cafeteria', 'link');
    const link = await staff.call('GET', '/api/cafe');
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ status: 'link', card: { kind: 'cafeteria', label: '안내', actions: { primary: { type: 'link' } } } });
    expect((await staff.call('POST', '/api/cafe/order/propose', { lines: [AMERICANO], pickupSlot: '2026-10-26T09:10:00+09:00' })).status).toBe(409);
    expect((await barista.call('GET', '/api/cafe/board')).status).toBe(409);
  });

  it('[ADR-12] 확인 시트를 연 뒤 카페를 끄면 [주문하기]가 막힘(기능 꺼짐)이에요', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    const planId = await planFor(staff);
    await t.ctx.ops.setModule('p_test-operator', 'cafeteria', 'off');
    const res = await confirm(staff, planId);
    expect(res.status).toBe('blocked');
    expect(await orders(t)).toEqual([]);
  });
});

describe('[ADR-21·29] 보관과 감사 로그', () => {
  it('취소한 주문은 취소하고 7일 뒤 지워지고, 다른 주문은 청구 묶음 전까지 남아요', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    const kept = idOf(await order(staff));
    const cancelled = idOf(await order(staff));
    await staff.call('POST', `/api/cafe/orders/${cancelled}/cancel`);
    t.advance(6 * DAY);
    expect(await t.runRetention()).toEqual([]);
    expect((await orders(t)).map((o) => o.id)).toEqual([kept, cancelled]);
    t.advance(DAY + MINUTE);
    expect(await t.runRetention()).toEqual([]);
    expect((await orders(t)).map((o) => o.id)).toEqual([kept]);
  });

  it('[ADR-29 시험] 감사 로그에는 모듈·동작·결과만 남고 금액·메뉴·주문 번호는 없어요', async () => {
    const { t, staff, barista } = await setup();
    await openCafe(barista);
    const id = idOf(await order(staff, [{ menuId: 'vanilla-latte', qty: 3, options: ['샷 추가'] }]));
    await barista.call('POST', `/api/cafe/orders/${id}/status`, { to: 'making' });
    await barista.call('PUT', '/api/cafe/menu/latte/sold-out', { soldOut: true });
    const second = idOf(await order(staff));
    await staff.call('POST', `/api/cafe/orders/${second}/cancel`);
    const { rows } = await t.db.query<Record<string, unknown>>(
      "select pseudonym_id, channel, module, action, tool, client_id, plan_id::text as plan_id, result from audit_log where module = 'cafeteria' order by id",
    );
    expect(rows.map((r) => [r.channel, r.action, r.result])).toEqual([
      ['ops', 'switch.set', 'on'],
      ['write', 'duty-open', 'done'],
      ['write', 'order', 'done'],
      ['write', 'order-status', 'making'],
      ['write', 'menu-sold-out', 'sold-out'],
      ['write', 'order', 'done'],
      ['write', 'order-cancel', 'done'],
    ]);
    const text = JSON.stringify(rows);
    for (const secret of ['바닐라라테', '카페라테', '아메리카노', '샷 추가', '9000', '9,000', '2000', '원', `"${id}"`, `"${second}"`])
      expect(text).not.toContain(secret);
  });
});
