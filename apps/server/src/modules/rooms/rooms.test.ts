import type {
  AskResponse,
  Card,
  CardAction,
  PlanConfirmResponse,
  PlanCreateResponse,
  RoomCandidate,
  RoomCardsResponse,
  RoomQuery,
} from '@one-line-desk/shared';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { Db } from '../../core/db';
import { pseudonymize } from '../../core/pseudonym';
import { createTestApp, MOCK } from '../../testing';
import { LEDGER_BOOKINGS } from './fixtures/ledger';
import { type LedgerBooking, MockRoomLedger } from './ledger-adapter';

// F2 회의실 찾고 확인 예약 — PRD "시험 가능한 완료 기준"과 M3 앱 확인 링크(ADR-03·06·14).
// 시계는 2026-10-26(월) 09:00이에요. "내일"은 10월 27일(화)이에요.

const TEXT = '내일 3시 6명 화면 있는 회의실';
// 원본 장부에만 있는 값. 어댑터 밖 어디에도 나오면 안 돼요(ADR-06).
const LEDGER_SECRETS = [...new Set(LEDGER_BOOKINGS.flatMap((b) => [b.organizer, b.title]))];

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;

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

/** 응답 본문을 모아 두었다가 남의 예약자 이름·회의 제목이 있는지 봐요. */
const seen: string[] = [];
async function call(me: Session, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const res = await me.call(method, url, payload);
  seen.push(JSON.stringify(res.body ?? null));
  return res;
}

async function ask(me: Session, text = TEXT): Promise<AskResponse> {
  const res = await call(me, 'POST', '/api/ask', { text });
  expect(res.status).toBe(200);
  return res.body as AskResponse;
}

const proposals = (cards: Card[]) => cards.filter((c) => c.actions.primary?.type === 'propose');
function tokenOf(card: Card | undefined): string {
  const action = card?.actions.primary;
  if (action?.type !== 'propose') throw new Error('제안 카드가 아니에요');
  return action.proposalToken;
}

async function createPlan(me: Session, token: string): Promise<PlanCreateResponse> {
  const res = await call(me, 'POST', '/api/plans', { proposalToken: token });
  expect(res.status).toBe(200);
  return res.body as PlanCreateResponse;
}

async function confirm(me: Session, planId: string): Promise<PlanConfirmResponse> {
  const res = await call(me, 'POST', `/api/plans/${planId}/confirm`);
  expect(res.status).toBe(200);
  return res.body as PlanConfirmResponse;
}

async function sheetFor(me: Session, token: string): Promise<string> {
  const created = await createPlan(me, token);
  if (created.status !== 'sheet') throw new Error('확인 시트가 아니에요');
  return created.planId;
}

async function appReservations(db: Db) {
  return (
    await db.query<{ id: string; room_id: string; plan_id: string; pseudonym_id: string }>(
      "select id::text, room_id, plan_id, pseudonym_id from room_reservations where source = 'app'",
    )
  ).rows;
}

async function dump(db: Db): Promise<Record<string, unknown[]>> {
  const { rows: tables } = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  const out: Record<string, unknown[]> = {};
  for (const { table_name } of tables) out[table_name] = (await db.query(`select * from ${table_name}`)).rows;
  return out;
}

async function asOperator(t: TestApp) {
  return t.loginAs(MOCK.operator);
}

