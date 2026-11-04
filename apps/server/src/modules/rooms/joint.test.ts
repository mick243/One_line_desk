import type {
  CardAction,
  JointRequestsResponse,
  NotificationsResponse,
  PeopleSearchResponse,
  PlanConfirmResponse,
  PlanCreateResponse,
  RoomChatResponse,
  TeamDelegatesResponse,
} from '@one-line-desk/shared';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../../testing';

// 여러 팀 회의 참석자 고르기(11/4 사용자 결정, ADR-28). 시계는 2026-10-26(월) 09:00이에요. "내일"은 10월 27일(화)이에요.
// 모의 명단: 개발팀 도윤(팀장)·서준·하은·주원, 디자인팀 지우(팀장)·유나.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;

const JIWOO = 'mock|emp-008';
const YUNA = 'mock|emp-012';
const SEOJUN = 'mock|emp-006';

const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 1000 });
  for (const kind of ['rooms', 'navi'] as const) await t.modules.find((m) => m.kind === kind)!.seed!();
  return t;
}

const chat = async (me: Session, text: string) => (await me.call('POST', '/api/rooms/chat', { text, requestId: randomUUID() })).body as RoomChatResponse;
const requests = async (me: Session) => ((await me.call('GET', '/api/rooms/joint/requests')).body as JointRequestsResponse).items;
const titles = async (me: Session) => ((await me.call('GET', '/api/notifications')).body as NotificationsResponse).items.map((n) => n.title);
const pick = (me: Session, id: string, people: string[]) => me.call('POST', `/api/rooms/joint/requests/${id}/pick`, { people, requestId: randomUUID() });

/** 채팅 카드의 첫 후보로 확인 시트를 열고 예약해요. */
async function reserveJoint(doyun: Session) {
  const out = await chat(doyun, '내일 3시 디자인팀이랑 회의실 잡아 줘');
  expect(out.changed).toBe(false);
  const action = out.cards.find((c) => c.actions.primary?.type === 'propose')!.actions.primary as Extract<CardAction, { type: 'propose' }>;
  const sheet = (await doyun.call('POST', '/api/plans', { proposalToken: action.proposalToken })).body as PlanCreateResponse;
  if (sheet.status !== 'sheet') throw new Error('확인 시트가 아니에요');
  const done = (await doyun.call('POST', `/api/plans/${sheet.planId}/confirm`)).body as PlanConfirmResponse;
  expect(done.status).toBe('done');
  return { out, lines: sheet.sheet.lines };
}

