import { randomUUID } from 'node:crypto';
import type { AskResponse, Card, HomeAskResponse, InquiryListResponse, PeopleSearchResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { postActionOf } from '../modules/pantry/test-kit';
import { createTestApp, MOCK } from '../testing';
import { AiGateway, FakeProvider, type LlmProvider, type ProviderResult, type StructuredRequest } from './ai/gateway';
import { type HomeInterpretation, interpretByRules, windowOf } from './home';

// 홈 AI 채팅 "나에게 해당하는 일"(ADR-27, 개선 회의 D8 해제). 시험 시계는 2026-10-26(월) 09:00이에요.
// 도윤(개발팀)이 내일 15:00 회의실을 잡고 서준을 불러요. 하늘(재무팀)은 다음 주 화요일 휴가를 인사팀에 보내요.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const SEOJUN = 'mock|emp-006';

/** 게이트웨이가 공급자에 넘긴 입력을 적어 두는 시험용 공급자. name이 'anthropic'이면 실제 모델 흉내예요. */
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
  homeInputs() {
    return this.inputs.filter((i) => i.purpose === 'home-ask');
  }
}

async function setup(o: { contract?: boolean; provider?: LlmProvider; lines?: string[] } = {}) {
  const t = await createTestApp({
    ...(o.provider ? { provider: o.provider } : {}),
    ...(o.lines ? { logger: { level: 'debug', stream: { write: (line: string) => void o.lines!.push(line) } } } : {}),
  });
  opened.push(t);
  // 무보관 계약 스위치(NO_RETENTION_CONTRACT_CONFIRMED)를 시험마다 정해요. 홈은 부를 때마다 ctx.gateway를 읽어요.
  t.ctx.gateway = new AiGateway(o.provider ?? new FakeProvider(), o.contract ?? false, t.db);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 1000 });
  for (const kind of ['rooms', 'navi', 'pantry', 'notices'] as const) await t.modules.find((m) => m.kind === kind)!.seed!();
  return t;
}

/** 도윤이 내일 15:00 회의실을 잡고(확인 시트) 서준을 불러요. 회의실 이름을 돌려줘요. */
async function reserveAndInvite(doyun: Session): Promise<string> {
  const asked = (await doyun.call('POST', '/api/ask', { text: '내일 3시 6명 회의실', kind: 'rooms' })).body as AskResponse;
  const card = asked.cards.find((c) => c.actions.primary?.type === 'propose')!;
  const plan = (await doyun.call('POST', '/api/plans', { proposalToken: (card.actions.primary as { proposalToken: string }).proposalToken })).body as {
    planId: string;
  };
  const done = (await doyun.call('POST', `/api/plans/${plan.planId}/confirm`)).body as { status: string; card: Card };
  expect(done.status).toBe('done');
  const invite = done.card.actions.primary as { reservationId: string; roomName: string };
  const refs = ((await doyun.call('POST', '/api/people/search', { query: '서준' })).body as PeopleSearchResponse).items;
  const sent = await doyun.call('POST', `/api/rooms/reservations/${invite.reservationId}/invites`, {
    people: [refs[0]!.ref],
    calendar: false,
    slack: false,
    requestId: randomUUID(),
  });
  expect(sent.status).toBe(200);
  return invite.roomName;
}

const sendLeave = (me: Session) =>
  me.call('POST', '/api/navi/inquiries', {
    rowId: 'HR-02',
    question: '휴가 신청',
    reason: '가족 행사',
    requestId: randomUUID(),
    leave: { days: [{ date: '2026-11-03', kind: 'full' }] },
  });

const home = async (me: Session, text: string) => {
  const res = await me.call('POST', '/api/home/ask', { text });
  expect(res.status, text).toBe(200);
  return res.body as HomeAskResponse;
};

/** 기록이 쌓이는 표(감사·AI 비용·접속기록 빼고)의 줄 수. 홈 경로가 아무것도 쓰지 않는지 봐요. */
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

