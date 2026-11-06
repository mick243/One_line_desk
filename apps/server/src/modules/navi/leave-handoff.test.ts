import type { AskResponse, Card, CardAction, HomeAskResponse, LeaveStartResponse, LinkOpenResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { LEAVE_IN_APP_BLOCKED, loadConfig } from '../../config';
import { AiGateway, type LlmProvider, type ProviderResult, type StructuredRequest } from '../../core/ai/gateway';
import { pseudonymize } from '../../core/pseudonym';
import { interpretByRules } from '../../core/home';
import { createTestApp, MOCK } from '../../testing';
import { isEventLeaveQuestion } from './leave';

// 휴가 A안: 그룹웨어로 넘기기(11/6 사용자 결정, ADR-24 개정·ADR-18 보강). 시험 시계는 2026-10-26(월) 09:00이에요.
// 앱 안 휴가 결재(DESK_LEAVE_IN_APP)는 꺼진 채(운영 기본)로 돌아요. 앱은 신청 전 카드와 승인 뒤 반영(근태 기록 읽기)만 해요.
// 도윤(개발팀, 입사 1년 미만): 남은 연차 7.5일 · 이번 연차 기간 ~2026-11-30. 하늘(재무팀): 올해 병가 1.5일.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

/** 게이트웨이가 공급자에 넘긴 입력을 적어 두는 시험용 공급자(실제 모델 흉내, 답은 결정적 대안) */
class RecordingProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly inputs: { purpose: string; input: string; system: string }[] = [];
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    this.inputs.push({ purpose: req.purpose, input: req.input, system: req.system });
    return { output: req.schema.parse(req.fallback()), inputTokens: 1, outputTokens: 1 };
  }
}

async function setup(o: { provider?: LlmProvider; contract?: boolean } = {}) {
  const t = await createTestApp({ leaveInApp: false, ...(o.provider ? { provider: o.provider } : {}) });
  opened.push(t);
  if (o.provider) t.ctx.gateway = new AiGateway(o.provider, o.contract ?? true, t.db);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 1000 });
  for (const kind of ['rooms', 'navi', 'notices'] as const) await t.modules.find((m) => m.kind === kind)!.seed!();
  return t;
}

const field = (card: Card | undefined, name: string) => card?.fields.find((f) => f.name === name)?.value;
const askNavi = async (me: Session, text: string) => ((await me.call('POST', '/api/ask', { text, kind: 'navi' })).body as AskResponse).cards;
const checkCard = async (me: Session, text: string) => {
  const cards = await askNavi(me, text);
  // 쓰려는 말이면 신청 전 카드 하나로 답해요(담당 카드의 [인사팀에 문의하기]와 섞이지 않게).
  expect(cards.map((c) => c.id)).toEqual(['navi-leave-check']);
  return cards[0]!;
};
const home = async (me: Session, text: string) => (await me.call('POST', '/api/home/ask', { text })).body as HomeAskResponse;
const actionsOf = (card: Card): CardAction[] => [...(card.actions.primary ? [card.actions.primary] : []), ...card.actions.secondary];

/** 도윤이 10월 27일(화) 15:00 회의실을 잡아요(확인 시트). 회의실 이름을 돌려줘요. */
async function reserve(me: Session): Promise<string> {
  const asked = (await me.call('POST', '/api/ask', { text: '10월 27일 3시 4명 회의실', kind: 'rooms' })).body as AskResponse;
  const card = asked.cards.find((c) => c.actions.primary?.type === 'propose')!;
  const plan = (await me.call('POST', '/api/plans', { proposalToken: (card.actions.primary as { proposalToken: string }).proposalToken })).body as {
    planId: string;
  };
  const done = (await me.call('POST', `/api/plans/${plan.planId}/confirm`)).body as { status: string; card: Card };
  expect(done.status).toBe('done');
  return (done.card.actions.primary as { roomName: string }).roomName;
}