describe('F2 회의실 찾기(읽기만)', () => {
  it('[F2-1·F2-2] 조건 칩과 후보 최대 3장을 "현황 HH:MM 기준"·맞은 조건과 함께 줘요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const res = await ask(me);
    expect(res.kind).toBe('rooms');
    const [cond, ...rest] = res.cards;
    expect(cond).toMatchObject({ variant: 'rooms-conditions', label: '안내', headline: '이 조건으로 찾았어요' });
    expect(cond!.fields).toEqual([
      { name: '날짜', value: '2026-10-27(화)' },
      { name: '시작', value: '15:00' },
      { name: '길이', value: '60분' },
      { name: '인원', value: '6명' },
      { name: '장비', value: '화면' },
      { name: '층', value: '상관없어요' },
    ]);
    expect(rest).toHaveLength(3);
    expect(rest.map((c) => c.headline)).toEqual(['회의실 5B', '회의실 3C', '대회의실 5C']);
    expect(rest[0]).toMatchObject({
      kind: 'rooms',
      label: '제안',
      fields: [
        { name: '방·층', value: '회의실 5B · 5층' },
        { name: '날짜·시간', value: '10월 27일(화) 15:00~16:00' },
        { name: '맞은 조건', value: '인원 6명 · 화면' },
      ],
      // 가짜 공급자라 조건은 규칙으로 뽑았어요. 모델이 뽑지 않았으니 "AI 정리"가 없어요.
      evidence: { text: '현황 09:00 기준', aiSummarized: false },
      actions: { primary: { type: 'propose', text: '이 방으로 예약' } },
      tail: '아직 예약되지 않았어요',
    });
  });

  it('[F2-1] 날짜·시작 시각·인원이 빠지면 무엇이 빠졌는지 되묻고, 길이는 운영 설정 기본값이에요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const res = await ask(me, '내일 회의실 잡아 주세요');
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]).toMatchObject({ variant: 'rooms-conditions', label: '안내', headline: '빠진 조건이 있어요: 시작 시각·인원' });
    expect(res.cards[0]!.fields).toContainEqual({ name: '시작', value: '알려 주세요' });
    expect(res.cards[0]!.fields).toContainEqual({ name: '길이', value: '60분' });

    t.ctx.ops.patchValues({ defaultMeetingMinutes: 30 });
    const shorter = await ask(me);
    expect(shorter.cards[0]!.fields).toContainEqual({ name: '길이', value: '30분' });
    expect(shorter.cards[1]!.fields).toContainEqual({ name: '날짜·시간', value: '10월 27일(화) 15:00~15:30' });
  });

  it('[F2-1] 지난 시간은 고쳐 달라고 해요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const res = await ask(me, '오늘 8시 4명 회의실');
    expect(res.cards).toMatchObject([{ variant: 'rooms-conditions', headline: '이미 지난 시간이에요. 날짜나 시작 시각을 고쳐 주세요' }]);
  });

  it('[F2-3] 처음부터 빈 방이 없으면 안내 카드 "그 시간엔 빈 방이 없어요" + 가까운 시간 대안 최대 2개예요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    // 20명 넘는 방은 대회의실 5C 하나이고, 내일 9~10시는 남의 예약이 있어요.
    const res = await ask(me, '내일 9시 20명 회의실');
    expect(res.cards.map((c) => [c.label, c.headline])).toEqual([
      ['안내', '이 조건으로 찾았어요'],
      ['안내', '그 시간엔 빈 방이 없어요'],
      ['제안', '대안: 대회의실 5C'],
      ['제안', '대안: 대회의실 5C'],
    ]);
    expect(res.cards[1]!.fields).toContainEqual({ name: '대안', value: '가까운 대안 2개' });
    expect(res.cards.slice(2).map((c) => c.fields.find((f) => f.name === '대안')?.value)).toEqual(['같은 방 60분 앞', '같은 방 60분 뒤']);
    expect(res.cards.slice(2).map((c) => c.fields.find((f) => f.name === '날짜·시간')?.value)).toEqual([
      '10월 27일(화) 08:00~09:00',
      '10월 27일(화) 10:00~11:00',
    ]);
  });

  it('[F2-3] 대안도 없으면 "대안 없음"과 조건 고치기(조건 칩)를 보여 줘요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const res = await ask(me, '내일 3시 30명 회의실');
    expect(res.cards.map((c) => c.headline)).toEqual(['이 조건으로 찾았어요', '그 시간엔 빈 방이 없어요']);
    expect(res.cards[1]!.fields).toContainEqual({ name: '대안', value: '대안 없음' });
    expect(res.cards[0]!.variant).toBe('rooms-conditions');
  });

  it('[F2-1] 조건 칩을 고쳐 다시 찾으면 새 후보를 주고, 아무것도 쓰지 않아요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const before = await dump(t.db);
    const res = await call(me, 'POST', '/api/rooms/search', { query: { date: '2026-10-27', start: '15:00', people: 4, floor: '3층' } });
    expect(res.status).toBe(200);
    const body = res.body as RoomCardsResponse;
    expect(body.checkedAt).toBe('2026-10-26T09:00:00+09:00');
    expect(body.cards[0]).toMatchObject({ headline: '고친 조건으로 다시 찾았어요', evidence: { aiSummarized: false } });
    expect(body.cards.slice(1).map((c) => c.headline)).toEqual(['회의실 3A', '회의실 3C']);
    expect(body.cards[1]!.fields).toContainEqual({ name: '맞은 조건', value: '인원 4명 · 3층' });
    expect(await dump(t.db)).toEqual(before);

    // 모르는 칸은 조용히 지우지 않고 거부해요(본문 스키마 additionalProperties: false).
    expect((await call(me, 'POST', '/api/rooms/search', { query: { people: 4, note: '회의 제목' } })).status).toBe(400);
    expect((await call(me, 'POST', '/api/rooms/search', { query: { equipment: ['빔'] } })).status).toBe(400);
  });

  it('[F2-4] /ask는 아무것도 저장하지 않아요(plan·예약 0건)', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    await ask(me);
    expect((await t.db.query('select * from plans')).rows).toHaveLength(0);
    expect(await appReservations(t.db)).toHaveLength(0);
  });
});