describe('홈 질문 규칙 해석기(ADR-27)', () => {
  it.each([
    ['이번 주 내 일정 뭐 있어?', { intent: 'mine', period: 'this-week', kinds: ['reservations', 'loans', 'invites', 'leave'], moveTo: null }],
    ['내 휴가 어떻게 됐어?', { intent: 'mine', period: 'recent', kinds: ['leave'], moveTo: null }],
    ['오늘 나한테 온 거 있어?', { intent: 'mine', period: 'today', kinds: ['invites', 'inquiries', 'leave', 'inbox'], moveTo: null }],
    ['다음 주 회의 있어?', { intent: 'mine', period: 'next-week', kinds: ['reservations', 'invites'], moveTo: null }],
    ['내일 빌린 장비', { intent: 'mine', period: 'tomorrow', kinds: ['loans'], moveTo: null }],
    ['우리 부서 받은 문의 몇 건이야?', { intent: 'mine', period: 'recent', kinds: ['inbox'], moveTo: null }],
    ['내 문의 답장 왔어?', { intent: 'mine', period: 'recent', kinds: ['invites', 'inquiries', 'leave', 'inbox'], moveTo: null }],
    ['탕비실 내 요청 결과', { intent: 'mine', period: 'recent', kinds: ['pantry'], moveTo: null }],
    ['내가 보낸 요청 어떻게 됐어?', { intent: 'mine', period: 'recent', kinds: ['inquiries', 'leave', 'pantry'], moveTo: null }],
    ['나한테 온 요청 있어?', { intent: 'mine', period: 'recent', kinds: ['invites', 'inbox'], moveTo: null }],
    ['내일 3시 회의실 잡아 줘', { intent: 'move', period: 'tomorrow', kinds: [], moveTo: 'rooms' }],
    ['빔프로젝터 빌려 줘', { intent: 'move', period: 'recent', kinds: [], moveTo: 'rooms' }],
    ['빈 회의실 있어?', { intent: 'move', period: 'recent', kinds: [], moveTo: 'rooms' }],
    ['다음 주 화요일 휴가 신청할래', { intent: 'move', period: 'next-week', kinds: [], moveTo: 'navi' }],
    ['제로콜라 채워 주세요', { intent: 'move', period: 'recent', kinds: [], moveTo: 'board' }],
    ['연말정산 공지', { intent: 'move', period: 'recent', kinds: [], moveTo: 'notices' }],
    ['법인카드 분실 어디서 해?', { intent: 'move', period: 'recent', kinds: [], moveTo: 'navi' }],
    ['점심 메뉴 추천', { intent: 'unknown', period: 'recent', kinds: [], moveTo: null }],
  ] as const)('%s', (text, expected) => {
    expect(interpretByRules(text)).toEqual(expected);
  });

  it('기간: 이번 주는 오늘부터 일요일까지, 다음 주는 월요일부터 일요일까지예요(한국 시간)', () => {
    const now = Date.parse('2026-10-28T10:00:00+09:00'); // 수요일
    expect(windowOf('this-week', now)).toMatchObject({ from: now, to: Date.parse('2026-11-02T00:00:00+09:00') });
    expect(windowOf('next-week', now)).toMatchObject({ from: Date.parse('2026-11-02T00:00:00+09:00'), to: Date.parse('2026-11-09T00:00:00+09:00') });
    expect(windowOf('tomorrow', now)).toMatchObject({ from: Date.parse('2026-10-29T00:00:00+09:00'), to: Date.parse('2026-10-30T00:00:00+09:00') });
  });
});