describe('신청 전 카드(11/6 A안): 숫자는 서버 규칙이에요', () => {
  it('연차: 그날 쓰면 남은 연차 ○일 → ○일, 반차는 0.5일, 날 없이 양만 말해도 계산해요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);

    const full = await checkCard(doyun, '10월 27일 연차 쓰고 싶어');
    expect(full).toMatchObject({ kind: 'navi', label: '안내', headline: '10월 27일(화) 하루 쓰면 남은 연차는 6.5일이에요' });
    expect(field(full, '쓸 날')).toBe('10월 27일(화) 하루');
    expect(field(full, '남은 연차')).toBe('7.5일 → 6.5일');
    // 문구는 화면설계 "보안이 보이는 문구" 표 그대로예요.
    expect(full.tail).toBe('아직 신청 전이에요. 그룹웨어에서 신청해야 결재가 시작돼요');
    // 규정 한 줄: 허용 게시판 공지 본문 문장을 고치지 않고 그대로 붙여요(원문 링크는 근거 줄).
    expect(field(full, '휴가 규정')).toBe('“연차와 반차는 쓰려는 날 3일 전까지 그룹웨어 전자결재에서 휴가 신청서를 올려 주세요.” · 연차·휴가 신청 방법 안내');
    expect(full.evidence).toMatchObject({ href: 'https://groupware.example.com/board/notice/1009', aiSummarized: false });

    const half = await checkCard(doyun, '10월 27일 오후 반차 쓰고 싶어');
    expect(half.headline).toBe('10월 27일(화) 오후 반차 쓰면 남은 연차는 7일이에요');
    expect(field(half, '남은 연차')).toBe('7.5일 → 7일');

    const amount = await checkCard(doyun, '연차 이틀 쓰면 몇 개 남아?');
    expect(amount.headline).toBe('연차 2일 쓰면 남은 연차는 5.5일이에요');
    expect(field(amount, '쓸 날')).toBe('연차 2일');
    // 날이 없으면 복사할 내용·그날 일정이 없어요.
    expect(actionsOf(amount).some((a) => a.type === 'copy')).toBe(false);
    expect(field(amount, '그날 내 일정')).toBeUndefined();

    // 다음 연차 기간(12월~)의 날은 이번 기간에서 빼지 않고 다음 기간에서 빼요.
    const later = await checkCard(doyun, '12월 2일 연차 쓰고 싶어');
    expect(field(later, '남은 연차')).toBe('7.5일 → 7.5일');
    expect(field(later, '다음 연차 기간')).toMatch(/^2026-12-01부터 .+일 → .+일$/);

    // 맞는 공지를 찾지 못하면(공지 끔) 규정 줄은 지어내지 않고 빼요.
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/switch', { module: 'notices', value: 'off' })).status).toBe(200);
    const noRule = await checkCard(doyun, '10월 27일 연차 쓰고 싶어');
    expect(field(noRule, '휴가 규정')).toBeUndefined();
    expect(noRule.evidence.href).toBeUndefined();
  });

  it('공가는 연차에서 빠지지 않고, 병가는 올해 병가 쓴 날이 늘어요(한도·진단서 안내는 운영 값)', async () => {
    const t = await setup();
    const haneul = await t.loginAs(MOCK.staff);
    const remaining = Number(((await askNavi(haneul, '내 연차 몇 개 남았어?')).find((c) => c.id === 'navi-my-leave')!.headline.match(/([\d.]+)일/) ?? [])[1]);

    const official = await checkCard(haneul, '11월 3일 예비군 훈련이라 공가 쓰려고');
    expect(official.headline).toBe('공가는 연차에서 빠지지 않아요');
    expect(field(official, '남은 연차')).toBe(`${remaining}일 그대로예요(공가는 연차에서 빠지지 않아요)`);
    expect(actionsOf(official).find((a) => a.type === 'copy')).toMatchObject({
      value: '휴가 종류: 공가\n기간: 11/3(화) ~ 11/3(화)\n날짜: 11/3(화) 하루\n일수: 1일\n사유: 그룹웨어 신청서에 직접 적어 주세요(꼭 적어야 해요)',
    });

    t.ctx.ops.patchValues({ sickLeaveYearDays: 10, sickNoteOverDays: 3 });
    const sick = await checkCard(haneul, '오늘 몸살이라 병가 쓸래');
    // 11/6: 병가의 연차 차감은 회사 규정(운영 값, 기본 안 뺌)이라 단정하지 않아요. 공가는 법 근거라 그대로예요.
    expect(sick.headline).toBe('병가는 연차와 따로 셌어요');
    expect(field(sick, '남은 연차')).toBe(`${remaining}일 그대로예요(병가는 연차와 따로 셌어요)`);
    expect(field(sick, '연차 차감')).toBe('회사 규정에 따라 연차에서 빠질 수 있어요');
    expect(field(official, '연차 차감')).toBeUndefined();
    // 하늘의 올해 병가: 1월 19일 하루 + 9월 7일 반차 = 1.5일. 오늘 하루를 더하면 2.5일이에요.
    expect(field(sick, '올해 병가')).toBe('1.5일 → 2.5일 (한도 10일)');
    expect(field(sick, '진단서')).toBeUndefined();

    // 이미 근태 기록에 있는 날(하늘 11월 6일 하루)이면 알려 줘요.
    const taken = await checkCard(haneul, '다음 주 금요일 연차 쓰고 싶어');
    expect(field(taken, '이미 잡힌 휴가')).toBe('11월 6일(금) 하루 · 이미 근태 기록에 있어요');
  });

  it('[휴가 신청하기] 양식·휴가 요청 보내기·승인·반려 경로는 닫혀 있어요(앱은 결재 권한이 없어요)', async () => {
    const t = await setup();
    const haneul = await t.loginAs(MOCK.staff);
    const card = await checkCard(haneul, '10월 30일 연차 쓰고 싶어');
    expect(actionsOf(card).some((a) => a.type === 'leave-request')).toBe(false);

    const sent = await haneul.call('POST', '/api/navi/inquiries', {
      rowId: 'HR-02',
      question: '휴가 신청',
      reason: '가족 행사',
      requestId: 'req-handoff-0001',
      leave: { days: [{ date: '2026-10-30', kind: 'full' }] },
    });
    expect(sent).toMatchObject({ status: 409, body: { error: 'leave-in-app-off' } });
    const jihu = await t.loginAs(MOCK.hr);
    expect(await jihu.call('POST', '/api/navi/inquiries/1/decision', { decision: 'approved' })).toMatchObject({
      status: 409,
      body: { error: 'leave-in-app-off' },
    });
    expect((await t.db.query<{ n: number }>('select count(*)::int as n from navi_inquiries')).rows[0]!.n).toBe(0);
    // 일반 문의는 그대로 보내져요.
    const general = await haneul.call('POST', '/api/navi/inquiries', {
      rowId: 'HR-01',
      question: '재직증명서 직인본',
      reason: '은행 제출',
      requestId: 'req-handoff-0002',
    });
    expect(general.status).toBe(200);

    // 바로 하기 [휴가 신청하기]는 양식 대신 신청 전 카드(날 없이)예요.
    const start = (await haneul.call('GET', '/api/navi/leave/start')).body as LeaveStartResponse;
    expect(start.action).toBeNull();
    expect(start.card).toMatchObject({ id: 'navi-leave-check', tail: '아직 신청 전이에요. 그룹웨어에서 신청해야 결재가 시작돼요' });
    // 남은 연차만 물으면 예전 남은 연차 카드에 [휴가 신청하기] 대신 [그룹웨어에서 신청하기]가 붙어요.
    const balance = (await askNavi(haneul, '내 연차 몇 개 남았어?')).find((c) => c.id === 'navi-my-leave')!;
    expect(balance.actions.secondary).toEqual([
      { type: 'link', text: '그룹웨어에서 신청하기', href: 'http://localhost:5190/demo/groupware/leave?type=annual&from=&to=&half=' },
    ]);
  });
});

