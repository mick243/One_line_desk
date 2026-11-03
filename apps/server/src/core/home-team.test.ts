import { randomUUID } from 'node:crypto';
import {
  type AskResponse,
  type AwayListResponse,
  type Card,
  DEFAULT_OPS_SETTINGS,
  type HomeAskResponse,
  type InquiryListResponse,
  LAUNCH_OPS_SETTINGS,
  type PeopleSearchResponse,
  type RoomListResponse,
} from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { LeaveAdapter, LeaveRecord, LeaveUse } from '../adapters/types';
import { createTestApp, MOCK } from '../testing';
import { AiGateway, FakeProvider, type LlmProvider, type ProviderResult, type StructuredRequest } from './ai/gateway';
import { type HomeInterpretation, interpretByRules } from './home';
import { mentionsOtherTeam } from './home-team';
import { pseudonymize } from './pseudonym';

// 홈 채팅 "같은 팀 일정"(11/3 사용자 결정). 시험 시계는 2026-10-26(월) 09:00이에요.
// 도윤(개발팀)이 물어요. 같은 개발팀: 서준(오늘 병가 하루)·하은(오늘 오후 반차)·주원(수요일 공가). 다른 팀: 하늘(재무팀, 오늘 하루)·수아(재무팀, 오늘 오전).
// 근태 기록은 시연 근태 어댑터에 승인된 날로 넣어요(인사팀 승인 = recordUses).

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const SEOJUN = 'mock|emp-006';
const HAEUN = 'mock|emp-007';
const SUA = 'mock|emp-010';
const JUWON = 'mock|emp-015';
const SICK_CANARY = 'SICKCANARY 독감 진단서';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

class RecordingProvider implements LlmProvider {
  readonly inputs: { purpose: string; input: string; grade: number }[] = [];
  constructor(
    readonly name: 'fake' | 'anthropic',
    private readonly answer?: HomeInterpretation,
  ) {}
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    this.inputs.push({ purpose: req.purpose, input: req.input, grade: req.grade });
    const out = req.purpose === 'home-ask' && this.answer ? this.answer : req.fallback();
    return { output: req.schema.parse(out), inputTokens: 1, outputTokens: 1 };
  }
}

/** 근태 기록에 사유 같은 다른 칸이 섞여 와도 응답에 옮기지 않는지 보려고, 칸을 덧붙여 돌려주는 근태 어댑터예요. */
function withCanary(inner: LeaveAdapter): LeaveAdapter {
  return {
    capabilities: inner.capabilities,
    recordUses: (p, uses) => inner.recordUses(p, uses),
    async leaveOf(p) {
      const r = await inner.leaveOf(p);
      if (!r) return r;
      return { ...r, note: SICK_CANARY, uses: r.uses.map((u) => ({ ...u, reason: SICK_CANARY, typeLabel: '병가' })) } as LeaveRecord;
    },
  };
}

async function setup(o: { contract?: boolean; provider?: LlmProvider; lines?: string[] } = {}) {
  const t = await createTestApp({
    ...(o.provider ? { provider: o.provider } : {}),
    ...(o.lines ? { logger: { level: 'debug', stream: { write: (line: string) => void o.lines!.push(line) } } } : {}),
  });
  opened.push(t);
  t.ctx.gateway = new AiGateway(o.provider ?? new FakeProvider(), o.contract ?? false, t.db);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 1000 });
  for (const kind of ['rooms', 'navi', 'pantry'] as const) await t.modules.find((m) => m.kind === kind)!.seed!();
  const leave = t.ctx.adapters.leave;
  // 근태 어댑터는 회사 메일로 찾아요.
  const approve = (idpSubject: string, id: string, uses: LeaveUse[]) => leave.recordUses({ idpSubject, email: `${id}@corp.example` }, uses);
  await approve(SEOJUN, 'seojun', [{ date: '2026-10-26', kind: 'full', type: 'sick' }]);
  await approve(HAEUN, 'haeun', [{ date: '2026-10-26', kind: 'half', half: 'pm' }]);
  await approve(JUWON, 'juwon', [{ date: '2026-10-28', kind: 'full', type: 'official' }]);
  await approve(MOCK.staff, 'haneul', [{ date: '2026-10-26', kind: 'full' }]);
  await approve(SUA, 'sua', [{ date: '2026-10-26', kind: 'half', half: 'am', type: 'annual' }]);
  t.ctx.adapters.leave = withCanary(leave);
  return t;
}