describe('홈 AI 채팅: 나에게 해당하는 일(ADR-27)', () => {
  it('[ADR-27 시험] 내 예약·초대받은 회의를 기간으로 모으고, 항목마다 그 기능 페이지로 가는 버튼만 붙어요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const room = await reserveAndInvite(doyun);

    const week = await home(doyun, '이번 주 내 일정 뭐 있어?');
    expect(week).toMatchObject({ intent: 'mine', period: 'this-week', by: 'rule', cards: [] });
    expect(week.items).toEqual([
      {
        id: 'reservations-0',
        kind: 'reservations',
        title: `회의실 예약 · ${room}`,
        when: expect.stringContaining('10월 27일(화) 15:00'),
        detail: null,
        open: { text: '회의실에서 보기', to: 'rooms' },
      },
    ]);
    expect((await home(doyun, '내일 뭐 있어?')).items).toHaveLength(1);
    expect((await home(doyun, '다음 주 일정 뭐 있어?')).items).toEqual([]);
    expect((await home(doyun, '다음 주 일정 뭐 있어?')).headline).toBe('다음 주 나에게 해당하는 일을 찾지 못했어요');

    // 초대받은 서준은 부른 사람 이름·방·시간을 봐요(ADR-17 예외). 쓰기 버튼(참석·못 가요)은 홈에 없어요.
    const seojun = await t.loginAs(SEOJUN);
    const invited = await home(seojun, '이번 주 나한테 온 거 있어?');
    expect(invited.items).toHaveLength(1);
    expect(invited.items[0]).toMatchObject({
      kind: 'invites',
      title: `초대받은 회의 · ${room}`,
      detail: '가상 직원 도윤(개발팀)님이 불렀어요 · 아직 답하지 않았어요',
    });
    expect(JSON.stringify(invited)).not.toMatch(/"type":"(fixed|propose|post|invite)"/);

    // 홈 예시 칩 "내가 보낸 요청"(11/4): 내 예약은 섞이지 않고 보낸 것(문의·휴가·같이 채워요)만 모아요.
    expect((await home(doyun, '내가 보낸 요청 어떻게 됐어?')).items.map((i) => i.kind)).not.toContain('reservations');
  });

  it('[ADR-27 시험] 남의 일은 섞이지 않아요: 다른 사람 예약·문의·휴가가 0건이에요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const haneul = await t.loginAs(MOCK.staff);
    const room = await reserveAndInvite(doyun);
    expect((await sendLeave(haneul)).status).toBe(200);

    for (const text of [
      '이번 주 내 일정 뭐 있어?',
      '내 휴가 어떻게 됐어?',
      '오늘 나한테 온 거 있어?',
      '내 문의 답장 왔어?',
      '내가 보낸 요청 어떻게 됐어?',
      '나한테 온 요청 있어?',
    ]) {
      const body = JSON.stringify(await home(haneul, text));
      expect(body, text).not.toContain(room);
      expect(body, text).not.toContain('도윤');
    }
    const doyunView = JSON.stringify(await home(doyun, '내 휴가 어떻게 됐어?'));
    expect(doyunView).not.toContain('11월 3일');
    expect(doyunView).not.toContain('하늘');
  });

  it('[ADR-27·ADR-18 시험] 휴가는 본인 요청의 종류·상태·날만 보이고, 연차 숫자는 0건이에요. "남은 연차 보기"는 본인 휴가 카드로 가는 버튼이에요', async () => {
    const t = await setup();
    const haneul = await t.loginAs(MOCK.staff);
    expect((await sendLeave(haneul)).status).toBe(200);
    const res = await home(haneul, '내 휴가 어떻게 됐어?');
    expect(res.items).toEqual([
      {
        id: 'leave-0',
        kind: 'leave',
        title: '연차 요청 · 아직 확인 전이에요',
        when: '11월 3일(화) 하루',
        detail: '인사팀에 보냈어요',
        open: { text: '문의함에서 보기', to: 'navi' },
      },
    ]);
    expect(res.links).toEqual([{ text: '남은 연차 보기', to: 'navi', handoff: '내 남은 연차 알려 줘', auto: true }]);
    const body = JSON.stringify(res);
    expect(body).not.toMatch(/remaining|balance|남은 연차는|연차 [\d.]+일|가족 행사/);
    // 다음 주를 물으면 그 주의 날이 든 요청이 나와요. 내일을 물으면 없어요.
    expect((await home(haneul, '다음 주 휴가')).items).toHaveLength(1);
    expect((await home(haneul, '내일 휴가')).items).toEqual([]);
  });

  it('[ADR-27 시험] 내 문의는 받은 팀·상태·답장 있음만(글 없음), 받은 문의는 내 부서의 새 문의 수만 보여요', async () => {
    const t = await setup();
    const haneul = await t.loginAs(MOCK.staff);
    const jihu = await t.loginAs(MOCK.hr);
    const sent = await haneul.call('POST', '/api/navi/inquiries', {
      rowId: 'HR-01',
      question: '재직증명서 직인본 문의 QUESTIONCANARY',
      reason: '제출용',
      requestId: randomUUID(),
    });
    expect(sent.status).toBe(200);

    const inbox = await home(jihu, '받은 문의 있어?');
    expect(inbox.items).toEqual([
      {
        id: 'inbox-0',
        kind: 'inbox',
        title: '받은 문의 · 우리 부서로 온 새 문의 1건',
        when: '지금',
        detail: null,
        open: { text: '받은 문의함 보기', to: 'navi' },
      },
    ]);
    expect(JSON.stringify(inbox)).not.toMatch(/하늘|QUESTIONCANARY|재무팀/);
    // 받는 부서가 아닌 도윤에게는 받은 문의 줄이 없어요.
    expect((await home(await t.loginAs(MOCK.dev), '받은 문의 있어?')).items).toEqual([]);

    const [item] = ((await jihu.call('GET', '/api/navi/inquiries/inbox')).body as InquiryListResponse).items;
    expect((await jihu.call('POST', `/api/navi/inquiries/${item!.id}/reply`, { text: '내일 드릴게요 REPLYCANARY', requestId: randomUUID() })).status).toBe(200);
    const mine = await home(haneul, '오늘 나한테 온 거 있어?');
    expect(mine.items).toEqual([
      {
        id: 'inquiries-0',
        kind: 'inquiries',
        title: '내 문의 · 인사팀',
        when: '10월 26일(월) 보냄',
        detail: '재직증명서 발급 · 아직 확인 전이에요 · 답장 있음',
        open: { text: '문의함에서 보기', to: 'navi' },
      },
    ]);
    expect(JSON.stringify(mine)).not.toMatch(/REPLYCANARY|QUESTIONCANARY|지후|제출용/);
  });

  it('[ADR-27 시험] 같이 채워요는 내 요청 상태만 보여요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const draft = await doyun.call('POST', '/api/pantry/draft', { text: '보리차 채워 주세요' });
    const post = await doyun.call('POST', '/api/plans/direct', {
      proposalToken: postActionOf(draft.body.cards as Card[]).proposalToken,
      edits: { itemName: '보리차' },
    });
    expect(post.status).toBe(200);
    const res = await home(doyun, '탕비실 내 요청 결과');
    expect(res.items).toEqual([
      {
        id: 'pantry-0',
        kind: 'pantry',
        title: '같이 채워요 · 보리차',
        when: '5층',
        detail: '표 받는 중 · +1',
        open: { text: '같이 채워요에서 보기', to: 'board' },
      },
    ]);
  });

  it("[ADR-27·D8 시험] 'move'면 실행하지 않고 옮기기 카드만 줘요. 이 경로로 예약·신청·표 만들기는 0건이에요", async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const before = await rowCounts(t);
    const move = await home(doyun, '내일 3시 회의실 잡아 줘');
    expect(move).toMatchObject({ intent: 'move', items: [], links: [], headline: '회의실에서 찾아볼게요' });
    expect(move.cards).toHaveLength(1);
    expect(move.cards[0]).toMatchObject({
      kind: 'rooms',
      label: '안내',
      evidence: { aiSummarized: false },
      actions: { primary: { type: 'reask', text: '회의실로 옮기기', kind: 'rooms' }, secondary: [] },
    });
    // 같이 채워요 올리기는 그 페이지로 옮기기만 해요.
    const pantry = await home(doyun, '제로콜라 채워 주세요');
    expect(pantry.cards.map((c) => c.actions.primary)).toEqual([expect.objectContaining({ type: 'reask', kind: 'pantry' })]);
    // 11/5: 읽기 답(담당 찾기·공지·빈 회의실)은 그 기능의 답을 홈에서 바로 보여 줘요.
    const leave = await home(doyun, '다음 주 화요일 휴가 신청할래');
    expect(leave.cards.length).toBeGreaterThan(0);
    expect(leave.cards.every((c) => c.kind === 'navi')).toBe(true);
    const notice = await home(doyun, '연말정산 공지');
    expect(notice.cards[0]).toMatchObject({ kind: 'notices', actions: { primary: { type: 'link', text: '원문 열기' } } });
    expect(notice.cards[0]!.fields.map((f) => f.name)).toContain('원문 한 줄');
    // 빈 회의실을 물으면 후보를 보여 주되, 새 예약은 회의실 탭에서만 해요(예약 버튼 → 회의실 탭으로 옮기기).
    const free = await home(doyun, '내일 3시 6명 빈 회의실 있어?');
    expect(free.cards.length).toBeGreaterThan(0);
    expect(free.cards.map((c) => c.actions.primary)).toContainEqual({ type: 'reask', text: '회의실 탭에서 예약하기', kind: 'rooms' });
    const unknown = await home(doyun, '점심 메뉴 추천');
    expect(unknown.intent).toBe('unknown');
    expect(unknown.cards[0]!.kind).toBe('navi');
    for (const text of ['이번 주 내 일정 뭐 있어?', '내 휴가 어떻게 됐어?', '오늘 나한테 온 거 있어?']) await home(doyun, text);
    expect(await rowCounts(t)).toEqual(before);
    // 쓰기 행동(확인 시트·고정 버튼·게시)은 어떤 응답에도 없어요.
    for (const res of [move, pantry, leave, notice, free, unknown]) expect(JSON.stringify(res)).not.toMatch(/proposalToken|"type":"(fixed|propose|post)"/);
  });

  it('[ADR-27·ADR-12 시험] 모듈이 끔이면 그 종류는 안 모으고, 링크만이면 옮기기 대신 그룹웨어 링크 카드예요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    await reserveAndInvite(doyun);
    expect((await home(doyun, '이번 주 내 일정 뭐 있어?')).items).toHaveLength(1);
    await t.ctx.ops.setModule('p_op', 'rooms', 'off');
    expect((await home(doyun, '이번 주 내 일정 뭐 있어?')).items).toEqual([]);
    // 꺼진 기능으로는 옮기지 않고 모름 카드예요.
    expect((await home(doyun, '내일 3시 회의실 잡아 줘')).intent).toBe('unknown');
    await t.ctx.ops.setModule('p_op', 'rooms', 'link');
    const link = await home(doyun, '내일 3시 회의실 잡아 줘');
    expect(link.cards[0]).toMatchObject({ id: 'link-rooms', actions: { primary: { type: 'link' } } });
  });

  it('[ADR-27 시험] 운영 스위치 homeAsk를 끄면 홈 칸 경로가 닫혀요(감사에 남아요)', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/flag', { flag: 'homeAsk', value: false })).status).toBe(200);
    expect((await doyun.call('POST', '/api/home/ask', { text: '이번 주 내 일정' })).status).toBe(409);
    expect((await t.app.inject({ method: 'GET', url: '/api/config/public' })).json()).toMatchObject({ homeAsk: false });
  });

  it('[ADR-11 시험] 키·주민번호가 든 질문은 잠기고, 감사에는 "잠김"만 남아요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    for (const text of ['키 AKIAABCDEFGHIJKLMNOP 내 일정', '900101-1234567 내 휴가']) {
      const res = await doyun.call('POST', '/api/home/ask', { text });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('locked');
    }
    const audit = await t.ctx.audit.recent(10);
    expect(audit.filter((a) => a.module === 'home').map((a) => a.result)).toEqual(['locked', 'locked']);
    expect(JSON.stringify(audit)).not.toMatch(/AKIA|900101/);
  });

  it('[ADR-13] 요청 횟수 제한은 home-ask 키로 따로 세요', async () => {
    const t = await setup();
    t.ctx.ops.patchValues({ rateLimitPerMinute: 2 });
    const doyun = await t.loginAs(MOCK.dev);
    expect((await doyun.call('POST', '/api/home/ask', { text: '내 일정' })).status).toBe(200);
    expect((await doyun.call('POST', '/api/home/ask', { text: '내 일정' })).status).toBe(200);
    expect((await doyun.call('POST', '/api/home/ask', { text: '내 일정' })).status).toBe(429);
    // 다른 경로(/api/ask)의 횟수와 섞이지 않아요.
    expect((await doyun.call('POST', '/api/ask', { text: '법인카드 잃어버렸어요' })).status).toBe(200);
  });

  it('[ADR-10 시험] 질문 카나리는 DB·로그·감사 로그·응답(본문·머리·주소)에 0건이에요', async () => {
    const lines: string[] = [];
    const provider = new RecordingProvider('anthropic', { intent: 'mine', period: 'this-week', kinds: [], moveTo: null });
    const t = await setup({ contract: true, provider, lines });
    const doyun = await t.loginAs(MOCK.dev);
    await reserveAndInvite(doyun);
    const canary = '카나리홈QZ9';
    const responses = [];
    for (const text of [`이번 주 내 일정 뭐 있어 ${canary}`, `내일 회의실 잡아 줘 ${canary}`, `${canary}`]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/home/ask',
        headers: { cookie: doyun.cookie, 'x-csrf-token': doyun.csrf },
        payload: { text },
      });
      expect(res.statusCode).toBe(200);
      responses.push(res);
    }
    // 실제 모델 흉내로 돌려서 게이트웨이에는 질문이 갔어요(이건 의도). 그 밖에는 어디에도 없어요.
    expect(provider.homeInputs().length).toBe(3);
    for (const res of responses) {
      expect(res.body).not.toContain(canary);
      expect(JSON.stringify(res.headers)).not.toContain(encodeURIComponent(canary));
      expect(JSON.stringify(res.headers)).not.toContain(canary);
    }
    const { rows: tables } = await t.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'");
    for (const { table_name } of tables) {
      const { rows } = await t.db.query(`select * from ${table_name}`);
      expect(JSON.stringify(rows), table_name).not.toContain(canary);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(canary);
    expect(JSON.stringify(await t.ctx.audit.recent(50))).not.toContain(canary);
  });
});

