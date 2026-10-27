import type {
  AskResponse,
  Card,
  DemoInboxResponse,
  InvitedMeetingsResponse,
  MyReservationsResponse,
  NotificationsResponse,
  PeopleSearchResponse,
} from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../../testing';

// 회의 참석자 초대(10/26, ADR-17): 앱 안 알림 · 그룹웨어 캘린더(모의) · Slack DM(모의) · 캘린더 파일.
// 시계는 2026-10-26(월) 09:00이에요. 도윤(개발팀)이 내일 15:00 회의실을 잡고 서준·하은(개발팀)을 불러요.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const SEOJUN = 'mock|emp-006';
const HAEUN = 'mock|emp-007';

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  await t.modules.find((m) => m.kind === 'rooms')!.seed!();
  const doyun = await t.loginAs(MOCK.dev);
  // 예약 하나: 찾기 → 확인 시트 → [예약하기]
  const asked = (await doyun.call('POST', '/api/ask', { text: '내일 3시 6명 회의실', kind: 'rooms' })).body as AskResponse;
  const card = asked.cards.find((c) => c.actions.primary?.type === 'propose')!;
  const token = (card.actions.primary as { proposalToken: string }).proposalToken;
  const plan = (await doyun.call('POST', '/api/plans', { proposalToken: token })).body as { planId: string };
  const done = (await doyun.call('POST', `/api/plans/${plan.planId}/confirm`)).body as { status: string; card: Card };
  expect(done.status).toBe('done');
  const invite = done.card.actions.primary as { type: string; reservationId: string };
  expect(invite.type).toBe('invite');
  return { t, doyun, reservationId: invite.reservationId };
}

async function refsOf(me: Session, query: string): Promise<PeopleSearchResponse['items']> {
  const res = await me.call('POST', '/api/people/search', { query });
  expect(res.status).toBe(200);
  return (res.body as PeopleSearchResponse).items;
}

let n = 0;
const requestId = () => `req-${Date.now().toString(36)}-${(n += 1)}`;

async function inboxOf(t: TestApp, subject: string): Promise<DemoInboxResponse> {
  return (await (await t.loginAs(subject)).call('GET', '/api/demo/inbox')).body as DemoInboxResponse;
}

describe('직원 검색(ADR-17)', () => {
  it('이름·부서로 몇 명만 찾고, 나는 빼요. 검색어는 본문으로만 받아요', async () => {
    const { doyun } = await setup();
    const devs = await refsOf(doyun, '개발팀');
    expect(devs.map((p) => p.name)).toEqual(['가상 직원 서준', '가상 직원 하은', '가상 직원 주원']);
    expect(Object.keys(devs[0]!).sort()).toEqual(['department', 'floor', 'name', 'ref']);
    expect(await refsOf(doyun, '   ')).toEqual([]);
    expect(JSON.stringify(devs)).not.toContain('@');
    expect((await doyun.call('GET', '/api/people/search?query=개발')).status).toBe(404);
  });

  // QA-27(L-102): 초대가 꺼진 세 구성에서는 명단을 모을 길을 닫아요. 회의실 쓰기를 다시 켜면 열려요.
  it.each([
    ['회의실 쓰기 끔', 'on', false],
    ['링크만 + 쓰기 끔(1단계)', 'link', false],
    ['회의실 끔', 'off', false],
    ['링크만(쓰기 켬 그대로)', 'link', true],
  ] as const)('초대가 꺼진 구성(%s)에서는 직원 검색이 409예요', async (_name, rooms, roomsWrite) => {
    const { t, doyun } = await setup();
    await t.ctx.ops.setModule('ops-test', 'rooms', rooms);
    await t.ctx.ops.setFlag('ops-test', 'roomsWrite', roomsWrite);
    for (const query of ['가상', '팀', '개발', '']) {
      const res = await doyun.call('POST', '/api/people/search', { query });
      expect(res.status, query).toBe(409);
      expect(res.body).toEqual({ error: 'feature-off', message: '지금은 이 기능이 꺼져 있어요' });
    }
    await t.ctx.ops.setModule('ops-test', 'rooms', 'on');
    await t.ctx.ops.setFlag('ops-test', 'roomsWrite', true);
    expect((await refsOf(doyun, '서준')).length).toBe(1);
  });
});

