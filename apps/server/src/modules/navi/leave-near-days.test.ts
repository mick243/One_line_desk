import type { AskResponse, Card, CardAction } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AiGateway, type LlmProvider, type ProviderResult, type StructuredRequest } from '../../core/ai/gateway';
import { createTestApp, MOCK } from '../../testing';
import { readEventDates, readPlanDates, readSickDates, ruleLeaveQuestion } from './leave';

// 후보 6(11/17): 연차·반차 질문의 "오늘·내일·모레·글피"를 규칙으로 읽어요. 모델 스키마는 그대로이고 모델을 새로 부르지 않아요.
// 읽은 날은 다른 날짜 말과 같은 범위·근무 달력·쉬는 날 검사를 지나요. 병가·공가·경조 쪽 읽기는 바꾸지 않아요.
// 시험 시계는 2026-10-26(월) 09:00이에요. 내일 10/27(화) · 모레 10/28(수) · 글피 10/29(목). 자료는 모두 가상이에요(등급 0).

const TODAY = '2026-10-26';
const NEAR = { 내일: '2026-10-27', 모레: '2026-10-28', 글피: '2026-10-29' } as const;

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

/** 게이트웨이가 공급자에 넘긴 입력을 적어 두는 시험용 공급자(실제 모델 흉내, 답은 결정적 대안) */
class RecordingProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly inputs: { purpose: string; input: string }[] = [];
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    this.inputs.push({ purpose: req.purpose, input: req.input });
    return { output: req.schema.parse(req.fallback()), inputTokens: 1, outputTokens: 1 };
  }
}

async function setup(o: Parameters<typeof createTestApp>[0] = {}) {
  const t = await createTestApp({ leaveInApp: false, ...o });
  opened.push(t);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 1000 });
  for (const kind of ['rooms', 'navi', 'notices'] as const) await t.modules.find((m) => m.kind === kind)!.seed!();
  return t;
}

const field = (card: Card | undefined, name: string) => card?.fields.find((f) => f.name === name)?.value;
const askNavi = async (me: Session, text: string) => ((await me.call('POST', '/api/ask', { text, kind: 'navi' })).body as AskResponse).cards;
const checkCard = async (me: Session, text: string) => {
  const cards = await askNavi(me, text);
  expect(
    cards.map((c) => c.id),
    text,
  ).toEqual(['navi-leave-check']);
  return cards[0]!;
};
/** 카드에서 사람이 읽는 것(머리·칸). 버튼 토큰은 요청마다 달라서 빼요. */
const shown = (card: Card) => ({ headline: card.headline, fields: card.fields });