describe('홈 질문 해석: 게이트웨이(ADR-10·27)', () => {
  it('[ADR-27 시험] 무보관 계약 끔이면 AI를 부르지 않고 규칙으로 같은 결과를 내요', async () => {
    const provider = new RecordingProvider('anthropic', { intent: 'mine', period: 'next-week', kinds: ['leave'], moveTo: null });
    const t = await setup({ contract: false, provider });
    const doyun = await t.loginAs(MOCK.dev);
    await reserveAndInvite(doyun);
    const res = await home(doyun, '이번 주 내 일정 뭐 있어?');
    expect(provider.homeInputs()).toEqual([]);
    expect(res).toMatchObject({ by: 'rule', period: 'this-week', kinds: ['reservations', 'loans', 'invites', 'leave'] });
    expect(res.items).toHaveLength(1);
    const move = await home(doyun, '내일 3시 회의실 잡아 줘');
    expect(move.cards[0]!.evidence.aiSummarized).toBe(false);
  });

  it('[ADR-27 시험] 계약 켬 + 가짜 공급자면 규칙 대안(fallback)이고 "AI 정리"가 붙지 않아요. 게이트웨이 입력은 질문 글뿐이에요', async () => {
    const provider = new RecordingProvider('fake');
    const t = await setup({ contract: true, provider });
    const doyun = await t.loginAs(MOCK.dev);
    const room = await reserveAndInvite(doyun);
    const haneul = await t.loginAs(MOCK.staff);
    expect((await sendLeave(haneul)).status).toBe(200);
    provider.inputs.length = 0;

    const text = '이번 주 내 일정 뭐 있어?';
    const res = await home(doyun, text);
    expect(res).toMatchObject({ by: 'rule', period: 'this-week' });
    expect(res.items).toHaveLength(1);
    const leave = await home(haneul, '내 휴가 어떻게 됐어?');
    expect(leave.items).toHaveLength(1);
    const move = await home(doyun, '내일 3시 회의실 잡아 줘');
    expect(move.cards[0]!.evidence.aiSummarized).toBe(false);

    // 공급자에 간 입력은 질문 글 그대로이고, 내 자료(방 이름·휴가 날짜·이름·부서)는 없어요. 등급은 1이에요.
    expect(provider.homeInputs()).toEqual([
      { purpose: 'home-ask', input: text, grade: 1 },
      { purpose: 'home-ask', input: '내 휴가 어떻게 됐어?', grade: 1 },
      { purpose: 'home-ask', input: '내일 3시 회의실 잡아 줘', grade: 1 },
    ]);
    const all = JSON.stringify(provider.homeInputs());
    for (const secret of [room, '11월 3일', '2026-11-03', '가상 직원', '개발팀', '재무팀', '인사팀']) expect(all).not.toContain(secret);
  });

  it('11/5: 때를 묻는 담당 질문이면 담당 카드 뒤에 맞는 공지의 원문 한 줄을 같이 보여 줘요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const res = await home(doyun, '연말정산 서류는 언제까지 어디에 내요?');
    expect(res.cards.map((c) => c.kind)).toEqual(['navi', 'notices']);
    expect(res.cards[1]!.fields).toContainEqual({ name: '원문 한 줄', value: '“올해 연말정산 서류는 1월 15일부터 1월 31일까지 그룹웨어에서 받아요.”' });
    // 때를 묻지 않으면 공지를 붙이지 않아요.
    expect((await home(doyun, '법인카드 잃어버리면 어디에 말해요?')).cards.map((c) => c.kind)).toEqual(['navi']);
  });

  it('[ADR-27 시험] 계약 켬 + 실제 모델(흉내)이면 그 해석을 쓰고 "AI 정리"가 붙어요', async () => {
    const provider = new RecordingProvider('anthropic', { intent: 'mine', period: 'next-week', kinds: ['leave'], moveTo: null });
    const t = await setup({ contract: true, provider });
    const haneul = await t.loginAs(MOCK.staff);
    expect((await sendLeave(haneul)).status).toBe(200);
    // 규칙이면 "모름"일 문장이어도 모델 해석(다음 주 휴가)을 따라요.
    const res = await home(haneul, '그거 어떻게 돼 가나 몰라');
    expect(res).toMatchObject({ intent: 'mine', by: 'ai', period: 'next-week', kinds: ['leave'] });
    expect(res.items.map((i) => i.kind)).toEqual(['leave']);
    expect(res.links).toEqual([expect.objectContaining({ text: '남은 연차 보기' })]);

    const moving = new RecordingProvider('anthropic', { intent: 'move', period: 'recent', kinds: [], moveTo: 'rooms' });
    const t2 = await setup({ contract: true, provider: moving });
    // 규칙으로는 문의하기일 문장이어도 모델 해석(회의실)을 따라요. 시키는 문장이라 새 예약은 회의실 탭으로 옮겨요.
    const card = (await home(await t2.loginAs(MOCK.dev), '다음 주 팀 회의 장소 좀 잡아 줘')).cards[0]!;
    expect(card).toMatchObject({ kind: 'rooms', evidence: { aiSummarized: true }, actions: { primary: { type: 'reask', kind: 'rooms' } } });
  });

  it('[ADR-27 시험] 모델이 실패하면 규칙으로 돌아가고 "AI 정리"를 붙이지 않아요', async () => {
    const failing: LlmProvider = {
      name: 'anthropic',
      complete: async () => {
        throw new Error('boom');
      },
    };
    const t = await setup({ contract: true, provider: failing });
    const doyun = await t.loginAs(MOCK.dev);
    const res = await home(doyun, '내일 3시 회의실 잡아 줘');
    expect(res).toMatchObject({ intent: 'move', by: 'rule' });
    expect(res.cards[0]!.evidence.aiSummarized).toBe(false);
  });
});