describe('여러 팀 회의(ADR-28)', () => {
  it('말한 팀까지 더해 짐작하고, 확인 시트에 고르기 요청이 적혀 있고, 예약하면 팀마다 팀장에게 요청이 가요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const { out, lines } = await reserveJoint(doyun);
    expect(out.reply).toContain('여러 팀 회의라 개발팀 4명 + 디자인팀 최대 2명 = 6명으로 찾았어요');
    expect(lines).toContain('예약하면 개발팀·디자인팀 팀장·회의 담당자에게 참석자를 골라 달라고 보내요');

    const rows = (
      await t.db.query<{ department: string; status: string; estimate: number }>('select department, status, estimate from room_joint_requests order by id')
    ).rows;
    expect(rows).toEqual([
      { department: '개발팀', status: 'open', estimate: 4 },
      { department: '디자인팀', status: 'open', estimate: 2 },
    ]);
    const jiwoo = await t.loginAs(JIWOO);
    expect(await titles(jiwoo)).toContainEqual(
      expect.stringContaining('가상 직원 도윤님이 디자인팀 회의 참석자를 골라 달라고 했어요 · 10월 27일(화) 15:00~16:00'),
    );
    // 팀장이 아닌 사람에게는 가지 않아요.
    expect(await titles(await t.loginAs(YUNA))).toEqual([]);
    expect(await requests(await t.loginAs(SEOJUN))).toEqual([]);
  });

  it('팀장이 자기 팀 사람만 골라요. 고른 사람에게 부른 사람 이름으로 초대가 가고, 다 고르면 예약한 사람에게 다시 센 인원이 가요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    await reserveJoint(doyun);
    const jiwoo = await t.loginAs(JIWOO);
    const [req] = await requests(jiwoo);
    expect(req).toMatchObject({ requester: '가상 직원 도윤(개발팀)', department: '디자인팀', estimate: 2 });
    expect(req!.members.map((m) => m.name).sort()).toEqual(['가상 직원 유나', '가상 직원 지우']);

    // 다른 팀 사람 ref(도윤이 받은 목록)는 못 골라요.
    const [devReq] = await requests(doyun);
    const seojunRef = devReq!.members.find((m) => m.name === '가상 직원 서준')!.ref;
    expect((await pick(jiwoo, req!.id, [seojunRef])).status).toBe(400);

    const yuna = req!.members.find((m) => m.name === '가상 직원 유나')!.ref;
    expect(await pick(jiwoo, req!.id, [yuna])).toMatchObject({ status: 200, body: { ok: true, invited: 1 } });
    expect(await titles(await t.loginAs(YUNA))).toContainEqual(expect.stringContaining('가상 직원 도윤님이 회의에 불렀어요'));
    // 먼저 고른 사람만 돼요.
    expect((await pick(jiwoo, req!.id, [yuna])).status).toBe(409);

    // 팀장이 아닌 사람은 못 골라요.
    const seojun = await t.loginAs(SEOJUN);
    expect((await pick(seojun, devReq!.id, [])).status).toBe(404);

    expect((await pick(doyun, devReq!.id, [seojunRef])).status).toBe(200);
    // 나(도윤) + 유나 + 서준 = 3명
    expect(await titles(doyun)).toContainEqual(expect.stringMatching(/참석자가 3명|3명으로 정해졌어요/));
    expect((await t.db.query('select 1 from room_invites')).rows).toHaveLength(2);
  });

  it('팀장은 마이 페이지에서 같은 팀 사람을 회의 담당자로 정하고, 담당자도 고를 수 있어요. 팀장이 아니면 403이에요', async () => {
    const t = await setup();
    const jiwoo = await t.loginAs(JIWOO);
    const search = async (me: Session, q: string) => ((await me.call('POST', '/api/people/search', { query: q })).body as PeopleSearchResponse).items[0]!.ref;
    expect((await jiwoo.call('POST', '/api/rooms/joint/delegates', { people: [await search(jiwoo, '서준')], requestId: randomUUID() })).status).toBe(400);
    const set = await jiwoo.call('POST', '/api/rooms/joint/delegates', { people: [await search(jiwoo, '유나')], requestId: randomUUID() });
    expect(set.body as TeamDelegatesResponse).toEqual({ isLead: true, department: '디자인팀', delegates: [{ position: 1, name: '가상 직원 유나' }] });
    const yuna = await t.loginAs(YUNA);
    expect((await yuna.call('GET', '/api/rooms/joint/delegates')).body).toMatchObject({ isLead: false, delegates: [] });
    expect((await yuna.call('POST', '/api/rooms/joint/delegates', { people: [], requestId: randomUUID() })).status).toBe(403);

    const doyun = await t.loginAs(MOCK.dev);
    await reserveJoint(doyun);
    // 팀장이 휴가인지 보지 않고 팀장·담당자 모두에게 가요. 담당자가 먼저 고르면 팀장에게는 닫혀요.
    const [forYuna] = await requests(yuna);
    expect(forYuna).toMatchObject({ department: '디자인팀' });
    expect((await pick(yuna, forYuna!.id, [forYuna!.members.find((m) => m.name === '가상 직원 지우')!.ref])).status).toBe(200);
    expect(await requests(jiwoo)).toEqual([]);
  });

  it('회의 1시간 전까지 아무도 안 고르면 짐작한 인원 그대로 두고 예약한 사람에게 알려요. 7일 지나면 지워요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    await reserveJoint(doyun);
    t.advance(29 * 60 * 60 * 1000 + 5 * 60 * 1000); // 10/27 14:05 → 마감(14:00) 지남
    await t.runRetention();
    expect((await t.db.query<{ status: string }>('select status from room_joint_requests')).rows.map((r) => r.status)).toEqual(['expired', 'expired']);
    const later = await t.loginAs(MOCK.dev);
    expect(await titles(later)).toContainEqual(expect.stringContaining('디자인팀에서 참석자를 고르지 않아 처음 짐작한 인원(2명) 그대로예요'));
    t.advance(8 * 24 * 60 * 60 * 1000);
    await t.runRetention();
    expect((await t.db.query('select 1 from room_joint_requests')).rows).toHaveLength(0);
  });

  it('팀 이름 없이 "합동 회의"면 인원을 묻고, 인원을 말하면 고르기 없이 그대로 잡아요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const ask = await chat(doyun, '내일 3시 합동 회의 회의실 잡아 줘');
    expect(ask.reply).toContain('여러 팀이 함께하는 회의라 어느 팀인지 알아야 해요');
    const done = await chat(doyun, '내일 3시 디자인팀이랑 8명 회의실 잡아 줘');
    expect(done.changed).toBe(true);
    expect((await t.db.query('select 1 from room_joint_requests')).rows).toHaveLength(0);
  });
});
