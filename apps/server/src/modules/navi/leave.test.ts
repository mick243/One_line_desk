import type { AskResponse, Card } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockAdapters } from '../../adapters';
import { OffLeave } from '../../adapters/off';
import type { LeaveUse } from '../../adapters/types';
import { AiGateway, type LlmProvider, type ProviderResult, type StructuredRequest } from '../../core/ai/gateway';
import { createTestApp, MOCK } from '../../testing';
import { computeLeave, ruleLeaveQuestion } from './leave';

// 담당 찾기 "내 남은 연차"(ADR-18). 숫자는 서버 규칙, AI는 질문 해석만, 본인 것만이에요.
// 시험 시계는 2026-10-26(월)이에요. 가상 연차 자료는 adapters/mock/leave.ts예요.

const TODAY = '2026-10-26';
const use = (date: string, kind: LeaveUse['kind'] = 'full'): LeaveUse => ({ date, kind });

describe('연차 계산(근로기준법, 입사일 기준)', () => {
  it.each([
    ['입사 10개월(개근한 달마다 1일)', '2025-12-01', 10, true, '2025-12-01', '2026-11-30'],
    ['1년이 되기 하루 전(최대 11일)', '2025-10-27', 11, true, '2025-10-27', '2026-10-26'],
    ['딱 1년', '2025-10-26', 15, false, '2026-10-26', '2027-10-25'],
    ['2년', '2024-10-26', 15, false, '2026-10-26', '2027-10-25'],
    ['3년(1일 더)', '2023-10-26', 16, false, '2026-10-26', '2027-10-25'],
    ['4년', '2022-10-26', 16, false, '2026-10-26', '2027-10-25'],
    ['5년', '2021-10-26', 17, false, '2026-10-26', '2027-10-25'],
    ['21년(최대 25일)', '2005-06-07', 25, false, '2026-06-07', '2027-06-06'],
    ['36년(25일에서 멈춤)', '1990-03-02', 25, false, '2026-03-02', '2027-03-01'],
  ] as const)('%s', (_name, hireDate, granted, firstYear, start, end) => {
    const b = computeLeave({ hireDate, uses: [] }, TODAY);
    expect(b).toMatchObject({ granted, firstYear, periodStart: start, periodEnd: end, used: 0, remaining: granted });
  });

  it('2월 29일 입사는 평년에 2월 28일을 기념일로 봐요', () => {
    expect(computeLeave({ hireDate: '2024-02-29', uses: [] }, '2025-02-28')).toMatchObject({ years: 1, granted: 15, periodStart: '2025-02-28' });
    expect(computeLeave({ hireDate: '2024-02-29', uses: [] }, '2025-02-27')).toMatchObject({ years: 0, granted: 11 });
  });

  it('이번 연차 기간 안의 쓴 날만 세고, 반차는 0.5일, 예정된 날도 넣어요', () => {
    const uses = [use('2026-02-13'), use('2026-04-10'), use('2026-05-22', 'half'), use('2026-09-18', 'half'), use('2026-11-06'), use('2027-03-04')];
    expect(computeLeave({ hireDate: '2019-03-04', uses }, TODAY)).toMatchObject({
      years: 7,
      granted: 18,
      usedFull: 2,
      usedHalf: 2,
      used: 3,
      remaining: 15,
    });
  });
});

describe('휴가 질문 해석(규칙, 무보관 계약 전)', () => {
  it.each([
    ['휴가 신청 어디서 해요', true, 0, 0],
    ['내 연차 몇 일 남았어요?', true, 0, 0],
    ['반차 3번 쓰면 몇 일 남아요?', true, 0, 3],
    ['다음 주에 연차 이틀 쓰고 반차 한 번 쓰면?', true, 2, 1],
    ['3일 휴가 내면 남는 게 있어요?', true, 3, 0],
    ['연차 15일 맞나요?', true, 0, 0],
    ['육아휴직 신청은 어디서 해요', false, 0, 0],
    ['출산휴가 서류는 어디에 내요?', false, 0, 0],
    ['법인카드 잃어버렸어요', false, 0, 0],
  ] as const)('%s', (text, about, planFull, planHalf) => {
    expect(ruleLeaveQuestion(text)).toEqual({ about, planFull, planHalf });
  });
});

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup(opts: Parameters<typeof createTestApp>[0] = {}) {
  const t = await createTestApp(opts);
  opened.push(t);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 10_000 });
  await t.modules.find((m) => m.kind === 'navi')!.seed!();
  return t;
}

async function askAs(t: TestApp, subject: string, text: string): Promise<Card[]> {
  const me = await t.loginAs(subject);
  const res = await me.call('POST', '/api/ask', { text, kind: 'navi' });
  expect(res.status, text).toBe(200);
  return (res.body as AskResponse).cards;
}

const myLeave = (cards: Card[]) => cards.find((c) => c.id === 'navi-my-leave');
const field = (card: Card | undefined, name: string) => card?.fields.find((f) => f.name === name)?.value;