const home = async (me: Session, text: string) => {
  const res = await me.call('POST', '/api/home/ask', { text });
  expect(res.status, text).toBe(200);
  return res.body as HomeAskResponse;
};

/** 회의실을 잡고(확인 시트) 고른 사람을 불러요. 예약 번호·회의실 이름을 돌려줘요. */
async function reserve(me: Session, text: string, invite: string[] = []): Promise<{ reservationId: string; roomName: string }> {
  const asked = (await me.call('POST', '/api/ask', { text, kind: 'rooms' })).body as AskResponse;
  const card = asked.cards.find((c) => c.actions.primary?.type === 'propose')!;
  const plan = (await me.call('POST', '/api/plans', { proposalToken: (card.actions.primary as { proposalToken: string }).proposalToken })).body as {
    planId: string;
  };
  const done = (await me.call('POST', `/api/plans/${plan.planId}/confirm`)).body as { status: string; card: Card };
  expect(done.status).toBe('done');
  const r = done.card.actions.primary as { reservationId: string; roomName: string };
  if (invite.length) {
    const people = [];
    for (const q of invite) people.push(((await me.call('POST', '/api/people/search', { query: q })).body as PeopleSearchResponse).items[0]!.ref);
    const sent = await me.call('POST', `/api/rooms/reservations/${r.reservationId}/invites`, {
      people,
      calendar: false,
      slack: false,
      requestId: randomUUID(),
    });
    expect(sent.status).toBe(200);
  }
  return r;
}

const setAway = (me: Session, kind: string, start: string, end: string) => me.call('POST', '/api/navi/away', { kind, start, end, requestId: randomUUID() });

const accessRows = async (t: TestApp) =>
  (
    await t.db.query<{ pseudonym_id: string; action: string; subject_refs: string[]; client_ip: string | null; request_id: string | null }>(
      "select pseudonym_id, action, subject_refs, client_ip, request_id from access_log where action = 'team.schedule' order by id",
    )
  ).rows;

const ref = (t: TestApp, subject: string) => `person:${pseudonymize(t.ctx.config.pseudonymSecret, subject)}`;

async function rowCounts(t: TestApp): Promise<Record<string, number>> {
  const { rows: tables } = await t.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'");
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    if (['audit_log', 'ai_usage', 'access_log'].includes(table_name)) continue;
    const { rows } = await t.db.query<{ n: number }>(`select count(*)::int as n from ${table_name}`);
    out[table_name] = rows[0]!.n;
  }
  return out;
}

/** 응답 어디에도 휴가 종류·사유·남은 연차가 없어요. */
const TYPE_LEAK = /annual|sick|official|연차|병가|공가|SICKCANARY|독감|진단|remaining|balance|남은|typeLabel|reason|note/;