describe('후보 6: 연차·반차 날짜 읽기에 "오늘·내일·모레·글피"를 더해요(규칙)', () => {
  it.each(Object.entries(NEAR))('[후보 6] "%s" × 연차·오전 반차·오후 반차를 날짜로 읽어요', (word, date) => {
    expect(ruleLeaveQuestion(`${word} 연차 쓰고 싶어`, TODAY)).toMatchObject({ about: true, planFull: 1, planHalf: 0, planDates: [date] });
    const am = ruleLeaveQuestion(`${word} 오전 반차 쓰고 싶어`, TODAY);
    expect(am).toMatchObject({ planFull: 0, planHalf: 1, planDates: [date], planPart: 'am' });
    const pm = ruleLeaveQuestion(`${word} 오후 반차`, TODAY);
    // "쓰고 싶어" 같은 말이 없으면(쓰려는 말 없음) 지금처럼 날을 읽지 않아요. 쓰려는 말이 있으면 읽어요.
    expect(pm.planDates).toEqual([]);
    expect(ruleLeaveQuestion(`${word} 오후 반차 쓸게요`, TODAY)).toMatchObject({ planFull: 0, planHalf: 1, planDates: [date], planPart: 'pm' });
    // 오전·오후를 말하지 않은 반차는 구분 없이 읽어요(양식·카드에서 사람이 골라요).
    const half = ruleLeaveQuestion(`${word} 반차 쓰면 몇 개 남아?`, TODAY);
    expect(half).toMatchObject({ planFull: 0, planHalf: 1, planDates: [date] });
    expect(half.planPart).toBeUndefined();
  });

  it('[후보 6] "오늘"도 읽고, "내일모레"는 모레 하루, "내일이랑 모레"는 이틀이에요', () => {
    expect(ruleLeaveQuestion('오늘 오후 반차 쓰고 싶어', TODAY)).toMatchObject({ planHalf: 1, planDates: [TODAY], planPart: 'pm' });
    expect(ruleLeaveQuestion('내일모레 연차 쓰면 몇 개 남아?', TODAY)).toMatchObject({ planFull: 1, planDates: [NEAR.모레] });
    expect(ruleLeaveQuestion('내일이랑 모레 연차 쓰면', TODAY)).toMatchObject({ planFull: 2, planDates: [NEAR.내일, NEAR.모레] });
    // 다른 날짜 말과 같이 써도 겹치지 않게 하나씩이에요.
    expect(ruleLeaveQuestion('내일이랑 11월 3일 연차 쓰면', TODAY)).toMatchObject({ planFull: 2, planDates: [NEAR.내일, '2026-11-03'] });
    // 일수를 따로 말했으면 일수가 먼저예요(지금 규칙 그대로).
    expect(ruleLeaveQuestion('내일 연차 하루 쓸게', TODAY)).toMatchObject({ planFull: 1, planDates: [NEAR.내일] });
  });

  it('[후보 6] 기간의 시작·끝·기준으로 쓴 말, 다른 낱말 속 글자는 날로 읽지 않아요', () => {
    // "내일부터 3일"은 지금처럼 일수 3일이고 날은 없어요.
    expect(ruleLeaveQuestion('내일부터 3일 연차 쓰면', TODAY)).toMatchObject({ planFull: 3, planDates: [] });
    expect(ruleLeaveQuestion('모레까지 연차 이틀 쓰면', TODAY)).toMatchObject({ planFull: 2, planDates: [] });
    expect(ruleLeaveQuestion('오늘 기준 연차 이틀 쓰면 몇 개 남아?', TODAY)).toMatchObject({ planFull: 2, planDates: [] });
    // "연차 낼게"의 "낼"(내다)은 내일이 아니에요. "내일배움카드"도 날이 아니에요.
    expect(ruleLeaveQuestion('연차 낼게요', TODAY).planDates).toEqual([]);
    expect(ruleLeaveQuestion('내일배움카드 교육이라 연차 쓰면', TODAY).planDates).toEqual([]);
    // 쓰려는 말이 없는 질문은 날을 읽지 않아요("오늘 연차 몇 개 남았어?").
    expect(ruleLeaveQuestion('오늘 연차 몇 개 남았어?', TODAY)).toMatchObject({ about: true, planFull: 0, planDates: [] });
  });

  it('[후보 6] 쉬는 날에 걸리면 다른 날짜 말과 같이 빼고 알려요(주말·공휴일·회사 휴일·주말 근무자)', () => {
    // 금요일(10/30)에 "내일"은 토요일, "모레"는 일요일, "글피"는 월요일이에요.
    const friday = '2026-10-30';
    expect(ruleLeaveQuestion('내일 연차 쓰고 싶어', friday)).toMatchObject({ planFull: 0, planDates: [], weekendSkipped: 1 });
    expect(ruleLeaveQuestion('모레 오후 반차 쓰고 싶어', friday)).toMatchObject({ planHalf: 1, planDates: [], weekendSkipped: 1 });
    expect(ruleLeaveQuestion('글피 연차 쓰고 싶어', friday)).toMatchObject({ planFull: 1, planDates: ['2026-11-02'], weekendSkipped: 0 });
    // 같은 날을 날짜로 말했을 때와 읽은 결과가 같아요.
    expect(ruleLeaveQuestion('내일 연차 쓰고 싶어', friday)).toEqual(ruleLeaveQuestion('10월 31일 연차 쓰고 싶어', friday));
    // 공휴일: 12/24(목)에 "내일"은 기독탄신일이에요.
    expect(ruleLeaveQuestion('내일 연차 쓰고 싶어', '2026-12-24')).toMatchObject({
      planFull: 0,
      planDates: [],
      holidaysSkipped: [{ date: '2026-12-25', name: '기독탄신일' }],
    });
    // 회사 휴일(운영 설정)
    expect(ruleLeaveQuestion('모레 오전 반차 쓰고 싶어', TODAY, { companyHolidays: [NEAR.모레] })).toMatchObject({
      planDates: [],
      holidaysSkipped: [{ date: NEAR.모레, name: '회사 휴일' }],
    });
    // 주말 근무자(화~토)는 토요일이 일하는 날이고 월요일이 쉬는 요일이에요.
    const tueToSat = { weekdays: [2, 3, 4, 5, 6] };
    expect(ruleLeaveQuestion('내일 연차 쓰고 싶어', friday, tueToSat)).toMatchObject({ planFull: 1, planDates: ['2026-10-31'] });
    expect(ruleLeaveQuestion('글피 연차 쓰고 싶어', friday, tueToSat)).toMatchObject({ planDates: [], weekendSkipped: 1 });
  });

  it('[후보 6] 병가·공가·경조 쪽 읽기는 그대로예요(가까운 날 말은 연차·반차 해석에서만 더 읽어요)', () => {
    // 공통 날짜 읽기는 옵션 없이 부르면 "내일·모레·글피"를 읽지 않아요(공가·병가·경조가 이렇게 불러요).
    expect(readPlanDates('내일 모레 글피 쉬어요', TODAY).dates).toEqual([]);
    expect(readPlanDates('내일 모레 글피 쉬어요', TODAY, {}, { nearDays: true }).dates).toEqual([NEAR.내일, NEAR.모레, NEAR.글피]);
    // 병가: 오늘·어제·그제만(지난 3일), 내일은 읽지 않아요.
    expect(readSickDates('내일 병가 쓸게요', TODAY)).toEqual([]);
    expect(readSickDates('오늘 병가 쓸게요', TODAY)).toEqual([TODAY]);
    // 경조: 오늘·내일·모레를 읽고 글피는 읽지 않아요.
    expect(readEventDates('내일 장례식이라 쉬어야 해', TODAY)).toEqual([NEAR.내일]);
    expect(readEventDates('글피 결혼식이라 휴가 신청할게', TODAY)).toEqual([]);
  });
});