describe('F2 확인 예약(쓰기 경계, ADR-03·06)', () => {
  it('[F2-4·F2-7] [이 방으로 예약] → 확인 시트 → [예약하기] 한 번으로 예약되고 확정 카드에 다시 확인한 시각과 취소가 있어요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const token = tokenOf(proposals((await ask(me)).cards)[0]);

    const created = await createPlan(me, token);
    expect(created).toMatchObject({
      status: 'sheet',
      sheet: {
        title: '이 방으로 예약할까요?',
        lines: ['회의실 5B · 5층', '10월 27일(화) 15:00~16:00', "내 이름으로 예약돼요. 다른 사람에게는 '예약됨'으로만 보여요."],
        confirmLabel: '예약하기',
      },
    });
    expect(await appReservations(t.db)).toHaveLength(0);
    if (created.status !== 'sheet') throw new Error();

    t.advance(2 * 60 * 1000);
    const done = await confirm(me, created.planId);
    expect(done).toMatchObject({
      status: 'done',
      card: {
        label: '확정',
        headline: '예약했어요',
        fields: [
          { name: '방·층', value: '회의실 5B · 5층' },
          { name: '날짜·시간', value: '10월 27일(화) 15:00~16:00' },
          { name: '상태', value: '내 예약' },
        ],
        evidence: { text: '09:02에 다시 확인하고 예약했어요', aiSummarized: false },
        actions: {
          primary: { type: 'navigate', to: 'mine' },
          secondary: [{ type: 'fixed', text: '취소', method: 'DELETE', confirm: { confirmLabel: '취소하기' } }],
        },
        tail: '예약 기록이 남아요',
      },
    });
    const rows = await appReservations(t.db);
    expect(rows).toMatchObject([{ room_id: 'r-5b', plan_id: created.planId }]);
  });

  it('[F2 완료·ADR-03 시험] plan 없이, 남의 plan_id로, 만료된 plan으로 실행해도 예약 0건이에요', async () => {
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const dev = await t.loginAs(MOCK.dev);
    const token = tokenOf(proposals((await ask(staff)).cards)[0]);

    // plan 없이
    expect((await call(staff, 'POST', '/api/plans/00000000-0000-4000-8000-000000000000/confirm')).status).toBe(404);
    // 남의 제안 토큰·남의 plan_id
    expect((await call(dev, 'POST', '/api/plans', { proposalToken: token })).body).toMatchObject({
      error: 'not-owner',
      message: '다른 사람이 받은 링크라 열 수 없어요',
    });
    const planId = await sheetFor(staff, token);
    expect((await call(dev, 'POST', `/api/plans/${planId}/confirm`)).status).toBe(404);
    expect(await appReservations(t.db)).toHaveLength(0);

    // 만료된 plan: 실행하지 않고 같은 조건으로 다시 찾아요(F2-5)
    t.advance(11 * 60 * 1000);
    const expired = await confirm(staff, planId);
    expect(expired).toMatchObject({ status: 'expired', message: '시간이 지나 다시 찾았어요' });
    if (expired.status !== 'expired') throw new Error();
    expect(expired.cards[0]).toMatchObject({ variant: 'rooms-conditions', headline: '같은 조건으로 다시 찾았어요' });
    expect(proposals(expired.cards)).toHaveLength(3);
    expect(tokenOf(proposals(expired.cards)[0])).not.toBe(token);
    expect(await appReservations(t.db)).toHaveLength(0);

    // 만료된 제안 토큰으로 확인 시트를 열어도 다시 찾기예요
    expect(await createPlan(staff, token)).toMatchObject({ status: 'expired', message: '시간이 지나 다시 찾았어요' });
    expect(await appReservations(t.db)).toHaveLength(0);
  });

  it('[F2 완료·ADR-06 시험] DB 트리거도 확인된 plan 없는 앱 예약을 거부해요', async () => {
    const t = await setup();
    await expect(
      t.db.query(
        "insert into room_reservations (room_id, slot, pseudonym_id, plan_id) values ('r-3a', tstzrange('2026-10-27T15:00:00+09:00', '2026-10-27T16:00:00+09:00'), 'p_x', gen_random_uuid())",
      ),
    ).rejects.toThrow(/confirmed plan/);
    await t.db.query(
      "insert into plans (id, pseudonym_id, module, action, params, expires_at) values ('00000000-0000-4000-8000-000000000001', 'p_x', 'rooms', 'reserve', '{}', now() + interval '1 hour')",
    );
    // 확인 전(proposed) plan으로도 안 들어가요
    await expect(
      t.db.query(
        "insert into room_reservations (room_id, slot, pseudonym_id, plan_id) values ('r-3a', tstzrange('2026-10-27T15:00:00+09:00', '2026-10-27T16:00:00+09:00'), 'p_x', '00000000-0000-4000-8000-000000000001')",
      ),
    ).rejects.toThrow(/confirmed plan/);
    expect(await appReservations(t.db)).toHaveLength(0);
  });

  it('[F2-5 완료] 같은 plan_id를 두 번(연달아·동시에) 보내도 예약은 1건이에요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const planId = await sheetFor(me, tokenOf(proposals((await ask(me)).cards)[0]));
    const results = await Promise.all([confirm(me, planId), confirm(me, planId)]);
    const again = await confirm(me, planId);
    expect([...results, again].every((r) => r.status === 'done')).toBe(true);
    expect(again).toEqual(results[0]);
    expect(await appReservations(t.db)).toHaveLength(1);
  });

  it('[F2-6 완료·ADR-06 시험] 같은 방·구간을 두 사람이 동시에 확정하면 한 명만 성공하고, 다른 한 명은 막힘 카드와 대안 최대 2개를 받아요', async () => {
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const dev = await t.loginAs(MOCK.dev);
    const staffPlan = await sheetFor(staff, tokenOf(proposals((await ask(staff)).cards)[0]));
    const devPlan = await sheetFor(dev, tokenOf(proposals((await ask(dev)).cards)[0]));

    const [a, b] = await Promise.all([confirm(staff, staffPlan), confirm(dev, devPlan)]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.status === 'done')).toHaveLength(1);
    const blocked = outcomes.find((o) => o.status === 'blocked');
    expect(blocked).toMatchObject({
      status: 'blocked',
      card: {
        label: '막힘',
        headline: '확인하는 사이에 다른 예약이 들어왔어요',
        evidence: { text: '현황 09:00 기준', aiSummarized: false },
        tail: '아무것도 바뀌지 않았어요',
      },
    });
    if (blocked?.status !== 'blocked') throw new Error();
    expect(blocked.alternatives.length).toBeGreaterThan(0);
    expect(blocked.alternatives.length).toBeLessThanOrEqual(2);
    expect(blocked.alternatives.map((c) => c.actions.primary)).toMatchObject([
      { type: 'propose', text: '대안으로 예약' },
      { type: 'propose', text: '대안으로 예약' },
    ]);
    expect(blocked.alternatives.map((c) => c.fields.find((f) => f.name === '대안')?.value)).toEqual(['같은 방 60분 앞', '같은 방 60분 뒤']);
    expect(await appReservations(t.db)).toHaveLength(1);

    // 막힌 사람이 대안을 고르면 다시 확인 시트 한 번이에요
    const loser = a.status === 'blocked' ? staff : dev;
    const alt = await confirm(loser, await sheetFor(loser, tokenOf(blocked.alternatives[0])));
    expect(alt).toMatchObject({ status: 'done', card: { fields: expect.arrayContaining([{ name: '날짜·시간', value: '10월 27일(화) 14:00~15:00' }]) } });
    expect(await appReservations(t.db)).toHaveLength(2);
  });

  it('[F2-6] 대안도 없으면 막힘 카드에 "대안 없음"이에요', async () => {
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const dev = await t.loginAs(MOCK.dev);
    const text = '내일 3시 15명 회의실';
    const staffPlan = await sheetFor(staff, tokenOf(proposals((await ask(staff, text)).cards)[0]));
    const devPlan = await sheetFor(dev, tokenOf(proposals((await ask(dev, text)).cards)[0]));
    // 대회의실 5C의 내일 남은 시간을 장부에서 모두 막아요.
    await t.db.query(
      "insert into room_reservations (room_id, slot, pseudonym_id, source) values ('r-5c', tstzrange('2026-10-27T10:00:00+09:00', '2026-10-27T15:00:00+09:00'), 'ledger:x1', 'ledger'), ('r-5c', tstzrange('2026-10-27T16:00:00+09:00', '2026-10-27T22:00:00+09:00'), 'ledger:x2', 'ledger')",
    );
    await confirm(staff, staffPlan);
    const blocked = await confirm(dev, devPlan);
    expect(blocked).toMatchObject({ status: 'blocked', alternatives: [] });
    if (blocked.status !== 'blocked') throw new Error();
    expect(blocked.card.fields).toContainEqual({ name: '대안', value: '대안 없음' });
  });

  it('[F2 완료·ADR-03 시험] 모든 앱 예약 행의 plan_id는 같은 사람이 확인해 끝난 회의실 plan을 가리켜요(DB 검사)', async () => {
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const dev = await t.loginAs(MOCK.dev);
    for (const me of [staff, dev]) {
      const cards = proposals((await ask(me)).cards);
      await confirm(me, await sheetFor(me, tokenOf(me === staff ? cards[0] : cards[1])));
    }
    const { rows } = await t.db.query(
      `select x.id from room_reservations x left join plans p on p.id = x.plan_id
        where x.source = 'app' and (p.id is null or p.state <> 'done' or p.pseudonym_id <> x.pseudonym_id or p.module <> 'rooms' or p.action <> 'reserve')`,
    );
    expect(rows).toEqual([]);
    expect(await appReservations(t.db)).toHaveLength(2);
    expect((await t.db.query("select * from room_reservations where source = 'ledger' and plan_id is not null")).rows).toEqual([]);
  });
});