describe('알아들은 것(11/5 시험, AI 보완 2번)', () => {
  it('낱말 규칙으로 해석하면 알아들은 것만 붙여요. 질문 글은 돌려주지 않아요', async () => {
    const t = await setup({ contract: false });
    const doyun = await t.loginAs(MOCK.dev);
    const res = await home(doyun, '이번 주 내 일정 뭐 있어?');
    expect(res.read).toEqual({ understood: '이번 주 · 내 일(내 예약·장비 대여·초대받은 회의·휴가 요청)' });
  });

  it('AI가 낱말 규칙과 다르게 보면 규칙이 본 것도 같이 붙여요. 같으면 붙이지 않아요', async () => {
    const provider = new RecordingProvider('anthropic', { intent: 'move', period: 'recent', kinds: [], moveTo: 'navi' });
    const t = await setup({ contract: true, provider });
    const doyun = await t.loginAs(MOCK.dev);
    const tv = await home(doyun, '회의실 TV가 안 켜져요');
    expect(tv.read).toEqual({ understood: '하려는 일 · 문의함에서 해요', ruleSaid: '요즘 · 내 일(내 예약·초대받은 회의)' });
    expect(JSON.stringify(tv)).not.toContain('TV');
    const same = await home(doyun, '법인카드 잃어버렸는데 어디에 말해?');
    expect(same.read).toEqual({ understood: '하려는 일 · 문의함에서 해요' });
  });
});