/** 신청 전 카드 버튼은 그룹웨어로 가기·복사·다른 날 보기뿐이에요. 남에게 영향을 주는 정리 버튼(예약 옮기기·못 가요·취소·초대)은 0개예요. */
const SAFE_ACTIONS = new Set(['link', 'copy', 'leave-day']);
const expectNoOthersTouched = (card: Card) => {
  for (const a of actionsOf(card)) expect(SAFE_ACTIONS.has(a.type), `${a.type}:${a.text}`).toBe(true);
  expect(JSON.stringify(card)).not.toMatch(/예약 옮기기|못 가요|무례/);
};

describe('걸린 일이 없는 날 고르기(11/6 사용자 결정)', () => {
  it('연차: 그날 내 일을 사실로만 보여 주고, 걸린 일이 없는 가까운 평일 둘을 제안해요. [이 날로 보기]로 다시 계산한 날에는 내 일이 0건이에요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const room = await reserve(doyun);

    const mine = await checkCard(doyun, '10월 27일 연차 쓰고 싶어');
    expect(field(mine, '그날 내 일정')).toBe(`10/27(화)에는 15:00~16:00 회의(${room}, 내 예약)가 잡혀 있어요`);
    // 앞뒤로 가까운 평일: 10/28(수)·10/26(월, 오늘)이에요. 회사 휴일은 몰라서 평일만 봐요.
    expect(field(mine, '걸린 일이 없는 가까운 날')).toBe('10/26(월) · 10/28(수)');
    const picks = mine.actions.secondary.filter((a): a is Extract<CardAction, { type: 'leave-day' }> => a.type === 'leave-day');
    expect(picks.map((a) => a.text)).toEqual(['10/26(월)로 보기', '10/28(수)로 보기']);
    expect(picks[1]).toMatchObject({ leaveType: 'annual', days: [{ date: '2026-10-28', kind: 'full' }] });
    expectNoOthersTouched(mine);

    // [이 날로 보기]: 그 날로 다시 계산한 카드예요(읽기만). 그 날에는 내 일이 없어서 더 제안하지 않아요.
    const again = (await doyun.call('POST', '/api/navi/leave/check', { type: picks[1]!.leaveType, days: picks[1]!.days })).body as { card: Card };
    expect(again.card.headline).toBe('10월 28일(수) 하루 쓰면 남은 연차는 6.5일이에요');
    expect(field(again.card, '그날 내 일정')).toBe('그날 잡힌 내 일이 없어요');
    expect(again.card.actions.secondary.some((a) => a.type === 'leave-day')).toBe(false);
    expect(JSON.stringify(again.card)).not.toContain(room);
    expect(again.card.actions.primary).toMatchObject({ href: 'http://localhost:5190/demo/groupware/leave?type=annual&from=2026-10-28&to=2026-10-28&half=' });
    // 날짜 코드 검사: 주말·지난 날은 막아요.
    expect((await doyun.call('POST', '/api/navi/leave/check', { type: 'annual', days: [{ date: '2026-10-31', kind: 'full' }] })).status).toBe(400);
    expect((await doyun.call('POST', '/api/navi/leave/check', { type: 'annual', days: [{ date: '2026-10-20', kind: 'full' }] })).status).toBe(400);

    // 오전 반차(13시 전)는 15시 회의와 겹치지 않아요.
    const am = await checkCard(doyun, '10월 27일 오전 반차 쓰고 싶어');
    expect(field(am, '그날 내 일정')).toBe('그날 잡힌 내 일이 없어요');
    expect(field(am, '걸린 일이 없는 가까운 날')).toBeUndefined();

    // 하늘은 같은 날을 물어도 도윤의 예약을 보지 못해요(남의 예약 0).
    const haneul = await t.loginAs(MOCK.staff);
    const other = await checkCard(haneul, '10월 27일 연차 쓰고 싶어');
    expect(field(other, '그날 내 일정')).toBe('그날 잡힌 내 일이 없어요');
    expect(JSON.stringify(other)).not.toContain(room);
  });

  it('병가·공가·경조는 날을 고를 수 없어서 다른 날을 제안하지 않고, 그날 잡혀 있던 내 일만 알려요. 사유는 그룹웨어 신청서에 적어요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const room = await reserve(doyun);
    for (const [text, type] of [
      ['10월 27일 몸살이라 병가 쓸래', 'sick'],
      ['10월 27일 예비군 훈련이라 공가 쓰려고', 'official'],
      ['10월 27일 부고 받아서 쉬어야 해', 'family-event'],
    ] as const) {
      const card = await checkCard(doyun, text);
      expect(field(card, '그날 내 일정'), type).toBe(`그날 잡혀 있던 일 1건이 있어요 · 10/27(화) 15:00~16:00 ${room}`);
      expect(field(card, '걸린 일이 없는 가까운 날'), type).toBeUndefined();
      expect(
        card.actions.secondary.some((a) => a.type === 'leave-day'),
        type,
      ).toBe(false);
      expect(field(card, '사유'), type).toBe('사유는 그룹웨어 신청서에 적어 주세요');
      expect((card.actions.primary as { href: string }).href, type).toContain(`type=${type}&from=2026-10-27`);
      expectNoOthersTouched(card);
    }
    // 연차 카드에는 사유 줄이 없어요(연차 사유는 그룹웨어에서 골라서 적어요).
    expect(field(await checkCard(doyun, '10월 28일 연차 쓰고 싶어'), '사유')).toBeUndefined();
  });
});