describe('F2 내 예약·취소', () => {
  it('[F2-7] 내 예약에 모이고, [취소]는 확인 시트를 거쳐 이력 표로 옮겨요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const other = await t.loginAs(MOCK.dev);
    await confirm(me, await sheetFor(me, tokenOf(proposals((await ask(me)).cards)[0])));

    const mine = (await call(me, 'GET', '/api/rooms/my-reservations')).body;
    expect(mine).toMatchObject({
      enabled: true,
      items: [
        {
          roomName: '회의실 5B',
          floor: '5층',
          start: '2026-10-27T15:00:00+09:00',
          end: '2026-10-27T16:00:00+09:00',
          when: '10월 27일(화) 15:00~16:00',
          cancel: { type: 'fixed', method: 'DELETE', confirm: { title: '예약을 취소할까요?', confirmLabel: '취소하기' } },
        },
      ],
    });
    expect((await call(other, 'GET', '/api/rooms/my-reservations')).body).toEqual({ enabled: true, items: [] });

    const cancel = mine.items[0].cancel as Extract<CardAction, { type: 'fixed' }>;
    // 남의 예약은 취소할 수 없어요
    expect((await call(other, 'DELETE', cancel.path)).status).toBe(404);

    t.advance(60 * 1000);
    const res = await call(me, 'DELETE', cancel.path);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'done',
      card: { label: '확정', headline: '예약을 취소했어요', fields: expect.arrayContaining([{ name: '상태', value: '취소됨' }]) },
    });
    // 연타해도 같은 결과만 돌려줘요
    expect((await call(me, 'DELETE', cancel.path)).body).toEqual(res.body);

    expect((await call(me, 'GET', '/api/rooms/my-reservations')).body).toEqual({ enabled: true, items: [] });
    expect(await appReservations(t.db)).toHaveLength(0);
    const history = (await t.db.query<{ room_id: string }>('select room_id from room_reservation_history')).rows;
    expect(history).toEqual([{ room_id: 'r-5b' }]);
    const audit = (
      await t.db.query<{ module: string; action: string; result: string }>("select module, action, result from audit_log where channel = 'write' order by id")
    ).rows;
    expect(audit).toEqual([
      { module: 'rooms', action: 'reserve', result: 'done' },
      { module: 'rooms', action: 'cancel', result: 'done' },
    ]);

    // 취소한 방은 다시 비어요
    expect(proposals((await ask(me)).cards)[0]!.headline).toBe('회의실 5B');
  });
});