describe('참석자 초대(ADR-17)', () => {
  it('고른 사람에게만 앱 알림 · 그룹웨어 캘린더 초대 · Slack DM이 가고, 결과 카드에 수가 나와요', async () => {
    const { t, doyun, reservationId } = await setup();
    const people = [...(await refsOf(doyun, '서준')), ...(await refsOf(doyun, '하은'))].map((p) => p.ref);
    const res = await doyun.call('POST', `/api/rooms/reservations/${reservationId}/invites`, { people, calendar: true, slack: true, requestId: requestId() });
    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({
      headline: '참석자에게 알렸어요',
      fields: [
        { name: '회의', value: expect.stringContaining('10월 27일(화) 15:00~16:00') },
        { name: '앱 알림', value: '2명에게 보냈어요' },
        { name: '그룹웨어 캘린더', value: '2명에게 초대를 보냈어요' },
        { name: 'Slack DM', value: '2명에게 보냈어요' },
      ],
    });

    const seojun = await t.loginAs(SEOJUN);
    const box = (await seojun.call('GET', '/api/notifications')).body as NotificationsResponse;
    expect(box.items).toEqual([expect.objectContaining({ title: '가상 직원 도윤님이 회의에 불렀어요 · 10월 27일(화) 15:00', page: 'rooms', read: false })]);
    const invited = (await seojun.call('GET', '/api/rooms/invites')).body as InvitedMeetingsResponse;
    expect(invited.items).toEqual([
      expect.objectContaining({
        reservationId,
        when: '10월 27일(화) 15:00~16:00',
        inviter: { name: '가상 직원 도윤', department: '개발팀' },
        response: 'pending',
      }),
    ]);

    const inbox = await inboxOf(t, SEOJUN);
    expect(inbox.calendar).toEqual([
      expect.objectContaining({ title: expect.stringMatching(/^회의 · /), when: '10월 27일(화) 15:00~16:00', cancelled: false }),
    ]);
    expect(inbox.messages).toEqual([
      expect.objectContaining({ text: expect.stringContaining('가상 직원 도윤님이 회의에 불렀어요 · 10월 27일(화) 15:00~16:00') }),
    ]);
    const event = (
      await t.db.query<{ organizer_email: string; attendee_emails: string[] }>('select organizer_email, attendee_emails from mock_calendar_events')
    ).rows;
    expect(event).toHaveLength(1);
    expect(event[0]!.organizer_email).toBe('doyun@corp.example');
    expect([...event[0]!.attendee_emails].sort()).toEqual(['haeun@corp.example', 'seojun@corp.example']);

    // 부르지 않은 사람(하늘)은 아무것도 받지 않아요.
    const haneul = await t.loginAs(MOCK.staff);
    expect(((await haneul.call('GET', '/api/rooms/invites')).body as InvitedMeetingsResponse).items).toEqual([]);
    expect(((await haneul.call('GET', '/api/notifications')).body as NotificationsResponse).items).toEqual([]);
    expect((await inboxOf(t, MOCK.staff)).messages).toEqual([]);

    // LLM은 부르지 않고, 감사 로그에는 이름·메일이 없어요.
    expect((await t.db.query('select * from ai_usage')).rows).toHaveLength(0);
    const audit = JSON.stringify((await t.db.query('select * from audit_log')).rows);
    expect(audit).toContain('invite.outbound');
    for (const needle of ['서준', '하은', 'seojun', 'corp.example']) expect(audit, needle).not.toContain(needle);
  });

  it('같은 요청이 두 번 와도 한 번만 보내고, 이미 부른 사람은 다시 부르지 않아요', async () => {
    const { t, doyun, reservationId } = await setup();
    const people = (await refsOf(doyun, '서준')).map((p) => p.ref);
    const body = { people, calendar: false, slack: true, requestId: requestId() };
    await doyun.call('POST', `/api/rooms/reservations/${reservationId}/invites`, body);
    await doyun.call('POST', `/api/rooms/reservations/${reservationId}/invites`, body);
    const again = await doyun.call('POST', `/api/rooms/reservations/${reservationId}/invites`, { ...body, requestId: requestId() });
    expect(again.body.card.fields).toContainEqual({ name: '앱 알림', value: '새로 부른 사람이 없어요(이미 부른 사람이에요)' });
    expect((await t.db.query('select * from room_invites')).rows).toHaveLength(1);
    expect((await t.db.query('select * from mock_messenger_messages')).rows).toHaveLength(1);
    expect((await t.db.query('select * from notifications')).rows).toHaveLength(1);
  });

  it('남의 예약에는 부를 수 없고, 지어낸 사람 값은 거부해요', async () => {
    const { t, doyun, reservationId } = await setup();
    const people = (await refsOf(doyun, '서준')).map((p) => p.ref);
    const haneul = await t.loginAs(MOCK.staff);
    expect(
      (await haneul.call('POST', `/api/rooms/reservations/${reservationId}/invites`, { people, calendar: false, slack: false, requestId: requestId() })).status,
    ).toBe(404);
    const forged = `${Buffer.from(HAEUN).toString('base64url')}.AAAAAAAAAAAAAAAAAAAAAA`;
    expect(
      (
        await doyun.call('POST', `/api/rooms/reservations/${reservationId}/invites`, {
          people: [forged],
          calendar: false,
          slack: false,
          requestId: requestId(),
        })
      ).status,
    ).toBe(400);
    expect((await t.db.query('select * from room_invites')).rows).toHaveLength(0);
  });

  it('초대받은 사람이 답하면 부른 사람에게 알림이 가고, 내 예약에 답이 보여요', async () => {
    const { t, doyun, reservationId } = await setup();
    const people = (await refsOf(doyun, '서준')).map((p) => p.ref);
    await doyun.call('POST', `/api/rooms/reservations/${reservationId}/invites`, { people, calendar: false, slack: false, requestId: requestId() });
    const seojun = await t.loginAs(SEOJUN);
    expect((await seojun.call('POST', `/api/rooms/invites/${reservationId}/response`, { response: 'accepted' })).status).toBe(200);
    const mine = (await doyun.call('GET', '/api/rooms/my-reservations')).body as MyReservationsResponse;
    expect(mine.items[0]).toMatchObject({ attendees: [{ name: '가상 직원 서준', department: '개발팀', response: 'accepted' }], invite: { type: 'invite' } });
    const box = (await doyun.call('GET', '/api/notifications')).body as NotificationsResponse;
    expect(box.items.map((i) => i.title)).toEqual(['가상 직원 서준님이 참석해요 · 10월 27일(화) 15:00']);
    // 부르지 않은 사람은 답할 수 없어요.
    expect((await (await t.loginAs(MOCK.staff)).call('POST', `/api/rooms/invites/${reservationId}/response`, { response: 'declined' })).status).toBe(404);
  });

  it('캘린더 파일은 예약한 사람과 초대받은 사람만 받고, 참석자 메일은 들어 있지 않아요', async () => {
    const { t, doyun, reservationId } = await setup();
    const people = (await refsOf(doyun, '서준')).map((p) => p.ref);
    await doyun.call('POST', `/api/rooms/reservations/${reservationId}/invites`, { people, calendar: false, slack: false, requestId: requestId() });
    const get = async (cookie: string) => t.app.inject({ method: 'GET', url: `/api/rooms/reservations/${reservationId}/ics`, headers: { cookie } });
    const own = await get(doyun.cookie);
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toContain('text/calendar');
    expect(own.body).toContain('BEGIN:VEVENT');
    expect(own.body).toContain('DTSTART:20261027T060000Z');
    expect(own.body).toContain('SUMMARY:회의 · ');
    expect(own.body).not.toContain('@corp.example');
    expect((await get((await t.loginAs(SEOJUN)).cookie)).statusCode).toBe(200);
    expect((await get((await t.loginAs(MOCK.staff)).cookie)).statusCode).toBe(404);
  });

  it('예약을 취소하면 참석자에게 앱 알림 · 캘린더 취소 · Slack DM이 가고 참석자 줄이 지워져요', async () => {
    const { t, doyun, reservationId } = await setup();
    const people = (await refsOf(doyun, '서준')).map((p) => p.ref);
    await doyun.call('POST', `/api/rooms/reservations/${reservationId}/invites`, { people, calendar: true, slack: true, requestId: requestId() });
    expect((await doyun.call('DELETE', `/api/rooms/reservations/${reservationId}`)).status).toBe(200);

    const seojun = await t.loginAs(SEOJUN);
    const titles = ((await seojun.call('GET', '/api/notifications')).body as NotificationsResponse).items.map((i) => i.title);
    expect(titles[0]).toBe('가상 직원 도윤님이 회의를 취소했어요 · 10월 27일(화) 15:00');
    const inbox = await inboxOf(t, SEOJUN);
    expect(inbox.calendar[0]).toMatchObject({ cancelled: true });
    expect(inbox.messages[0]!.text).toContain('가상 직원 도윤님이 회의를 취소했어요');
    expect((await t.db.query('select * from room_invites')).rows).toHaveLength(0);
    expect(((await seojun.call('GET', '/api/rooms/invites')).body as InvitedMeetingsResponse).items).toEqual([]);
  });
});