describe('담당 찾기 답에 붙는 내 남은 연차(ADR-18)', () => {
  it('휴가를 물으면 담당 카드 뒤에 본인 연차 카드가 붙고, 사람마다 자기 숫자만 봐요', async () => {
    const t = await setup();
    const haneul = await askAs(t, MOCK.staff, '휴가 신청 어디서 해요');
    expect(haneul[0]).toMatchObject({ id: 'navi-HR-02', kind: 'navi' });
    const card = myLeave(haneul);
    expect(card).toMatchObject({ kind: 'navi', label: '안내', headline: '남은 연차는 10일이에요', evidence: { aiSummarized: false } });
    expect(field(card, '반차로 쓰면')).toBe('20번');
    expect(field(card, '이번 연차 기간')).toBe('2026-03-04 ~ 2027-03-03');
    expect(field(card, '생긴 연차')).toBe('18일 (근속 7년)');
    expect(field(card, '쓴 연차(예정 포함)')).toBe('8일 · 하루 7번, 반차 2번');
    expect(card!.tail).toContain('나에게만 보여요');

    const doyun = myLeave(await askAs(t, MOCK.dev, '휴가 신청 어디서 해요'));
    expect(doyun).toMatchObject({ headline: '남은 연차는 7.5일이에요' });
    expect(field(doyun, '생긴 연차')).toBe('10일 (입사 1년 미만, 개근한 달마다 1일)');
    // 응답에는 이름·메일·쓴 날짜가 없어요(1년 미만은 연차 기간이 입사일부터라 그 날짜는 본인 카드에 보여요).
    expect(JSON.stringify(doyun)).not.toMatch(/도윤|doyun|2026-03-13|2026-08-14|@/);
  });

  it('"반차 3번 쓰면?"처럼 더 쓰려는 양을 물으면 그만큼 뺀 숫자도 알려 줘요', async () => {
    const t = await setup();
    const card = myLeave(await askAs(t, MOCK.dev, '반차 3번 쓰면 연차 몇 일 남아요?'));
    expect(field(card, '반차 3번을 더 쓰면')).toBe('6일 남아요');
    const over = myLeave(await askAs(t, MOCK.dev, '다음 달에 휴가 9일 쓰면 남아요?'));
    expect(field(over, '연차 9일을 더 쓰면')).toBe('1.5일 모자라요');
  });

  it('휴가가 아닌 질문, 육아휴직·출산휴가 질문에는 붙지 않아요', async () => {
    const t = await setup();
    for (const text of ['법인카드 잃어버렸어요', '육아휴직 신청은 어디서 해요', '명함 새로 만들고 싶어요']) {
      expect(myLeave(await askAs(t, MOCK.dev, text)), text).toBeUndefined();
    }
  });

  it('근태 시스템이 연결되지 않았으면 숫자 대신 확인하는 곳을 알려 줘요', async () => {
    const t = await setup({ adapters: { ...createMockAdapters(), leave: new OffLeave() } });
    const card = myLeave(await askAs(t, MOCK.dev, '내 연차 몇 일 남았어요?'));
    expect(card).toMatchObject({ headline: '남은 연차를 불러오지 못했어요', fields: [{ name: '확인하는 곳', value: '그룹웨어 근태 메뉴' }] });
  });

  it('무보관 계약 뒤 AI가 질문을 해석해도, 모델에는 질문 글만 가고 연차 자료는 가지 않아요', async () => {
    const calls: { purpose: string; input: string }[] = [];
    const provider: LlmProvider = {
      name: 'anthropic',
      async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
        calls.push({ purpose: req.purpose, input: req.input });
        // 모델 흉내: 해석은 "반차 2번", 나머지 목적은 결정적 대안이에요.
        const reply = req.purpose === 'leave-question' ? { aboutAnnualLeave: true, planFullDays: 0, planHalfDays: 2 } : req.fallback();
        return { output: req.schema.parse(reply), inputTokens: 1, outputTokens: 1 };
      },
    };
    const t = await setup({ provider });
    t.ctx.gateway = new AiGateway(provider, true, t.db);
    const card = myLeave(await askAs(t, MOCK.dev, '다음 주에 오후 반차 두 번 쓰려는데 괜찮을까요?'));
    expect(field(card, '반차 2번을 더 쓰면')).toBe('6.5일 남아요');
    expect(card!.evidence.aiSummarized).toBe(true);

    const leaveCalls = calls.filter((c) => c.purpose === 'leave-question');
    expect(leaveCalls).toEqual([{ purpose: 'leave-question', input: '질문: 다음 주에 오후 반차 두 번 쓰려는데 괜찮을까요?' }]);
    const sent = calls.map((c) => c.input).join('\n');
    expect(sent).not.toMatch(/2025-12-01|2026-03-13|7\.5|doyun|도윤/);
  });
});