describe('F2 남의 예약자 비노출(ADR-06)', () => {
  it('[F2-9 완료] 예약자 이름·회의 제목이 든 장부로 흐름 전체를 돌려도 응답·DB에 그 값이 0건이에요', async () => {
    seen.length = 0;
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const dev = await t.loginAs(MOCK.dev);
    expect(LEDGER_SECRETS.length).toBeGreaterThan(4);

    await ask(staff);
    await ask(staff, '내일 9시 20명 회의실');
    await ask(staff, '오늘 10시 8명 화상회의 회의실');
    await call(staff, 'POST', '/api/rooms/search', { query: { date: '2026-10-27', start: '14:00', people: 10 } });
    const token = tokenOf(proposals((await ask(staff)).cards)[0]);
    await call(staff, 'POST', '/api/rooms/recheck', { proposalToken: token });
    const p1 = await sheetFor(staff, token);
    const p2 = await sheetFor(dev, tokenOf(proposals((await ask(dev)).cards)[0]));
    await Promise.all([confirm(staff, p1), confirm(dev, p2)]);
    const mine = (await call(staff, 'GET', '/api/rooms/my-reservations')).body;
    if (mine.items[0]) await call(staff, 'DELETE', mine.items[0].cancel.path);
    seen.push(JSON.stringify(await t.ctx.services.rooms!.findFree({ date: '2026-10-27', start: '15:00', minutes: 60, people: 2, equipment: [] })));
    seen.push(JSON.stringify(await t.ctx.services.rooms!.findFree({ date: '2026-10-27', start: '09:00', minutes: 60, people: 20, equipment: [] })));

    const everything = [...seen, JSON.stringify(await dump(t.db))].join('\n');
    for (const secret of LEDGER_SECRETS) expect(everything).not.toContain(secret);
    // 남의 예약은 가명 값으로만 남아요
    expect(
      (await t.db.query<{ pseudonym_id: string }>("select pseudonym_id from room_reservations where source = 'ledger' order by id limit 1")).rows[0]!
        .pseudonym_id,
    ).toMatch(/^ledger:b-\d+$/);
  });

  it('[F2-9·ADR-06 시험] 장부 어댑터 출력에는 예약자 이름·회의 제목 칸이 없어요', () => {
    const ledger = new MockRoomLedger();
    expectTypeOf<keyof LedgerBooking>().toEqualTypeOf<'ref' | 'roomId' | 'start' | 'end'>();
    expectTypeOf<keyof RoomCandidate>().toEqualTypeOf<'roomId' | 'roomName' | 'floor' | 'start' | 'end' | 'matched'>();
    for (const b of ledger.bookings(Date.parse('2026-10-26T09:00:00+09:00'))) expect(Object.keys(b).sort()).toEqual(['end', 'ref', 'roomId', 'start']);
    expect(ledger.capabilities).toEqual({ name: 'mock-room-ledger', label: '회의실 장부(모의)', mock: true, freeTime: 'computed', write: true });
  });

  it('[ADR-05] 모의 장부는 capabilities로 알리고, 비어 있을 때만 한 번 넣어요', async () => {
    const t = await setup();
    await t.modules.find((m) => m.kind === 'rooms')!.seed!();
    expect((await t.db.query('select * from rooms')).rows).toHaveLength(10);
    expect((await t.db.query("select * from room_reservations where source = 'ledger'")).rows).toHaveLength(LEDGER_BOOKINGS.length);
    const pub = (await t.app.inject({ method: 'GET', url: '/api/config/public' })).json();
    expect(pub.demoData).toContain('회의실 장부(모의)');
  });
});