describe('경조(11/6): 해석과 연차 계산', () => {
  it('경조·결혼식·장례·부고·조문을 알아듣고, 연차·반차를 직접 말하면 연차예요. 홈 낱말 규칙도 휴가 신청으로 옮겨요', () => {
    for (const text of ['경조 휴가 신청하고 싶어', '장례식 때문에 내일 쉬어야 해', '조문 가야 해서 오후에 빠져야 해요', '동생 결혼식이라 휴가 신청할게'])
      expect(isEventLeaveQuestion(text), text).toBe(true);
    for (const text of ['친구 결혼식이라 연차 쓰고 싶어', '결혼식장 어디야?', '연차 몇 개 남았어?']) expect(isEventLeaveQuestion(text), text).toBe(false);
    expect(interpretByRules('경조 휴가 쓰고 싶어')).toMatchObject({ intent: 'move', moveTo: 'navi' });
    expect(interpretByRules('내 경조 휴가 어떻게 됐어?')).toMatchObject({ intent: 'mine', kinds: expect.arrayContaining(['leave']) });
  });

  it('경조 카드: 연차에서 빠지지 않고, 근태 기록에 경조로 들어가도 남은 연차는 그대로예요. 복사·링크에는 종류·날짜만 있어요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const card = await checkCard(doyun, '11월 3일 조문 가야 해서 쉬어야 해');
    expect(card.headline).toBe('경조는 연차와 따로 셌어요');
    expect(field(card, '남은 연차')).toBe('7.5일 그대로예요(경조는 연차와 따로 셌어요)');
    expect(field(card, '연차 차감')).toBe('회사 규정에 따라 연차에서 빠질 수 있어요');
    expect(card.actions.secondary).toContainEqual({
      type: 'copy',
      text: '신청 내용 복사',
      value: '휴가 종류: 경조\n기간: 11/3(화) ~ 11/3(화)\n날짜: 11/3(화) 하루\n일수: 1일\n사유: 그룹웨어 신청서에 직접 적어 주세요(꼭 적어야 해요)',
    });
    expect(card.actions.primary).toMatchObject({ href: 'http://localhost:5190/demo/groupware/leave?type=family-event&from=2026-11-03&to=2026-11-03&half=' });

    await t.ctx.adapters.leave.recordUses({ idpSubject: MOCK.dev, email: 'doyun@corp.example' }, [{ date: '2026-11-03', kind: 'full', type: 'family-event' }]);
    const balance = (await askNavi(doyun, '내 연차 몇 개 남았어?')).find((c) => c.id === 'navi-my-leave')!;
    expect(balance.headline).toBe('남은 연차는 7.5일이에요');
    // 같은 팀 일정에는 날·하루만 나가고 종류(경조)는 나가지 않아요.
    const seojun = await t.loginAs(MOCK.devMember);
    const team = await home(seojun, '다음 주 우리 부서 휴가자');
    expect(team.team?.entries).toContainEqual({ name: '가상 직원 도윤', date: '2026-11-03', what: 'leave', part: 'full' });
    expect(JSON.stringify(team)).not.toMatch(/경조|family-event/);
  });
});

