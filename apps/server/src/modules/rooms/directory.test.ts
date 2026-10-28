import type { Card, PlanConfirmResponse, PlanCreateResponse, RoomCardsResponse, RoomDayResponse, RoomListResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { LEDGER_BOOKINGS, LEDGER_ROOMS } from './fixtures/ledger';

// 회의실 둘러보기(10/26): 방 카드 목록 · 방 자세히(설비·지금 상태·하루 일정) · 이 방 이 시간 예약 제안.
// 시계는 2026-10-26(월) 09:00이에요. 모의 장부에는 오늘 3C 10:00~11:00, 2A 14:00~15:00 예약이 있어요.

const TODAY = '2026-10-26';
const TOMORROW = '2026-10-27';
const MINUTE = 60_000;
// 원본 장부에만 있는 값. 어디에도 나오면 안 돼요(ADR-06).
const LEDGER_SECRETS = [...new Set(LEDGER_BOOKINGS.flatMap((b) => [b.organizer, b.title]))];

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  await t.modules.find((m) => m.kind === 'rooms')!.seed!();
  return t;
}

function tokenOf(card: Card | undefined): string {
  const action = card?.actions.primary;
  if (action?.type !== 'propose') throw new Error('제안 카드가 아니에요');
  return action.proposalToken;
}