describe('F2 스위치(R4, ADR-12)', () => {
  it('[F2-10] "링크만"이면 "이 일은 그룹웨어에서 해요" 링크 카드이고, 내 예약 칸을 숨겨요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const token = tokenOf(proposals((await ask(me)).cards)[0]);
    expect((await (await asOperator(t)).call('PUT', '/api/ops/switch', { module: 'rooms', value: 'link' })).status).toBe(200);

    const res = await ask(me);
    expect(res.cards).toMatchObject([
      { kind: 'link', headline: '이 일은 그룹웨어에서 해요', actions: { primary: { type: 'link', href: 'https://groupware.example.com/resources' } } },
    ]);
    expect((await call(me, 'POST', '/api/rooms/search', { query: { date: '2026-10-27', start: '15:00', people: 4 } })).body.cards).toMatchObject([
      { kind: 'link', headline: '이 일은 그룹웨어에서 해요' },
    ]);
    expect((await call(me, 'POST', '/api/rooms/recheck', { proposalToken: token })).body.cards).toMatchObject([{ kind: 'link' }]);
    expect((await call(me, 'GET', '/api/rooms/my-reservations')).body).toEqual({ enabled: false, items: [] });
    expect((await call(me, 'POST', '/api/plans', { proposalToken: token })).status).toBe(409);
    expect(await appReservations(t.db)).toHaveLength(0);
  });

  it('[F2-10] "회의실 쓰기"를 끄면 후보 주 버튼이 [그룹웨어에서 예약하기]이고, 열린 plan도 막힘(기능 꺼짐)으로 끝나요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const planId = await sheetFor(me, tokenOf(proposals((await ask(me)).cards)[0]));
    await confirm(me, await sheetFor(me, tokenOf(proposals((await ask(me)).cards)[1])));
    const mine = (await call(me, 'GET', '/api/rooms/my-reservations')).body;
    expect((await (await asOperator(t)).call('PUT', '/api/ops/flag', { flag: 'roomsWrite', value: false })).status).toBe(200);

    const res = await ask(me);
    const candidates = res.cards.filter((c) => c.label === '제안');
    expect(candidates).toHaveLength(2);
    for (const c of candidates)
      expect(c.actions.primary).toEqual({ type: 'link', text: '그룹웨어에서 예약하기', href: 'https://groupware.example.com/resources' });
    expect(proposals(res.cards)).toHaveLength(0);

    expect(await confirm(me, planId)).toMatchObject({ status: 'blocked', card: { label: '막힘', headline: '기능이 방금 꺼졌어요' } });
    expect((await call(me, 'GET', '/api/rooms/my-reservations')).body).toEqual({ enabled: false, items: [] });
    expect((await call(me, 'DELETE', mine.items[0].cancel.path)).status).toBe(409);
    expect(await appReservations(t.db)).toHaveLength(1);
  });
});