describe('그룹웨어 링크(운영 설정 leave·approvals)', () => {
  it('자리 표시 {from}·{to}·{type}·{half}를 날짜·종류 코드로 채우고, 비어 있으면 시연은 가상 그룹웨어, 운영은 글 안내만이에요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);

    // 시연 기본값: 비어 있으면 가상 그룹웨어 주소예요.
    const demo = await checkCard(doyun, '10월 27일 오후 반차 쓰고 싶어');
    expect(demo.actions.primary).toEqual({
      type: 'link',
      text: '그룹웨어에서 신청하기',
      href: 'http://localhost:5190/demo/groupware/leave?type=annual&from=2026-10-27&to=2026-10-27&half=pm',
    });
    expect(demo.actions.secondary).toContainEqual({
      type: 'copy',
      text: '신청 내용 복사',
      value: '휴가 종류: 연차\n기간: 10/27(화) ~ 10/27(화)\n날짜: 10/27(화) 오후 반차\n일수: 0.5일\n사유: 그룹웨어 신청서에 직접 적어 주세요',
    });

    // 운영자가 넣은 주소: 경로의 자리 표시(%7B…%7D로 바뀜)도 채워요. 질문 글은 주소에 없어요.
    const op = await t.loginAs(MOCK.operator);
    expect(
      (await op.call('PUT', '/api/ops/link', { module: 'leave', url: 'https://gw.example.com/leave/{type}?from={from}&to={to}&half={half}' })).status,
    ).toBe(200);
    const set = await checkCard(doyun, '다음 주 월화 연차 쓰고 싶어');
    expect(set.actions.primary).toMatchObject({ href: 'https://gw.example.com/leave/annual?from=2026-11-02&to=2026-11-03&half=' });
    expect((set.actions.primary as { href: string }).href).not.toMatch(/쓰고|%EC/);

    // 운영(시연 아님)에 주소가 비어 있으면 버튼 대신 "그룹웨어에서 신청해 주세요"예요. 빈 글로 지울 수 있어요.
    expect((await op.call('PUT', '/api/ops/link', { module: 'leave', url: '' })).status).toBe(200);
    t.ctx.config.demo = false;
    const empty = await checkCard(doyun, '10월 27일 연차 쓰고 싶어');
    expect(empty.actions.primary).toBeUndefined();
    expect(field(empty, '신청하는 곳')).toBe('그룹웨어에서 신청해 주세요');
  });
});