describe('[팀 일정] 규칙 해석기', () => {
  it.each([
    ['오늘 개발 팀 내에 휴가인사람', 'team-schedule', 'today'],
    ['우리 팀 누가 쉬어?', 'team-schedule', 'recent'],
    ['이번 주 팀 부재', 'team-schedule', 'this-week'],
    ['내일 우리 팀 연차 쓰는 사람 있어?', 'team-schedule', 'tomorrow'],
    ['오늘 팀원 중 안 나온 사람', 'team-schedule', 'today'],
    ['우리 팀 오늘 누가 없어?', 'team-schedule', 'today'],
    ['다음 주 우리 부서 휴가자', 'team-schedule', 'next-week'],
    ['팀장님 오늘 회의 있어?', 'team-schedule', 'today'],
    ['도윤님 내일 휴가야?', 'team-schedule', 'tomorrow'],
    ['과장님 어디 계셔?', 'team-schedule', 'recent'],
    ['팀 회의 일정 뭐 있어?', 'team-schedule', 'recent'],
    ['나 오후에 외근이야', 'move', 'recent'],
    ['내일 재택 할게요', 'move', 'tomorrow'],
    ['우리 팀 휴가 신청해 줘', 'move', 'recent'],
    ['내 휴가 어떻게 됐어?', 'mine', 'recent'],
    ['이번 주 내 일정 뭐 있어?', 'mine', 'this-week'],
  ] as const)('%s → %s', (text, intent, period) => {
    expect(interpretByRules(text)).toMatchObject({ intent, period });
  });

  it('호칭 없는 이름도 디렉터리 이름 낱말로 대조해요(서버 메모리만)', () => {
    expect(interpretByRules('서준 오늘 자리에 있어?', ['서준', '하은'])).toMatchObject({ intent: 'team-schedule', period: 'today' });
    expect(interpretByRules('서준 오늘 자리에 있어?')).not.toMatchObject({ intent: 'team-schedule' });
    expect(interpretByRules('나 오후에 외근이야')).toMatchObject({ moveTo: 'away' });
  });

  it('다른 팀 이름은 디렉터리 부서 이름과 대조해요(띄어쓰기 무시, 긴 이름 먼저)', () => {
    const departments = ['개발팀', '재무팀', '앱개발팀', '인사팀'];
    expect(mentionsOtherTeam('오늘 개발 팀 내에 휴가인사람', '개발팀', departments)).toBe(false);
    expect(mentionsOtherTeam('오늘 재무 팀 휴가', '개발팀', departments)).toBe(true);
    expect(mentionsOtherTeam('우리 팀 누가 쉬어?', '개발팀', departments)).toBe(false);
    expect(mentionsOtherTeam('앱개발팀 부재', '앱개발팀', departments)).toBe(false);
    expect(mentionsOtherTeam('앱개발팀 부재', '개발팀', departments)).toBe(true);
    expect(mentionsOtherTeam('개발팀이랑 재무팀 휴가', '개발팀', departments)).toBe(true);
  });
});