describe('후보 6: 신청 전 카드·양식에 읽은 날이 채워져요', () => {
  it('[후보 6] "내일 연차 쓰고 싶어"·"모레 오후 반차"·"글피 오전 반차"가 신청 전 카드의 쓸 날·남은 연차·링크에 들어가요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);

    const full = await checkCard(doyun, '내일 연차 쓰고 싶어');
    expect(full.headline).toBe('10월 27일(화) 하루 쓰면 남은 연차는 6.5일이에요');
    expect(field(full, '쓸 날')).toBe('10월 27일(화) 하루');
    expect(field(full, '남은 연차')).toBe('7.5일 → 6.5일');
    // 날짜로 말했을 때와 같은 카드예요.
    expect(shown(full)).toEqual(shown(await checkCard(doyun, '10월 27일 연차 쓰고 싶어')));

    const pm = await checkCard(doyun, '모레 오후 반차 쓰고 싶어');
    expect(pm.headline).toBe('10월 28일(수) 오후 반차 쓰면 남은 연차는 7일이에요');
    expect(field(pm, '남은 연차')).toBe('7.5일 → 7일');
    expect(shown(pm)).toEqual(shown(await checkCard(doyun, '10월 28일 오후 반차 쓰고 싶어')));

    const am = await checkCard(doyun, '글피 오전 반차 쓸게요');
    expect(am.headline).toBe('10월 29일(목) 오전 반차 쓰면 남은 연차는 7일이에요');

    // AI 정리 표시는 없어요(규칙이 읽었어요).
    for (const card of [full, pm, am]) expect(card.evidence.aiSummarized).toBe(false);
  });

  it('[후보 6] 쉬는 날에 걸리면 날짜로 말했을 때와 같은 안내예요(주말·회사 휴일)', async () => {
    // 금요일(10/30) 09:00에 "내일"은 토요일(10/31)이에요.
    const t = await setup({ start: Date.parse('2026-10-30T09:00:00+09:00') });
    const doyun = await t.loginAs(MOCK.dev);
    const weekend = await checkCard(doyun, '내일 연차 쓰고 싶어');
    expect(shown(weekend)).toEqual(shown(await checkCard(doyun, '10월 31일 연차 쓰고 싶어')));
    expect(field(weekend, '남은 연차')).toBe('7.5일 → 7.5일');
    expect(JSON.stringify(shown(weekend))).toContain('주말');

    // 글피(11/2, 월)가 회사 휴일이면 "쉬는 날" 줄로 알려요.
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/holidays', { dates: ['2026-11-02'] })).status).toBe(200);
    const holiday = await checkCard(doyun, '글피 연차 쓰고 싶어');
    expect(field(holiday, '쉬는 날')).toBe('11월 2일(월) 회사 휴일 · 공휴일·회사 휴일이라 연차로 세지 않았어요');
    expect(shown(holiday)).toEqual(shown(await checkCard(doyun, '11월 2일 연차 쓰고 싶어')));
  });

  it('[후보 6] 앱 안 휴가 양식(개발·시험 전용)에도 읽은 날과 오전·오후가 미리 채워져요', async () => {
    const t = await setup({ leaveInApp: true });
    const doyun = await t.loginAs(MOCK.dev);
    const cards = await askNavi(doyun, '모레 오전 반차 쓰고 싶어');
    const action = cards
      .flatMap((c) => c.actions.secondary)
      .find((a): a is Extract<CardAction, { type: 'leave-request' }> => a.type === 'leave-request' && a.text === '휴가 신청하기')!;
    expect(action.days).toEqual([{ date: NEAR.모레, kind: 'half', half: 'am' }]);
  });

  it('[후보 6][ADR-18 시험] 가까운 날 말은 규칙이 읽어서 휴가 해석 모델 호출이 0건이에요(쉬는 날에 걸려도)', async () => {
    const provider = new RecordingProvider();
    const t = await setup({ provider });
    t.ctx.gateway = new AiGateway(provider, true, t.db);
    const doyun = await t.loginAs(MOCK.dev);
    for (const text of ['내일 연차 쓰고 싶어', '모레 오후 반차 쓰고 싶어', '글피 오전 반차 쓸게요', '오늘 반차 쓰고 싶어']) await checkCard(doyun, text);
    expect(provider.inputs.filter((i) => i.purpose === 'leave-question')).toEqual([]);

    // 토요일에 걸린 "내일"도 규칙 결과 그대로예요(모델이 일수로 다시 세지 않아요).
    const friday = await setup({ provider, start: Date.parse('2026-10-30T09:00:00+09:00') });
    friday.ctx.gateway = new AiGateway(provider, true, friday.db);
    await checkCard(await friday.loginAs(MOCK.dev), '내일 연차 쓰고 싶어');
    expect(provider.inputs.filter((i) => i.purpose === 'leave-question')).toEqual([]);
  });
});