describe('AI에는 질문 글만 가요', () => {
  it('홈 채팅 신청 전 카드: 모델 입력에 남은 연차·일정·규정 문장이 없어요(등급 1, 질문 글만)', async () => {
    const provider = new RecordingProvider();
    const t = await setup({ provider });
    const doyun = await t.loginAs(MOCK.dev);
    const room = await reserve(doyun);
    provider.inputs.length = 0;

    const res = await home(doyun, '10월 27일 연차 쓰고 싶어');
    const card = res.cards.find((c) => c.id === 'navi-leave-check')!;
    expect(field(card, '남은 연차')).toBe('7.5일 → 6.5일');
    expect(field(card, '그날 내 일정')).toContain(room);
    expect(provider.inputs.length).toBeGreaterThan(0);
    for (const i of provider.inputs) {
      expect(i.input, i.purpose).toContain('10월 27일 연차 쓰고 싶어');
      expect(`${i.input}\n${i.system}`, i.purpose).not.toMatch(/7\.5|6\.5|15:00|2025-12-01|그룹웨어 전자결재에서/);
      expect(i.input, i.purpose).not.toContain(room);
    }
  });
});

describe('MCP 휴가 준비 링크(11/6 A안)', () => {
  it('링크를 열면 양식 대신 그 날짜·종류의 신청 전 카드예요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const token = t.ctx.plans.propose({ pseudonymId: pseudonymize(t.ctx.config.pseudonymSecret, MOCK.dev) }, 'navi', 'leave-link', {
      days: [{ date: '2026-10-28', kind: 'half', half: 'am' }],
      type: 'annual',
    });
    const res = (await doyun.call('POST', '/api/mcp/link', { proposalToken: token })).body as LinkOpenResponse;
    expect(res.kind).toBe('leave-check');
    const card = (res as Extract<LinkOpenResponse, { kind: 'leave-check' }>).card;
    expect(card.headline).toBe('10월 28일(수) 오전 반차 쓰면 남은 연차는 7일이에요');
    expect(card.actions.primary).toMatchObject({ href: 'http://localhost:5190/demo/groupware/leave?type=annual&from=2026-10-28&to=2026-10-28&half=am' });
  });
});