describe('[팀 일정] 홈 채팅 같은 팀 일정(11/3)', () => {
  it('[팀 일정 시험] 휴가는 같은 부서 사람만 이름·하루/오전/오후로 보이고, 다른 부서 사람·본인은 0명이에요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const res = await home(doyun, '오늘 개발 팀 내에 휴가인사람');
    expect(res).toMatchObject({
      intent: 'team-schedule',
      period: 'today',
      by: 'rule',
      headline: '오늘 개발팀 일정: 가상 직원 서준 하루 부재 / 가상 직원 하은 오후 부재',
      items: [],
      links: [],
      cards: [],
    });
    expect(res.team).toEqual({
      shown: true,
      team: '개발팀',
      person: null,
      leaveConnected: true,
      entries: [
        { name: '가상 직원 서준', date: '2026-10-26', what: 'leave', part: 'full' },
        { name: '가상 직원 하은', date: '2026-10-26', what: 'leave', part: 'pm' },
      ],
    });
    const body = JSON.stringify(res);
    for (const other of ['하늘', '수아', '재무팀', '도윤']) expect(body).not.toContain(other);
    expect(body).not.toMatch(/"type":"(fixed|propose|post|reask)"|proposalToken/);

    // 재무팀 하늘이 물으면 재무팀(수아)만 보여요.
    const haneul = await home(await t.loginAs(MOCK.staff), '우리 팀 누가 쉬어?');
    expect(haneul.team!.entries).toEqual([{ name: '가상 직원 수아', date: '2026-10-26', what: 'leave', part: 'am' }]);
    expect(JSON.stringify(haneul)).not.toMatch(/서준|하은|주원|개발팀/);
  });

  it('[팀 일정 시험] 회의는 같은 팀 사람이 예약했거나 "참석할게요"로 답한 것의 시간·회의실만이고, 참석자·부른 사람은 0이에요', async () => {
    const t = await setup();
    const seojun = await t.loginAs(SEOJUN);
    const haeun = await t.loginAs(HAEUN);
    const haneul = await t.loginAs(MOCK.staff);
    // 서준이 오늘 15시 회의실을 잡고 하은·주원·하늘(재무팀)을 불러요. 하은·하늘은 참석, 주원은 답하지 않아요.
    const r = await reserve(seojun, '오늘 3시 6명 회의실', ['하은', '주원', '하늘']);
    for (const s of [haeun, haneul])
      expect((await s.call('POST', `/api/rooms/invites/${r.reservationId}/response`, { response: 'accepted' })).status).toBe(200);

    const doyun = await t.loginAs(MOCK.dev);
    const res = await home(doyun, '팀장님 오늘 회의 있어?');
    expect(res.intent).toBe('team-schedule');
    const meetings = res.team!.entries.filter((e) => e.what === 'meeting');
    expect(meetings).toEqual([
      { name: '가상 직원 서준', date: '2026-10-26', what: 'meeting', start: '15:00', end: '16:00', room: r.roomName },
      { name: '가상 직원 하은', date: '2026-10-26', what: 'meeting', start: '15:00', end: '16:00', room: r.roomName },
    ]);
    for (const m of meetings) expect(Object.keys(m).sort()).toEqual(['date', 'end', 'name', 'room', 'start', 'what']);
    expect(res.headline).toContain(`가상 직원 서준 하루 부재 · 15:00–16:00 회의(${r.roomName})`);
    // 다른 팀 참석자(하늘)·답 안 한 주원·부른 사람 표시·참석자 목록은 어디에도 없어요.
    const body = JSON.stringify(res);
    expect(body).not.toMatch(/하늘|재무팀|attendee|inviter|불렀|참석자|response/);
    expect(res.team!.entries.some((e) => e.name.includes('주원') && e.what === 'meeting')).toBe(false);

    // 재무팀 수아에게는 개발팀 회의가 0건이고, 하늘(참석)만 보여요.
    const sua = await home(await t.loginAs(SUA), '우리 팀 오늘 일정');
    expect(sua.team!.entries.filter((e) => e.what === 'meeting').map((e) => e.name)).toEqual(['가상 직원 하늘']);
    expect(JSON.stringify(sua)).not.toMatch(/서준|하은/);

    // 회의실 현황 화면(남의 예약)은 같은 팀이어도 그대로 "예약됨"이고 이름이 없어요(ADR-06).
    const list = (await doyun.call('GET', '/api/rooms/list')).body as RoomListResponse;
    const roomId = list.rooms.find((x) => x.name === r.roomName)!.id;
    const day = await doyun.call('GET', `/api/rooms/${roomId}/day`);
    expect(day.status).toBe(200);
    expect(JSON.stringify(day.body)).not.toMatch(/서준|하은|가상 직원/);
    expect(JSON.stringify(list)).not.toMatch(/서준|하은|가상 직원/);
  });

  it('[팀 일정 시험] 같은 팀 한 사람을 물으면 그 사람만, 다른 팀 사람을 물으면 아무것도 읽지 않고 거절해요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const one = await home(doyun, '서준님 오늘 자리에 있어?');
    expect(one).toMatchObject({ headline: '오늘 가상 직원 서준님 일정: 하루 부재', team: { person: '가상 직원 서준' } });
    expect(one.team!.entries.map((e) => e.name)).toEqual(['가상 직원 서준']);
    // 호칭 없이 이름만 써도 같아요.
    expect((await home(doyun, '하은 오늘 자리에 있어?')).team!.entries).toEqual([{ name: '가상 직원 하은', date: '2026-10-26', what: 'leave', part: 'pm' }]);
    expect((await home(doyun, '주원님 오늘 일정')).headline).toBe('오늘 가상 직원 주원님에게 등록된 일정이 없어요');

    const before = (await accessRows(t)).length;
    const other = await home(doyun, '하늘님 오늘 휴가야?');
    expect(other).toMatchObject({
      intent: 'team-schedule',
      headline: '다른 팀 사람의 일정은 볼 수 없어요. 그룹웨어 팀 일정에서 확인해 주세요',
      team: { shown: false, entries: [] },
    });
    expect((await accessRows(t)).length).toBe(before);
  });

  it('[팀 일정 시험] 다른 팀을 물으면 거절 문구만이고, 근태 기록을 읽지 않아 접속기록도 없어요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    for (const text of ['오늘 재무팀 휴가인 사람', '재무 팀 누가 쉬어?', '개발팀이랑 인사팀 부재']) {
      const res = await home(doyun, text);
      expect(res, text).toMatchObject({
        intent: 'team-schedule',
        headline: '다른 팀의 일정은 볼 수 없어요. 그룹웨어 팀 일정에서 확인해 주세요',
        team: { shown: false, team: '개발팀', entries: [] },
      });
      expect(JSON.stringify(res)).not.toMatch(/하늘|수아|서준|하은/);
    }
    expect(await accessRows(t)).toEqual([]);
    const audit = (await t.ctx.audit.recent(10)).filter((a) => a.module === 'home');
    expect(audit.map((a) => a.result)).toEqual(['team-other', 'team-other', 'team-other']);
  });

  it('[팀 일정 시험] 응답 전체에 휴가 종류·사유·남은 연차가 0건이에요(근태 기록에 섞인 병가 사유 카나리 포함)', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    for (const text of ['오늘 우리 팀 누가 쉬어?', '이번 주 팀 부재', '오늘 우리 팀 병가 누구야?']) {
      const res = await home(doyun, text);
      expect(res.team?.shown, text).toBe(true);
      expect(JSON.stringify(res), text).not.toMatch(TYPE_LEAK);
      for (const e of res.team!.entries.filter((x) => x.what === 'leave')) expect(Object.keys(e).sort()).toEqual(['date', 'name', 'part', 'what']);
    }
    const week = await home(doyun, '이번 주 팀 부재');
    expect(week.headline).toBe('이번 주 개발팀 일정 3건이에요');
    expect(week.team!.entries).toEqual([
      { name: '가상 직원 서준', date: '2026-10-26', what: 'leave', part: 'full' },
      { name: '가상 직원 하은', date: '2026-10-26', what: 'leave', part: 'pm' },
      { name: '가상 직원 주원', date: '2026-10-28', what: 'leave', part: 'full' },
    ]);
  });

  it('[팀 일정 시험] 결재 중(승인 전) 휴가는 안 나오고, 인사팀이 승인해 근태 기록에 들어가면 나와요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const haeun = await t.loginAs(HAEUN);
    const jihu = await t.loginAs(MOCK.hr);
    const sent = await haeun.call('POST', '/api/navi/inquiries', {
      rowId: 'HR-02',
      question: '휴가 신청',
      reason: '가족 행사',
      requestId: randomUUID(),
      leave: { days: [{ date: '2026-10-27', kind: 'full' }] },
    });
    expect(sent.status).toBe(200);
    const pending = await home(doyun, '내일 우리 팀 부재');
    expect(pending).toMatchObject({ headline: '내일 개발팀에 등록된 일정이 없어요', team: { shown: true, entries: [] } });

    const [item] = ((await jihu.call('GET', '/api/navi/inquiries/inbox')).body as InquiryListResponse).items;
    expect((await jihu.call('POST', `/api/navi/inquiries/${item!.id}/decision`, { decision: 'approved' })).status).toBe(200);
    const approved = await home(doyun, '내일 우리 팀 부재');
    expect(approved.headline).toBe('내일 개발팀 일정: 가상 직원 하은 하루 부재');
    expect(JSON.stringify(approved)).not.toContain('가족 행사');
  });

  it('[팀 일정 시험] 반차는 근태 기록의 오전·오후로, 오전·오후가 없으면 반나절로, 둘 다면 하루로 보여요', async () => {
    const t = await setup();
    const leave = t.ctx.adapters.leave;
    await leave.recordUses({ idpSubject: SEOJUN, email: 'seojun@corp.example' }, [{ date: '2026-10-29', kind: 'half', half: 'am' }]);
    await leave.recordUses({ idpSubject: HAEUN, email: 'haeun@corp.example' }, [{ date: '2026-10-29', kind: 'half' }]);
    await leave.recordUses({ idpSubject: JUWON, email: 'juwon@corp.example' }, [
      { date: '2026-10-29', kind: 'half', half: 'am' },
      { date: '2026-10-29', kind: 'half', half: 'pm' },
    ]);
    t.advance(3 * DAY); // 목요일
    const res = await home(await t.loginAs(MOCK.dev), '오늘 우리 팀 부재');
    expect(res.headline).toBe('오늘 개발팀 일정: 가상 직원 서준 오전 부재 / 가상 직원 주원 하루 부재 / 가상 직원 하은 반나절 부재');
  });

  it('[팀 일정·ADR-20 시험] 접속기록 team.schedule 한 줄에 보여 준 사람 가명 ID만 남고, 이름·날짜·종류는 없어요. 0명이어도 조회 한 줄이에요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    await home(doyun, '오늘 우리 팀 누가 쉬어?');
    const rows = await accessRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pseudonym_id: pseudonymize(t.ctx.config.pseudonymSecret, MOCK.dev), action: 'team.schedule' });
    expect([...rows[0]!.subject_refs].sort()).toEqual([ref(t, SEOJUN), ref(t, HAEUN)].sort());
    expect(rows[0]!.request_id).toEqual(expect.any(String));
    const raw = JSON.stringify(rows);
    expect(raw).not.toMatch(/가상|서준|하은|2026-10-26|10월|full|pm|sick|병가|개발팀|SICKCANARY/);
    expect(raw).not.toContain(ref(t, MOCK.staff));
    expect(raw).not.toContain(ref(t, SUA));

    await home(doyun, '다음 주 우리 팀 부재');
    const after = await accessRows(t);
    expect(after).toHaveLength(2);
    expect(after[1]!.subject_refs).toEqual([]);

    // 감사 로그에는 결과 코드만 있어요(부서·이름·인원 수 없음).
    const audit = (await t.ctx.audit.recent(10)).filter((a) => a.module === 'home');
    expect(audit.map((a) => a.result)).toEqual(['team-schedule', 'team-schedule']);
    expect(JSON.stringify(audit)).not.toMatch(/개발팀|서준|하은|가상|2명|2026-10-26/);
  });

  it('[팀 일정·ADR-10 시험] 게이트웨이 입력은 질문 글뿐이고(이름·일정 0), 실제 모델이 해석했을 때만 "AI 정리"예요', async () => {
    const provider = new RecordingProvider('anthropic', { intent: 'team-schedule', period: 'today', kinds: [], moveTo: null });
    const t = await setup({ contract: true, provider });
    const doyun = await t.loginAs(MOCK.dev);
    const text = '그 사람들 오늘 다 나왔나';
    const res = await home(doyun, text);
    expect(res).toMatchObject({ intent: 'team-schedule', by: 'ai', headline: '오늘 개발팀 일정: 가상 직원 서준 하루 부재 / 가상 직원 하은 오후 부재' });
    expect(provider.inputs).toEqual([{ purpose: 'home-ask', input: text, grade: 1 }]);
    expect(JSON.stringify(provider.inputs)).not.toMatch(/서준|하은|개발팀|2026-10-26|하루|오후|가상/);

    const fake = new RecordingProvider('fake');
    const t2 = await setup({ contract: true, provider: fake });
    const ruled = await home(await t2.loginAs(MOCK.dev), '오늘 우리 팀 누가 쉬어?');
    expect(ruled).toMatchObject({ intent: 'team-schedule', by: 'rule' });
    expect(fake.inputs).toEqual([{ purpose: 'home-ask', input: '오늘 우리 팀 누가 쉬어?', grade: 1 }]);
  });

  it('[팀 일정·ADR-10 시험] 저장 0(기록 표 줄 수 그대로)이고, 질문 카나리는 DB·로그·감사·응답에 0건이에요', async () => {
    const lines: string[] = [];
    const t = await setup({ lines });
    const doyun = await t.loginAs(MOCK.dev);
    const before = await rowCounts(t);
    const canary = '카나리팀QZ7';
    for (const text of [
      `오늘 우리 팀 누가 쉬어 ${canary}`,
      `이번 주 팀 부재 ${canary}`,
      `재무팀 휴가 ${canary}`,
      `팀장님 오늘 회의 있어 ${canary}`,
      `나 오후에 외근이야 ${canary}`,
    ]) {
      const res = await doyun.call('POST', '/api/home/ask', { text });
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(canary);
    }
    expect(await rowCounts(t)).toEqual(before);
    const { rows: tables } = await t.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'");
    for (const { table_name } of tables) {
      const { rows } = await t.db.query(`select * from ${table_name}`);
      expect(JSON.stringify(rows), table_name).not.toContain(canary);
    }
    expect(lines.join('\n')).not.toContain(canary);
    expect(lines.join('\n')).not.toMatch(/가상 직원 서준|SICKCANARY/);
  });

  it('[팀 일정 시험] teamSchedule을 끄면 거절 문구이고 아무것도 읽지 않아요. 자리비움 알리기도 닫혀요. 출시 기본값은 끔, 개발·시연 기본값은 켬이에요', async () => {
    expect(LAUNCH_OPS_SETTINGS.teamSchedule).toBe(false);
    expect(DEFAULT_OPS_SETTINGS.teamSchedule).toBe(true);
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const op = await t.loginAs(MOCK.operator);
    expect((await t.app.inject({ method: 'GET', url: '/api/config/public' })).json()).toMatchObject({ teamSchedule: true });
    expect((await op.call('PUT', '/api/ops/flag', { flag: 'teamSchedule', value: false })).status).toBe(200);
    expect((await doyun.call('PUT', '/api/ops/flag', { flag: 'teamSchedule', value: true })).status).toBe(403);
    for (const text of ['오늘 우리 팀 누가 쉬어?', '팀장님 오늘 회의 있어?']) {
      const res = await home(doyun, text);
      expect(res, text).toMatchObject({
        intent: 'team-schedule',
        headline: '이 회사에서는 팀 일정을 여기서 보여 주지 않아요. 그룹웨어 팀 일정에서 확인해 주세요',
        team: { shown: false, entries: [] },
      });
      expect(JSON.stringify(res)).not.toMatch(/서준|하은/);
    }
    expect(await accessRows(t)).toEqual([]);
    expect((await t.ctx.audit.recent(5)).map((a) => a.action ?? a.result)).toContain('teamSchedule.set');
    expect((await doyun.call('GET', '/api/navi/away')).body).toEqual({ enabled: false, items: [] });
    expect((await setAway(doyun, 'outside', '2026-10-26T14:00:00+09:00', '2026-10-26T18:00:00+09:00')).status).toBe(409);
    // 홈의 "나 오후에 외근이야"도 마이 페이지로 옮기지 않아요(닫힌 기능).
    expect((await home(doyun, '나 오후에 외근이야')).intent).toBe('unknown');
  });

  it('[팀 일정 시험] 근태 기록이 연결되지 않았으면 휴가만 빠지고 알려요', async () => {
    const t = await setup();
    t.ctx.adapters.leave = { ...t.ctx.adapters.leave, leaveOf: async () => null };
    const res = await home(await t.loginAs(MOCK.dev), '오늘 우리 팀 누가 쉬어?');
    expect(res).toMatchObject({ headline: '오늘 개발팀에 등록된 일정이 없어요', team: { shown: true, leaveConnected: false, entries: [] } });
  });
});