describe('M3 앱 확인 링크 다시 확인(ADR-14)', () => {
  it('[M3] 남의 토큰은 403 "다른 사람이 받은 링크라 열 수 없어요"예요', async () => {
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const dev = await t.loginAs(MOCK.dev);
    const token = await mcpToken(t, MOCK.staff, 'r-3c');
    // 주인은 열 수 있어요
    expect((await call(staff, 'POST', '/api/rooms/recheck', { proposalToken: token })).status).toBe(200);
    const direct = t.ctx.services.rooms!.proposeReservation(
      { pseudonymId: pidOf(t, MOCK.staff) },
      {
        roomId: 'r-3c',
        start: '2026-10-27T15:00:00+09:00',
        end: '2026-10-27T16:00:00+09:00',
        query: { date: '2026-10-27', start: '15:00', minutes: 60, people: 6, equipment: ['화면'] },
      },
    );
    for (const other of [token, direct]) {
      const res = await call(dev, 'POST', '/api/rooms/recheck', { proposalToken: other });
      expect(res).toEqual({ status: 403, body: { error: 'not-owner', message: '다른 사람이 받은 링크라 열 수 없어요' } });
    }
    expect((await call(dev, 'POST', '/api/rooms/recheck', { proposalToken: 'abc.def' })).status).toBe(400);
  });

  it('[M3] 링크를 열기만 하면 DB 변화가 0이고, 그 방이 비면 그 방 카드 한 장(새 토큰, 조건 칩 그대로)이에요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const token = await mcpToken(t, MOCK.staff, 'r-3c');
    const before = await dump(t.db);
    t.advance(60 * 1000);
    const res = await call(me, 'POST', '/api/rooms/recheck', { proposalToken: token });
    expect(res.status).toBe(200);
    expect(await dump(t.db)).toEqual(before);
    const body = res.body as RoomCardsResponse;
    expect(body.checkedAt).toBe('2026-10-26T09:01:00+09:00');
    expect(body.cards.map((c) => [c.label, c.headline])).toEqual([
      ['안내', '이 조건으로 다시 확인했어요'],
      ['제안', '회의실 3C'],
    ]);
    expect(body.cards[0]!.fields).toContainEqual({ name: '인원', value: '6명' });
    expect(body.cards[1]).toMatchObject({ evidence: { text: '현황 09:01 기준' }, actions: { primary: { type: 'propose', text: '이 방으로 예약' } } });
    const fresh = tokenOf(body.cards[1]);
    expect(fresh).not.toBe(token);

    // 예약은 그 다음의 확인 시트 한 번에서만 돼요
    expect(await appReservations(t.db)).toHaveLength(0);
    expect(await confirm(me, await sheetFor(me, fresh))).toMatchObject({ status: 'done' });
  });

  it('[M3·R5] 그사이 방이 찼으면 "그 시간엔 빈 방이 없어요" 안내 카드와 대안 최대 2개예요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const token = await mcpToken(t, MOCK.staff, 'r-3c');
    await t.db.query(
      "insert into room_reservations (room_id, slot, pseudonym_id, source) values ('r-3c', tstzrange('2026-10-27T14:30:00+09:00', '2026-10-27T15:30:00+09:00'), 'ledger:x', 'ledger')",
    );
    const body = (await call(me, 'POST', '/api/rooms/recheck', { proposalToken: token })).body as RoomCardsResponse;
    expect(body.cards.map((c) => [c.label, c.headline])).toEqual([
      ['안내', '이 조건으로 다시 확인했어요'],
      ['안내', '그 시간엔 빈 방이 없어요'],
      ['제안', '대안: 회의실 3C'],
      ['제안', '대안: 회의실 3C'],
    ]);
    // 14:30~15:30이 찼으니 15:30부터(30분 뒤), 앞으로는 13:30부터(90분 앞)가 가장 가까워요.
    expect(body.cards.slice(2).map((c) => c.fields.find((f) => f.name === '대안')?.value)).toEqual(['같은 방 30분 뒤', '같은 방 90분 앞']);
  });

  it('[M3·F2-5] 만료된 링크는 같은 조건으로 다시 찾은 후보예요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const token = await mcpToken(t, MOCK.staff, 'r-3c');
    t.advance(11 * 60 * 1000);
    const before = await dump(t.db);
    const body = (await call(me, 'POST', '/api/rooms/recheck', { proposalToken: token })).body as RoomCardsResponse;
    expect(body.cards[0]).toMatchObject({ variant: 'rooms-conditions', headline: '시간이 지나 다시 찾았어요' });
    expect(proposals(body.cards).map((c) => c.headline)).toEqual(['회의실 5B', '회의실 3C', '대회의실 5C']);
    expect(await dump(t.db)).toEqual(before);
  });

  it('[M3] 회의실 쓰기가 꺼져 있으면 링크로 열어도 [그룹웨어에서 예약하기]예요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const token = await mcpToken(t, MOCK.staff, 'r-3c');
    await (await asOperator(t)).call('PUT', '/api/ops/flag', { flag: 'roomsWrite', value: false });
    const body = (await call(me, 'POST', '/api/rooms/recheck', { proposalToken: token })).body as RoomCardsResponse;
    expect(body.cards[1]!.actions.primary).toEqual({ type: 'link', text: '그룹웨어에서 예약하기', href: 'https://groupware.example.com/resources' });
  });
});