describe('상태 묻기(11/6 A안): 승인된 휴가는 근태 기록, 결재 중인 것은 결재함', () => {
  it('"내 휴가 신청 어떻게 됐어?" → 근태 기록의 승인된 휴가와 [결재함 열기]', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const before = await home(doyun, '내 휴가 신청 어떻게 됐어?');
    const empty = before.cards.find((c) => c.id === 'navi-leave-status')!;
    expect(before.headline).toBe('근태 기록에 승인된 휴가가 없어요');
    expect(field(empty, '결재 중인 신청')).toBe('결재 진행 상황은 그룹웨어 결재함에서 봐요');
    expect(empty.actions.primary).toEqual({ type: 'link', text: '결재함 열기', href: 'http://localhost:5190/demo/groupware/inbox' });

    // 그룹웨어가 최종 승인해 근태 기록에 들어가면(여기서는 근태 어댑터에 바로 넣어요) 앱이 읽어요.
    await t.ctx.adapters.leave.recordUses({ idpSubject: MOCK.dev, email: 'doyun@corp.example' }, [{ date: '2026-11-06', kind: 'full', type: 'annual' }]);
    const after = await home(doyun, '내 휴가 신청 어떻게 됐어?');
    const card = after.cards.find((c) => c.id === 'navi-leave-status')!;
    expect(after.headline).toBe('11월 6일(금) 연차 하루가 승인됐어요');
    expect(field(card, '승인됐어요')).toBe('11월 6일(금) 연차 하루');
    // 남은 연차 숫자는 홈 답에 없어요(ADR-27). 본인 화면으로 가는 버튼만 있어요.
    expect(JSON.stringify(after)).not.toMatch(/남은 연차는|6\.5일/);

    // 결재함 주소를 운영자가 넣으면 그 주소예요.
    const op = await t.loginAs(MOCK.operator);
    await op.call('PUT', '/api/ops/link', { module: 'approvals', url: 'https://gw.example.com/approvals' });
    expect((await home(doyun, '내 휴가 신청 어떻게 됐어?')).cards.find((c) => c.id === 'navi-leave-status')!.actions.primary).toMatchObject({
      href: 'https://gw.example.com/approvals',
    });
  });

  it('앱 안 휴가 결재를 켠 개발·시험에서는 상태 카드를 붙이지 않아요(휴가 요청이 내 요청에 있어요)', async () => {
    const t = await createTestApp({ leaveInApp: true });
    opened.push(t);
    await t.modules.find((m) => m.kind === 'navi')!.seed!();
    const doyun = await t.loginAs(MOCK.dev);
    expect((await home(doyun, '내 휴가 신청 어떻게 됐어?')).cards.some((c) => c.id === 'navi-leave-status')).toBe(false);
  });
});

describe('운영 설정 검사: 앱 안 휴가 결재는 운영에서 켤 수 없어요', () => {
  const secrets = { SESSION_SECRET: 's'.repeat(40), PSEUDONYM_SECRET: 'p'.repeat(40), PROPOSAL_SECRET: 'q'.repeat(40), MCP_TOKEN_SECRET: 'm'.repeat(40) };
  const problemsOf = (env: NodeJS.ProcessEnv) => {
    try {
      loadConfig(env);
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };

  it('운영·시연 배포(production)에 DESK_LEAVE_IN_APP=true면 뜨지 않고, 개발에서만 켜져요', () => {
    expect(LEAVE_IN_APP_BLOCKED).toBe('앱 안 휴가 결재는 팀장 단계를 더하기 전까지 운영에서 켤 수 없어요');
    const demo = { NODE_ENV: 'production', DESK_MOCK_LOGIN: 'true', PUBLIC_BASE_URL: 'https://demo.example.com', ...secrets };
    expect(problemsOf({ ...demo, DESK_LEAVE_IN_APP: 'true' })).toContain(LEAVE_IN_APP_BLOCKED);
    const prod = {
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://desk.example.com',
      DATABASE_URL: 'postgres://desk@db.example.com/desk',
      TRUST_PROXY: '10.0.3.11',
      DESK_IDP: 'keycloak',
      DESK_IDP_ISSUER: 'https://idp.example.com/realms/desk',
      DESK_IDP_CLIENT_SECRET: 'c'.repeat(40),
      DESK_IDP_DIRECTORY_CLIENT_SECRET: 'd'.repeat(40),
      ...secrets,
    };
    expect(problemsOf({ ...prod, DESK_LEAVE_IN_APP: 'true' })).toContain(LEAVE_IN_APP_BLOCKED);
    expect(loadConfig(prod).leaveInApp).toBe(false);
    expect(loadConfig(demo).leaveInApp).toBe(false);
    expect(loadConfig({}).leaveInApp).toBe(false);
    expect(loadConfig({ DESK_LEAVE_IN_APP: 'true' }).leaveInApp).toBe(true);
  });
});