describe('[팀 일정] 자리비움(11/3)', () => {
  it('[팀 일정 시험] 자리비움은 본인만 정하고 지우고, 같은 팀에게 종류·시간만 보여요. 다른 팀은 0이에요', async () => {
    const t = await setup();
    const seojun = await t.loginAs(SEOJUN);
    const set = await setAway(seojun, 'outside', '2026-10-26T14:00:00+09:00', '2026-10-26T18:00:00+09:00');
    expect(set.status).toBe(200);
    const mine = set.body as AwayListResponse;
    expect(mine).toEqual({
      enabled: true,
      items: [{ id: expect.any(String), kind: 'outside', start: '2026-10-26T05:00:00.000Z', end: '2026-10-26T09:00:00.000Z' }],
    });
    // 이틀 걸친 출장은 날마다 잘라 보여요(하루를 다 덮으면 종일).
    expect((await setAway(seojun, 'trip', '2026-10-27T00:00:00+09:00', '2026-10-28T12:00:00+09:00')).status).toBe(200);

    const doyun = await t.loginAs(MOCK.dev);
    const today = await home(doyun, '서준님 오늘 어디 계셔?');
    expect(today.headline).toBe('오늘 가상 직원 서준님 일정: 하루 부재 · 14:00–18:00 외근');
    const week = await home(doyun, '이번 주 우리 팀 일정');
    expect(week.team!.entries.filter((e) => e.what === 'away')).toEqual([
      { name: '가상 직원 서준', date: '2026-10-26', what: 'away', start: '14:00', end: '18:00', allDay: false, away: 'outside' },
      { name: '가상 직원 서준', date: '2026-10-27', what: 'away', start: '00:00', end: '24:00', allDay: true, away: 'trip' },
      { name: '가상 직원 서준', date: '2026-10-28', what: 'away', start: '00:00', end: '12:00', allDay: false, away: 'trip' },
    ]);
    expect(JSON.stringify(await home(await t.loginAs(MOCK.staff), '이번 주 우리 팀 일정'))).not.toContain('서준');

    // 남(도윤)은 서준 줄을 지우지 못하고, 서준은 지워요.
    const id = mine.items[0]!.id;
    expect((await doyun.call('POST', '/api/navi/away/clear', { id, requestId: randomUUID() })).status).toBe(404);
    expect(((await doyun.call('GET', '/api/navi/away')).body as AwayListResponse).items).toEqual([]);
    const cleared = await seojun.call('POST', '/api/navi/away/clear', { id, requestId: randomUUID() });
    expect(cleared.status).toBe(200);
    expect((cleared.body as AwayListResponse).items.map((a) => a.kind)).toEqual(['trip']);
    // 감사는 모듈·동작·결과만이에요.
    const audit = (await t.ctx.audit.recent(10)).filter((a) => a.action?.startsWith('away.'));
    expect(audit.map((a) => [a.action, a.result])).toEqual([
      ['away.clear', 'done'],
      ['away.clear', 'not-found'],
      ['away.set', 'done'],
      ['away.set', 'done'],
    ]);
  });

  it('[팀 일정 시험] 자리비움에는 자유 글 칸이 없고, 오늘부터 7일 안만 받아요', async () => {
    const t = await setup();
    const seojun = await t.loginAs(SEOJUN);
    const extra = await seojun.call('POST', '/api/navi/away', {
      kind: 'outside',
      start: '2026-10-26T14:00:00+09:00',
      end: '2026-10-26T18:00:00+09:00',
      requestId: randomUUID(),
      note: '병원 진료',
    });
    expect(extra.status).toBe(400);
    expect((await setAway(seojun, 'hospital', '2026-10-26T14:00:00+09:00', '2026-10-26T18:00:00+09:00')).status).toBe(400);
    expect((await setAway(seojun, 'outside', '2026-10-25T14:00:00+09:00', '2026-10-25T18:00:00+09:00')).status).toBe(400);
    expect((await setAway(seojun, 'outside', '2026-11-02T09:00:00+09:00', '2026-11-02T18:00:00+09:00')).status).toBe(400);
    expect((await setAway(seojun, 'outside', '2026-10-26T18:00:00+09:00', '2026-10-26T14:00:00+09:00')).status).toBe(400);
    expect((await setAway(seojun, 'remote', '2026-11-01T09:00:00+09:00', '2026-11-01T18:00:00+09:00')).status).toBe(200);
    const { rows } = await t.db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'navi_away' order by ordinal_position",
    );
    expect(rows.map((r) => r.column_name)).toEqual(['id', 'pseudonym_id', 'kind', 'starts_at', 'ends_at', 'created_at']);
    expect(JSON.stringify((await t.db.query('select * from navi_away')).rows)).not.toMatch(/병원|서준|개발팀/);
  });

  it('[팀 일정·ADR-21 시험] 자리비움은 7일 뒤 보관 회차가 지워요', async () => {
    const t = await setup();
    const seojun = await t.loginAs(SEOJUN);
    expect((await setAway(seojun, 'outside', '2026-10-26T14:00:00+09:00', '2026-10-26T18:00:00+09:00')).status).toBe(200);
    const count = async () => (await t.db.query<{ n: number }>('select count(*)::int as n from navi_away')).rows[0]!.n;
    await t.runRetention();
    expect(await count()).toBe(1);
    t.advance(7 * DAY + HOUR);
    await t.runRetention();
    expect(await count()).toBe(0);
  });

  it('[팀 일정 시험] 홈에서 "나 오후에 외근이야"는 정하지 않고 마이 페이지 양식으로 옮기는 카드만 줘요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const before = await rowCounts(t);
    const res = await home(doyun, '나 오후에 외근이야');
    expect(res).toMatchObject({ intent: 'move', headline: '자리비움은 마이 페이지에서 알려요', team: null });
    expect(res.cards[0]).toMatchObject({ id: 'home-move-away', actions: { primary: { type: 'navigate', to: 'mine' }, secondary: [] } });
    expect(await rowCounts(t)).toEqual(before);
  });
});