describe('회의실 둘러보기', () => {
  it('[회의실 둘러보기] 방 카드 목록에 그림·정원·설비가 있고, 층 순서예요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const res = await me.call('GET', '/api/rooms/list');
    expect(res.status).toBe(200);
    const body = res.body as RoomListResponse;
    expect(body).toMatchObject({ date: TODAY, mock: true, linkOnly: false });
    expect(body.rooms).toHaveLength(LEDGER_ROOMS.length);
    expect(body.rooms.map((r) => r.floor)).toEqual([...body.rooms.map((r) => r.floor)].sort((a, b) => parseInt(a, 10) - parseInt(b, 10)));
    const big = body.rooms.find((r) => r.id === 'r-5c')!;
    expect(big).toMatchObject({ name: '대회의실 5C', capacity: 20, photoUrl: '/rooms/r-5c.svg' });
    expect(big.facilities).toContain('빔프로젝터 2대');
    expect(Object.keys(big).sort()).toEqual(['capacity', 'equipment', 'facilities', 'floor', 'id', 'name', 'photoUrl', 'repairs', 'status']);
  });

  it('[회의실 둘러보기] 오늘은 지금 상태(비어 있음·다음 예약 / 사용 중·비는 시각), 다른 날은 예약 수예요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const at9 = (await me.call('GET', '/api/rooms/list')).body as RoomListResponse;
    expect(at9.rooms.find((r) => r.id === 'r-3c')!.status).toEqual({ kind: 'free-now', nextBusyAt: '10:00' });
    expect(at9.rooms.find((r) => r.id === 'r-3a')!.status).toEqual({ kind: 'free-now', nextBusyAt: null });

    t.advance(90 * MINUTE); // 10:30
    const at1030 = (await me.call('GET', '/api/rooms/list')).body as RoomListResponse;
    expect(at1030.rooms.find((r) => r.id === 'r-3c')!.status).toEqual({ kind: 'busy-now', freeAt: '11:00' });

    const tomorrow = (await me.call('GET', `/api/rooms/list?date=${TOMORROW}`)).body as RoomListResponse;
    expect(tomorrow.rooms.find((r) => r.id === 'r-2b')!.status).toEqual({ kind: 'day', bookings: 1 });
  });

  it('[회의실 둘러보기·ADR-06] 하루 일정의 남의 예약은 "예약됨"(시간만)이고, 내 예약에만 취소가 붙어요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const other = await t.loginAs(MOCK.dev);

    // 내가 3C를 오늘 15:00~16:00에 예약해요(확인 시트 한 번).
    const slot = (await me.call('POST', '/api/rooms/r-3c/slot', { date: TODAY, start: '15:00', minutes: 60 })).body as RoomCardsResponse;
    const created = (await me.call('POST', '/api/plans', { proposalToken: tokenOf(slot.cards[0]) })).body as PlanCreateResponse;
    if (created.status !== 'sheet') throw new Error('확인 시트가 아니에요');
    expect(((await me.call('POST', `/api/plans/${created.planId}/confirm`)).body as PlanConfirmResponse).status).toBe('done');

    const mine = (await me.call('GET', `/api/rooms/r-3c/day?date=${TODAY}`)).body as RoomDayResponse;
    expect(mine).toMatchObject({ date: TODAY, open: '07:00', close: '22:00', room: { id: 'r-3c', capacity: 10 } });
    expect(mine.blocks.map((b) => [b.start, b.end, b.mine, Boolean(b.cancel)])).toEqual([
      ['10:00', '11:00', false, false],
      ['15:00', '16:00', true, true],
    ]);

    const theirs = (await other.call('GET', `/api/rooms/r-3c/day?date=${TODAY}`)).body as RoomDayResponse;
    expect(theirs.blocks.map((b) => [b.start, b.end, b.mine, Boolean(b.cancel)])).toEqual([
      ['10:00', '11:00', false, false],
      ['15:00', '16:00', false, false],
    ]);
    for (const b of theirs.blocks) expect(Object.keys(b).sort()).toEqual(['end', 'mine', 'start']);

    const all = JSON.stringify([mine, theirs, (await other.call('GET', '/api/rooms/list')).body]);
    for (const secret of LEDGER_SECRETS) expect(all).not.toContain(secret);
  });

  it('[회의실 둘러보기] 고른 시간이 비면 [이 시간으로 예약], 차 있으면 같은 방 가까운 시간 대안, 지난 시간이면 안내예요(쓰기 없음)', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const before = (await t.db.query('select count(*)::int as n from plans')).rows[0];

    const free = (await me.call('POST', '/api/rooms/r-3c/slot', { date: TODAY, start: '13:00', minutes: 60 })).body as RoomCardsResponse;
    expect(free.cards).toHaveLength(1);
    expect(free.cards[0]).toMatchObject({ label: '제안', headline: '회의실 3C', actions: { primary: { type: 'propose', text: '이 시간으로 예약' } } });

    const taken = (await me.call('POST', '/api/rooms/r-3c/slot', { date: TODAY, start: '10:00', minutes: 60 })).body as RoomCardsResponse;
    expect(taken.cards[0]).toMatchObject({ label: '안내', headline: '그 시간에는 이미 예약이 있어요' });
    expect(taken.cards.length).toBeGreaterThan(1);
    for (const alt of taken.cards.slice(1)) expect(alt.headline).toBe('대안: 회의실 3C');

    const past = (await me.call('POST', '/api/rooms/r-3c/slot', { date: TODAY, start: '08:00', minutes: 60 })).body as RoomCardsResponse;
    expect(past.cards).toEqual([expect.objectContaining({ label: '안내', headline: '이미 지난 시간이에요. 날짜나 시작 시각을 고쳐 주세요' })]);

    expect((await t.db.query('select count(*)::int as n from plans')).rows[0]).toEqual(before);
    expect((await me.call('POST', '/api/rooms/r-3c/slot', { date: TODAY, start: '13:00', minutes: 60, note: 'x' })).status).toBe(400);
    expect((await me.call('GET', '/api/rooms/nope/day')).status).toBe(404);
  });

  it('[R4] 회의실이 "링크만"이면 목록 대신 그룹웨어 링크예요', async () => {
    const t = await setup();
    await t.ctx.ops.setModule('p_test_operator', 'rooms', 'link');
    const me = await t.loginAs(MOCK.staff);
    const body = (await me.call('GET', '/api/rooms/list')).body as RoomListResponse;
    expect(body).toMatchObject({ linkOnly: true, rooms: [] });
    expect(body.link).toBeTruthy();
    expect((await me.call('GET', '/api/rooms/r-3c/day')).status).toBe(409);
  });
});