describe('MCP용 services.rooms(ADR-14)', () => {
  it('[F2-11·ADR-14 시험] findFree 출력에는 정해진 칸만 있고 예약자·회의 제목·방별 일정 칸이 없어요', async () => {
    const t = await setup();
    const rooms = t.ctx.services.rooms!;
    const result = await rooms.findFree({ date: '2026-10-27', start: '15:00', minutes: 60, people: 6, equipment: ['화면'] });
    expect(Object.keys(result).sort()).toEqual(['alternatives', 'candidates', 'checkedAt', 'mock']);
    expect(result).toMatchObject({ checkedAt: '2026-10-26T09:00:00+09:00', mock: true, alternatives: [] });
    expect(result.candidates).toHaveLength(3);
    for (const c of result.candidates) expect(Object.keys(c).sort()).toEqual(['end', 'floor', 'matched', 'roomId', 'roomName', 'start']);
    expect(result.candidates[0]).toEqual({
      roomId: 'r-5b',
      roomName: '회의실 5B',
      floor: '5층',
      start: '2026-10-27T15:00:00+09:00',
      end: '2026-10-27T16:00:00+09:00',
      matched: ['인원 6명', '화면'],
    });

    const none = await rooms.findFree({ date: '2026-10-27', start: '09:00', minutes: 60, people: 20, equipment: [] });
    expect(none.candidates).toEqual([]);
    expect(none.alternatives).toHaveLength(2);
    for (const c of none.alternatives) expect(Object.keys(c).sort()).toEqual(['end', 'floor', 'matched', 'roomId', 'roomName', 'start']);

    await expect(rooms.findFree({ date: '내일', start: '15:00', minutes: 60, people: 6, equipment: [] })).rejects.toMatchObject({ status: 400 });
    // 도구 입력에서 길이·장비는 선택 칸이에요. 비면 운영 설정 기본 길이예요.
    const loose = await rooms.findFree({ date: '2026-10-27', start: '15:00', people: 6 } as RoomQuery);
    expect(loose.candidates[0]).toMatchObject({ start: '2026-10-27T15:00:00+09:00', end: '2026-10-27T16:00:00+09:00' });
    expect((await rooms.findFree({ date: '2026-10-26', start: '08:00', minutes: 60, people: 2, equipment: [] })).candidates).toEqual([]);
  });

  it('[F2-11] proposeReservation 토큰도 확인 시트 한 번을 거쳐야 예약돼요(MCP 경로는 DB에 쓰지 않아요)', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const before = await dump(t.db);
    const token = await mcpToken(t, MOCK.staff, 'r-3c');
    expect(await dump(t.db)).toEqual(before);
    const created = await createPlan(me, token);
    expect(created).toMatchObject({ status: 'sheet', sheet: { lines: ['회의실 3C · 3층', '10월 27일(화) 15:00~16:00', expect.any(String)] } });
    expect(() =>
      t.ctx.services.rooms!.proposeReservation(
        { pseudonymId: 'p_x' },
        {
          roomId: 'r-3c',
          start: '2026-10-27T15:00:00+09:00',
          end: '2026-10-28T10:00:00+09:00',
          query: { date: '2026-10-27', start: '15:00', minutes: 60, people: 6, equipment: [] },
        },
      ),
    ).toThrow('예약을 제안할 수 없는 조건이에요');
  });
});

/** 가명 ID(로그인과 같은 계산). */
function pidOf(t: TestApp, idpSubject: string): string {
  return pseudonymize(t.ctx.config.pseudonymSecret, idpSubject);
}

/** MCP 에이전트처럼 findFree 결과의 방 하나로 앱 확인 링크 토큰을 만들어요. */
async function mcpToken(t: TestApp, idpSubject: string, roomId: string): Promise<string> {
  const query = { date: '2026-10-27', start: '15:00', minutes: 60, people: 6, equipment: ['화면' as const] };
  const found = await t.ctx.services.rooms!.findFree(query);
  const c = found.candidates.find((x) => x.roomId === roomId)!;
  return t.ctx.services.rooms!.proposeReservation({ pseudonymId: pidOf(t, idpSubject) }, { roomId: c.roomId, start: c.start, end: c.end, query });
}
