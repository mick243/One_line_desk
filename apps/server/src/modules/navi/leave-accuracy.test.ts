import {
  type AskResponse,
  type Card,
  type CardAction,
  type HomeAskResponse,
  holidayYearKnown,
  type InquiryListResponse,
  isWeekend,
  isWorkday,
  LEAVE_HOURS_TEXT,
  LEAVE_NOT_CONNECTED_TEXT,
  LEAVE_SMALL_WORKPLACE_TEXT,
  LEAVE_STATUS_NOT_CONNECTED_TEXT,
  publicHolidayName,
  splitWorkdays,
} from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockAdapters } from '../../adapters';
import { leaveRecordsFromJson, MOCK_LEAVE_RECORDS, MockLeave } from '../../adapters/mock/leave';
import { OffLeave } from '../../adapters/off';
import type { LeaveRecord } from '../../adapters/types';
import { AiGateway, type LlmProvider, type ProviderResult, type StructuredRequest } from '../../core/ai/gateway';
import type { DeskUser } from '../../core/user';
import { draftDays, offDaysText } from '../../routes/demo-groupware';
import { createTestApp, MOCK } from '../../testing';
import { leaveCheckForLink, leaveRequestBalance, ruleLeaveQuestion } from './leave';
import { freeDaysNear, leaveHourCopyText } from './leave-handoff';
import { computeLeave, DEFAULT_LEAVE_POLICY, leaveNumbers, leavePolicy } from './leave-numbers';
import { checkLeaveLink } from './mcp-read';

// 휴가 정확도 고치기 1~4(11/6, ADR-18 개정·ADR-24 보강). 시험 이름 앞 [정확도-…]는 PRD "휴가 완료 기준" 줄이에요.
// 시험 시계는 2026-10-26(월) 09:00이에요. 앱 안 휴가 결재는 꺼진 채(운영 기본, A안)로 돌아요.
// 하늘(앱 계산): 남은 10일 · 이번 기간 2026-03-04 ~ 2027-03-03. 도윤(앱 계산, 입사 1년 미만): 남은 7.5일 · ~2026-11-30.
// 서연(근태 숫자, 입사일 기준): 남은 15.5일 · ~2027-06-30. 지우(근태 숫자, 회계연도): 남은 12.5일 · ~2026-12-31.

const TODAY = '2026-10-26';
const JIWOO = 'mock|emp-008';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

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
  expect(cards.map((c) => c.id)).toEqual(['navi-leave-check']);
  return cards[0]!;
};
const balanceCard = async (me: Session, text = '내 연차 몇 개 남았어?') => (await askNavi(me, text)).find((c) => c.id === 'navi-my-leave')!;

/** 회의실을 잡아요(확인 시트). 회의실 이름을 돌려줘요. */
async function reserve(me: Session, text: string): Promise<string> {
  const asked = (await me.call('POST', '/api/ask', { text, kind: 'rooms' })).body as AskResponse;
  const card = asked.cards.find((c) => c.actions.primary?.type === 'propose')!;
  const plan = (await me.call('POST', '/api/plans', { proposalToken: (card.actions.primary as { proposalToken: string }).proposalToken })).body as {
    planId: string;
  };
  const done = (await me.call('POST', `/api/plans/${plan.planId}/confirm`)).body as { status: string; card: Card };
  expect(done.status).toBe('done');
  return (done.card.actions.primary as { roomName: string }).roomName;
}

describe('① 공휴일 달력(packages/shared holidays.ts)', () => {
  it('[정확도-공휴일표] 2026·2027 법정 공휴일·대체공휴일·노동절·제헌절·선거일이 있고, 표에 없는 해는 모른다고 해요', () => {
    expect(publicHolidayName('2026-12-25')).toBe('기독탄신일');
    expect(publicHolidayName('2026-02-17')).toBe('설날');
    expect(publicHolidayName('2026-05-01')).toBe('노동절');
    expect(publicHolidayName('2026-06-03')).toBe('전국동시지방선거일');
    expect(publicHolidayName('2026-07-17')).toBe('제헌절');
    expect(publicHolidayName('2026-10-05')).toBe('대체공휴일(개천절)');
    expect(publicHolidayName('2027-02-09')).toBe('대체공휴일(설날)');
    expect(publicHolidayName('2027-12-27')).toBe('대체공휴일(기독탄신일)');
    expect(publicHolidayName('2026-12-24')).toBeNull();
    expect(holidayYearKnown('2027-06-01')).toBe(true);
    expect(holidayYearKnown('2028-01-03')).toBe(false);
    // 회사 휴일(운영 설정)도 쉬는 날이에요.
    expect(isWorkday('2026-11-20')).toBe(true);
    expect(isWorkday('2026-11-20', { companyHolidays: ['2026-11-20'] })).toBe(false);
    expect(splitWorkdays(['2026-12-24', '2026-12-25', '2026-12-26', '2028-01-03'])).toEqual({
      workdays: ['2026-12-24', '2028-01-03'],
      weekend: 1,
      holidays: [{ date: '2026-12-25', name: '기독탄신일' }],
      unknownYears: [2028],
    });
  });

  it('[정확도-공휴일읽기] "12월 24~26일"은 연차 1일(12/25 기독탄신일·12/26 토요일 뺌), 설 연휴 주간은 대체공휴일까지 빼요', () => {
    for (const text of ['12월 24~26일 연차 쓰면 몇 개 남아?', '12월 24일부터 26일까지 연차 쓰면 몇 개 남아?']) {
      const q = ruleLeaveQuestion(text, TODAY);
      expect({ full: q.planFull, dates: q.planDates, weekend: q.weekendSkipped, holidays: q.holidaysSkipped }, text).toEqual({
        full: 1,
        dates: ['2026-12-24'],
        weekend: 1,
        holidays: [{ date: '2026-12-25', name: '기독탄신일' }],
      });
    }
    const lunar = ruleLeaveQuestion('2월 8일부터 12일까지 연차 쓰면', TODAY);
    expect(lunar).toMatchObject({ planFull: 3, planDates: ['2027-02-10', '2027-02-11', '2027-02-12'] });
    expect(lunar.holidaysSkipped).toEqual([
      { date: '2027-02-08', name: '설날 연휴' },
      { date: '2027-02-09', name: '대체공휴일(설날)' },
    ]);
    // 회사 휴일(운영 설정)도 빼요.
    expect(ruleLeaveQuestion('11월 19일부터 20일까지 연차 쓰면', TODAY, { companyHolidays: ['2026-11-20'] })).toMatchObject({
      planFull: 1,
      holidaysSkipped: [{ date: '2026-11-20', name: '회사 휴일' }],
    });
  });

  it('[정확도-공휴일카드] 신청 전 카드는 공휴일을 세지 않고 "쉬는 날" 줄로 알려요(12/24~26 → 1일, 설 연휴 주간 → 3일)', async () => {
    const t = await setup();
    const haneul = await t.loginAs(MOCK.staff);
    const xmas = await checkCard(haneul, '12월 24일부터 26일까지 연차 쓰고 싶어');
    expect(xmas.headline).toBe('12월 24일(목) 하루 쓰면 남은 연차는 9일이에요');
    expect(field(xmas, '쓸 날')).toBe('12월 24일(목) 하루 (주말은 뺐어요)');
    expect(field(xmas, '쉬는 날')).toBe('12월 25일(금) 기독탄신일 · 공휴일·회사 휴일이라 연차로 세지 않았어요');
    expect(field(xmas, '남은 연차')).toBe('10일 → 9일');

    const lunar = await checkCard(haneul, '2월 8일부터 12일까지 연차 쓰고 싶어');
    expect(field(lunar, '남은 연차')).toBe('10일 → 7일');
    expect(field(lunar, '쉬는 날')).toBe('2월 8일(월) 설날 연휴 · 2월 9일(화) 대체공휴일(설날) · 공휴일·회사 휴일이라 연차로 세지 않았어요');
    expect(lunar.actions.primary).toMatchObject({ href: expect.stringContaining('from=2027-02-10&to=2027-02-12') });

    // 공휴일만 말했으면 쓸 날이 없어요(모델도 부르지 않아요).
    const only = await checkCard(haneul, '12월 25일 연차 쓰고 싶어');
    expect(only.headline).toBe('남은 연차는 10일이에요');
    expect(field(only, '쉬는 날')).toContain('12월 25일(금) 기독탄신일');
    expect(field(only, '남은 연차')).toBe('10일 → 10일');
  });

  it('[정확도-제안] 걸린 일이 없는 날 제안은 공휴일·주말을 고르지 않아요(12/24에 일이 있으면 12/23·12/28)', () => {
    const slot = { start: Date.parse('2026-12-24T14:00:00+09:00'), end: Date.parse('2026-12-24T15:00:00+09:00'), room: '가상 회의실', own: true };
    expect(freeDaysNear({ date: '2026-12-24', kind: 'full' }, [slot], [], new Set(['2026-12-24']), TODAY)).toEqual(['2026-12-23', '2026-12-28']);
    // 회사 휴일(12/28)도 빼요.
    expect(freeDaysNear({ date: '2026-12-24', kind: 'full' }, [slot], [], new Set(['2026-12-24']), TODAY, { companyHolidays: ['2026-12-28'] })).toEqual([
      '2026-12-23',
      '2026-12-29',
    ]);
  });

  it('[정확도-MCP·가상그룹웨어] MCP 휴가 준비·[이 날로 보기]는 공휴일을 받지 않고, 가상 그룹웨어 신청서는 공휴일을 빼고 세요', () => {
    expect(checkLeaveLink({ type: 'annual', days: [{ date: '2026-12-25', kind: 'full' }] }, TODAY)).toEqual({
      ok: false,
      code: 'holiday',
      message: '12월 25일(금)은 쉬는 날이에요(기독탄신일)',
    });
    expect(checkLeaveLink({ type: 'annual', days: [{ date: '2026-11-20', kind: 'full' }] }, TODAY, { companyHolidays: ['2026-11-20'] })).toMatchObject({
      code: 'holiday',
    });
    expect(draftDays({ type: 'annual', from: '2026-12-24', to: '2026-12-28', half: 'full' }, TODAY).map((d) => d.date)).toEqual(['2026-12-24', '2026-12-28']);
    expect(() => draftDays({ type: 'annual', from: '2026-12-25', to: '2026-12-27', half: 'full' }, TODAY)).toThrow(
      '고른 날이 모두 주말·쉬는 날(공휴일·회사 휴일)이에요',
    );
    expect(
      draftDays({ type: 'annual', from: '2026-11-19', to: '2026-11-20', half: 'full' }, TODAY, { companyHolidays: ['2026-11-20'] }).map((d) => d.date),
    ).toEqual(['2026-11-19']);
  });

  it('[정확도-회사휴일] 운영자가 회사 휴일 날짜를 넣으면 날 세기·제안·[이 날로 보기]에서 빠져요. 날짜만 받고 감사에는 개수만 남아요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    const staff = await t.loginAs(MOCK.staff);
    expect((await staff.call('PUT', '/api/ops/holidays', { dates: ['2026-10-28'] })).status).toBe(403);
    expect((await op.call('PUT', '/api/ops/holidays', { dates: ['2026-02-30'] })).status).toBe(400);
    expect((await op.call('PUT', '/api/ops/holidays', { dates: ['창립기념일'] })).status).toBe(400);
    expect((await op.call('PUT', '/api/ops/holidays', { dates: ['2026-11-20', '2026-10-28', '2026-10-28'] })).status).toBe(200);
    expect(t.ctx.ops.get().companyHolidays).toEqual(['2026-10-28', '2026-11-20']);
    const audit = (await t.db.query<{ action: string; result: string }>("select action, result from audit_log where action = 'companyHolidays.set'")).rows;
    expect(audit).toEqual([{ action: 'companyHolidays.set', result: '2' }]);

    const doyun = await t.loginAs(MOCK.dev);
    const room = await reserve(doyun, '10월 27일 3시 4명 회의실');
    const card = await checkCard(doyun, '10월 27일 연차 쓰고 싶어');
    expect(field(card, '그날 내 일정')).toContain(room);
    // 10/28(수)은 회사 휴일이라 고르지 않고 10/29(목)를 제안해요.
    expect(field(card, '걸린 일이 없는 가까운 날')).toBe('10/26(월) · 10/29(목)');
    const holiday = await checkCard(doyun, '10월 28일 연차 쓰고 싶어');
    expect(field(holiday, '쉬는 날')).toBe('10월 28일(수) 회사 휴일 · 공휴일·회사 휴일이라 연차로 세지 않았어요');
    const again = await doyun.call('POST', '/api/navi/leave/check', { type: 'annual', days: [{ date: '2026-10-28', kind: 'full' }] });
    expect(again).toMatchObject({ status: 400, body: { message: '10월 28일(수)은 쉬는 날이에요(회사 휴일)' } });
    // 빈 목록이면 지워요.
    expect((await op.call('PUT', '/api/ops/holidays', { dates: [] })).status).toBe(200);
    expect(t.ctx.ops.get().companyHolidays).toEqual([]);
  });

  it('[정확도-모의자료] 시연 가상 근태 자료에는 공휴일·주말 연차가 0건이고, 모든 쓰기에 종류가 있어요', () => {
    const bad = Object.entries(MOCK_LEAVE_RECORDS).flatMap(([email, r]) =>
      r.uses.filter((u) => u.type === 'annual' && (publicHolidayName(u.date) || isWeekend(u.date))).map((u) => `${email} ${u.date}`),
    );
    expect(bad).toEqual([]);
    const untyped = Object.values(MOCK_LEAVE_RECORDS).flatMap((r) => r.uses.filter((u) => !u.type));
    expect(untyped).toEqual([]);
  });
});

describe('② 날짜·양 읽기: 시간 단위', () => {
  it('[정확도-시간읽기] "연차 2시간"·"3시간만"·"반반차"는 날이 아니라 시간으로 읽어요', () => {
    const read = (text: string) => {
      const q = ruleLeaveQuestion(text, TODAY);
      return { full: q.planFull, half: q.planHalf, hours: q.planHours };
    };
    expect(read('연차 2시간 쓰면 몇 개 남아?')).toEqual({ full: 0, half: 0, hours: 2 });
    expect(read('연차 3시간만 쓰고 싶어')).toEqual({ full: 0, half: 0, hours: 3 });
    expect(read('연차 12시간 쓰면')).toEqual({ full: 0, half: 0, hours: 12 });
    expect(read('두 시간 연차 쓰려고')).toEqual({ full: 0, half: 0, hours: 2 });
    expect(read('반반차 쓰면 몇 개 남아?')).toEqual({ full: 0, half: 0, hours: 2 });
    expect(read('반반차 두 번 쓰면')).toEqual({ full: 0, half: 0, hours: 4 });
    // 예전 읽기는 그대로예요.
    expect(read('연차 2일 쓰면')).toEqual({ full: 2, half: 0, hours: 0 });
    expect(read('반차 2번 쓰면')).toEqual({ full: 0, half: 2, hours: 0 });
    // 날짜와 같이 말해도 날 수로 바꾸지 않아요.
    expect(ruleLeaveQuestion('11월 4일 반반차 쓰고 싶어', TODAY)).toMatchObject({ planFull: 0, planHalf: 0, planHours: 2, planDates: ['2026-11-04'] });
  });

  it('[정확도-시간카드] 카드는 "2시간(0.25일, 하루 8시간 기준)"과 시간 단위 안내를 보여요. 하루 근로시간은 운영 값이에요', async () => {
    const t = await setup();
    const haneul = await t.loginAs(MOCK.staff);
    const card = await checkCard(haneul, '연차 2시간 쓰고 싶어');
    expect(card.headline).toBe('연차 2시간(0.25일) 쓰면 남은 연차는 9.75일이에요');
    expect(field(card, '쓸 날')).toBe('2시간(0.25일, 하루 8시간 기준)');
    expect(field(card, '시간 단위')).toBe(LEAVE_HOURS_TEXT);
    expect(field(card, '남은 연차')).toBe('10일 → 9.75일');

    const dated = await checkCard(haneul, '11월 4일 반반차 쓰고 싶어');
    expect(field(dated, '쓸 날')).toBe('11월 4일(수) 2시간(0.25일, 하루 8시간 기준)');
    expect(dated.actions.secondary).toContainEqual({
      type: 'copy',
      text: '신청 내용 복사',
      value: '휴가 종류: 연차(시간 단위)\n날짜: 11/4(수)\n시간: 하루 2시간(0.25일)\n사유: 그룹웨어 신청서에 직접 적어 주세요',
    });
    expect(dated.actions.primary).toMatchObject({ href: expect.stringContaining('type=annual&from=2026-11-04&to=2026-11-04&half=') });

    // 여러 날에 시간으로 말하면 날마다 그 시간이에요(11/6): 복사 글 "하루 2시간"과 남은 연차 차감(2시간 × 2일 = 0.5일)이 같아요.
    expect(ruleLeaveQuestion('11월 4일부터 5일까지 연차 2시간씩 쓰고 싶어', TODAY)).toMatchObject({ planHours: 4, planDates: ['2026-11-04', '2026-11-05'] });
    const twoDays = await checkCard(haneul, '11월 4일부터 5일까지 연차 2시간씩 쓰고 싶어');
    expect(field(twoDays, '쓸 날')).toBe('11월 4일(수) · 11월 5일(목) 날마다 2시간 · 모두 4시간(0.5일, 하루 8시간 기준)');
    expect(field(twoDays, '남은 연차')).toBe('10일 → 9.5일');
    expect(twoDays.actions.secondary).toContainEqual({
      type: 'copy',
      text: '신청 내용 복사',
      value: '휴가 종류: 연차(시간 단위)\n날짜: 11/4(수), 11/5(목)\n시간: 하루 2시간(0.25일)\n사유: 그룹웨어 신청서에 직접 적어 주세요',
    });

    t.ctx.ops.patchValues({ workdayHours: 4 });
    const four = await checkCard(haneul, '연차 2시간 쓰고 싶어');
    expect(field(four, '쓸 날')).toBe('2시간(0.5일, 하루 4시간 기준)');
    expect(field(four, '남은 연차')).toBe('10일 → 9.5일');
    // 운영 값 범위(1~12시간)
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/values', { workdayHours: 0 })).status).toBe(400);
    expect((await op.call('PUT', '/api/ops/values', { workdayHours: 9 })).status).toBe(200);
  });

  it('[정확도-양] 근태 기록의 쓴 양(amountDays)이 있으면 그 양으로 세요(반반차 0.25일). 없으면 하루 1·반차 0.5 그대로예요', () => {
    const record: LeaveRecord = {
      hireDate: '2020-03-02',
      uses: [
        { date: '2026-04-01', kind: 'full', type: 'annual' },
        { date: '2026-04-02', kind: 'half', type: 'annual' },
        { date: '2026-04-03', kind: 'half', type: 'annual', amountDays: 0.25 },
      ],
    };
    expect(computeLeave(record, TODAY)).toMatchObject({ usedFull: 1, usedHalf: 1, usedOther: 1, used: 1.75 });
  });
});

describe('③ 근태 연결 계약과 숫자 우선순위', () => {
  it('[정확도-근태숫자] 근태 숫자가 있으면 그 숫자를 먼저 "근태 기록 기준"으로 보여 주고, 신청하면 그 숫자에서 빼요', async () => {
    const t = await setup();
    const seoyeon = await t.loginAs(MOCK.facilities);
    const card = await balanceCard(seoyeon);
    expect(card.headline).toBe('남은 연차는 15.5일이에요');
    expect(field(card, '계산 기준')).toBe('근태 기록 기준이에요. 결재 중인 신청은 반영하지 않았어요');
    expect(field(card, '생긴 연차')).toBe('18일 (근태 기록)');
    expect(field(card, '쓴 연차(예정 포함)')).toBe('2.5일 (근태 기록)');
    expect(field(card, '이번 연차 기간')).toBe('2026-07-01 ~ 2027-06-30');
    expect(field(card, '소멸일')).toBe('이번 연차는 2027년 6월 30일(수)까지예요');
    expect(card.evidence.text).toMatch(/^인사 근태 기록 기준/);

    const check = await checkCard(seoyeon, '11월 4일 연차 쓰고 싶어');
    expect(field(check, '남은 연차')).toBe('15.5일 → 14.5일');
    expect(field(check, '계산 기준')).toBe('근태 기록 기준이에요. 결재 중인 신청은 반영하지 않았어요');
    expect(field(check, '소멸일')).toBe('이번 연차는 2027년 6월 30일(수)까지예요');
    // 승인돼 근태에 들어가면 근태 숫자가 줄어요.
    await t.ctx.adapters.leave.recordUses({ idpSubject: MOCK.facilities, email: 'seoyeon@corp.example' }, [
      { date: '2026-11-04', kind: 'full', type: 'annual' },
    ]);
    expect((await balanceCard(seoyeon)).headline).toBe('남은 연차는 14.5일이에요');

    // 회계연도 기준: 기간 끝(12/31)이 소멸일이고, 다음 해 날은 다음 기간이라 숫자 없이 알려요(다음 기간 숫자는 근태 몫이에요).
    const jiwoo = await t.loginAs(JIWOO);
    const fiscal = await balanceCard(jiwoo);
    expect(fiscal.headline).toBe('남은 연차는 12.5일이에요');
    expect(field(fiscal, '이번 연차 기간')).toBe('2026-01-01 ~ 2026-12-31 (회계연도 기준)');
    expect(field(fiscal, '소멸일')).toBe('이번 연차는 12월 31일(목)까지예요');
    const nextYear = await checkCard(jiwoo, '1월 5일 연차 쓰고 싶어');
    expect(field(nextYear, '남은 연차')).toBe('12.5일 → 12.5일');
    expect(field(nextYear, '다음 연차 기간')).toBe('2027년 1월 1일(금)부터는 새 연차 기간이에요. 그 날은 이번 기간 연차에서 빼지 않았어요');
  });

  it('[정확도-앱계산] 근태 숫자가 없으면 앱이 센 것(입사일 기준·개근 가정)이라고 적고, 소멸일은 앱 계산 기간 끝이에요', async () => {
    const t = await setup();
    const haneul = await t.loginAs(MOCK.staff);
    const card = await balanceCard(haneul);
    expect(card.headline).toBe('남은 연차는 10일이에요');
    expect(field(card, '계산 기준')).toBe('근태 기록에 남은 연차 숫자가 없어 앱이 셌어요(입사일 기준·개근 가정). 결재 중인 신청은 반영하지 않았어요');
    expect(field(card, '소멸일')).toBe('이번 연차는 2027년 3월 3일(수)까지예요');
    expect(card.evidence.text).toContain('개근 가정');
    const check = await checkCard(haneul, '11월 4일 연차 쓰고 싶어');
    expect(field(check, '계산 기준')).toBe('근태 기록에 남은 연차 숫자가 없어 앱이 셌어요(입사일 기준·개근 가정). 결재 중인 신청은 반영하지 않았어요');
    expect(field(check, '소멸일')).toBe('이번 연차는 2027년 3월 3일(수)까지예요');
  });

  it('[정확도-종류없음] 종류를 모르는 근태 기록은 연차로 세지 않아요(상태 카드는 "휴가"로 보여요)', async () => {
    const record: LeaveRecord = {
      hireDate: '2020-03-02',
      uses: [
        { date: '2026-04-01', kind: 'full' },
        { date: '2026-04-02', kind: 'full', type: 'annual' },
      ],
    };
    expect(computeLeave(record, TODAY)).toMatchObject({ usedFull: 1, used: 1 });

    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    await t.ctx.adapters.leave.recordUses({ idpSubject: MOCK.dev, email: 'doyun@corp.example' }, [{ date: '2026-11-05', kind: 'full' }]);
    expect((await balanceCard(doyun)).headline).toBe('남은 연차는 7.5일이에요');
    const status = (await doyun.call('POST', '/api/home/ask', { text: '내 휴가 신청 어떻게 됐어?' })).body as HomeAskResponse;
    expect(status.cards.find((c) => c.id === 'navi-leave-status')!.headline).toBe('11월 5일(목) 휴가 하루가 승인됐어요');
  });

  it('[정확도-1년미만] 입사 1년 미만은 쓰려는 날까지 생기는 연차로 세요(오늘까지 생긴 연차로 세지 않아요)', async () => {
    const doyun = MOCK_LEAVE_RECORDS['doyun@corp.example']!;
    expect(computeLeave(doyun, TODAY)).toMatchObject({ granted: 10, remaining: 7.5 });
    expect(computeLeave(doyun, TODAY, { grantAsOf: '2026-11-03' })).toMatchObject({ granted: 11, remaining: 8.5, grantAsOf: '2026-11-03' });
    // 이번 기간 끝을 넘는 날은 기간 끝까지만 세요(최대 11일).
    expect(computeLeave(doyun, TODAY, { grantAsOf: '2027-02-01' })).toMatchObject({ granted: 11, grantAsOf: '2026-11-30' });
    // 1년 이상이면 바뀌지 않아요.
    const haneul = MOCK_LEAVE_RECORDS['haneul@corp.example']!;
    expect(computeLeave(haneul, TODAY, { grantAsOf: '2026-12-01' }).granted).toBe(18);

    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const card = await checkCard(me, '11월 3일 연차 쓰고 싶어');
    expect(field(card, '남은 연차')).toBe('7.5일 → 7.5일 (11월 3일(화)까지 1일이 더 생겨요)');
    expect(card.headline).toBe('11월 3일(화) 하루 쓰면 남은 연차는 7.5일이에요');
    // 오늘 안에 생긴 연차만으로 되는 날(10/27)은 그대로예요.
    expect(field(await checkCard(me, '10월 27일 연차 쓰고 싶어'), '남은 연차')).toBe('7.5일 → 6.5일');
  });

  it('[정확도-연결] 운영에서 근태가 "연결 안 함"이면 빈칸 대신 연결되지 않았다고 알려요(신청 전 카드·상태 카드)', async () => {
    const t = await setup({ adapters: { ...createMockAdapters(), leave: new OffLeave() } });
    const doyun = await t.loginAs(MOCK.dev);
    const card = await checkCard(doyun, '10월 27일 연차 쓰고 싶어');
    expect(card.headline).toBe('남은 연차를 보여 드릴 수 없어요');
    expect(field(card, '남은 연차')).toBe(LEAVE_NOT_CONNECTED_TEXT);
    expect(card.evidence.text).toBe('인사 근태 기록(연결 안 함)');
    expect(card.tail).toBe('아직 신청 전이에요. 그룹웨어에서 신청해야 결재가 시작돼요');
    const official = await checkCard(doyun, '10월 27일 예비군이라 공가 쓰려고');
    expect(field(official, '남은 연차')).toBe(LEAVE_NOT_CONNECTED_TEXT);
    const status = (await doyun.call('POST', '/api/home/ask', { text: '내 휴가 신청 어떻게 됐어?' })).body as HomeAskResponse;
    expect(status.cards.find((c) => c.id === 'navi-leave-status')!.headline).toBe(LEAVE_STATUS_NOT_CONNECTED_TEXT);
  });

  it('[정확도-앱계산 단위] 근태 숫자가 기간 밖이면(오래된 숫자) 앱 계산으로 돌아가요', () => {
    const record: LeaveRecord = {
      hireDate: '2020-03-02',
      uses: [],
      balance: { periodStart: '2025-01-01', periodEnd: '2025-12-31', remaining: 3 },
    };
    expect(leaveNumbers(record, TODAY)).toMatchObject({ source: 'app', remaining: 17 });
    expect(leaveNumbers({ ...record, balance: { periodStart: '2026-01-01', periodEnd: '2026-12-31', remaining: 3 } }, TODAY)).toMatchObject({
      source: 'hr',
      remaining: 3,
      granted: null,
    });
  });
});

describe('④ 병가·경조 연차 차감은 운영 값', () => {
  it('[정확도-병가경조] 기본은 연차와 따로 세고 "회사 규정에 따라 연차에서 빠질 수 있어요". 운영 값을 1로 하면 연차에서 빼요. 공가는 늘 그대로예요', async () => {
    const t = await setup();
    const haneul = await t.loginAs(MOCK.staff);
    const sickDefault = await checkCard(haneul, '오늘 몸살이라 병가 쓸래');
    expect(sickDefault.headline).toBe('병가는 연차와 따로 셌어요');
    expect(field(sickDefault, '연차 차감')).toBe('회사 규정에 따라 연차에서 빠질 수 있어요');
    expect(field(sickDefault, '계산 기준')).toBeUndefined();

    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/values', { sickLeaveFromAnnual: 2 })).status).toBe(400);
    expect((await op.call('PUT', '/api/ops/values', { sickLeaveFromAnnual: 1, eventLeaveFromAnnual: 1 })).status).toBe(200);
    // 하늘의 이번 기간 병가(9/7 반차)가 연차에서 빠져요: 10 → 9.5일.
    expect((await balanceCard(haneul)).headline).toBe('남은 연차는 9.5일이에요');
    const sick = await checkCard(haneul, '오늘 몸살이라 병가 쓸래');
    expect(sick.headline).toBe('10월 26일(월) 병가 하루 쓰면 남은 연차는 8.5일이에요');
    expect(field(sick, '남은 연차')).toBe('9.5일 → 8.5일');
    expect(field(sick, '연차 차감')).toBe('이 회사는 병가를 연차에서 빼요(운영 설정)');
    const event = await checkCard(haneul, '11월 4일 조문 가야 해서 쉬어야 해');
    expect(field(event, '남은 연차')).toBe('9.5일 → 8.5일');
    expect(field(event, '연차 차감')).toBe('이 회사는 경조를 연차에서 빼요(운영 설정)');
    const official = await checkCard(haneul, '11월 4일 예비군 훈련이라 공가 쓰려고');
    expect(official.headline).toBe('공가는 연차에서 빠지지 않아요');
    expect(field(official, '남은 연차')).toBe('9.5일 그대로예요(공가는 연차에서 빠지지 않아요)');
  });
});

// ── 11/6 사용자 결정(이어서): 5인 미만 사업장 · 공휴일 근무 · 주말 근무자 · 시간 옆 일 · 다음 기간 한 문장 ─────────────
// 날짜: 10/31(토) · 11/1(일) · 11/2(월) · 11/3(화). 하늘은 앱 계산 10일, 도윤은 앱 계산 7.5일(1년 미만), 서연은 근태 숫자 15.5일이에요.

/** 하늘만 주말 근무자(화~토 근무)로 둔 가상 근태 기록. 다른 사람은 그대로예요. */
const weekendWorkerLeave = () =>
  new MockLeave({ ...MOCK_LEAVE_RECORDS, 'haneul@corp.example': { ...MOCK_LEAVE_RECORDS['haneul@corp.example']!, workWeekdays: [2, 3, 4, 5, 6] } });
const TUE_TO_SAT = { weekdays: [2, 3, 4, 5, 6] };
const SMALL = { ...DEFAULT_LEAVE_POLICY, smallWorkplace: true };

describe('⑤ 5인 미만 사업장(운영 값 smallWorkplace)', () => {
  it('[정확도-5인미만] 근태 숫자가 없으면 앱이 법정 연차를 세지 않고 까닭만 보여요. 근태 숫자가 있으면 평소처럼 그 숫자예요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/values', { smallWorkplace: 2 })).status).toBe(400);
    expect((await op.call('PUT', '/api/ops/values', { smallWorkplace: 1 })).status).toBe(200);

    const haneul = await t.loginAs(MOCK.staff);
    const card = await balanceCard(haneul);
    expect(card.headline).toBe('남은 연차를 보여 드릴 수 없어요');
    expect(field(card, '남은 연차')).toBe(LEAVE_SMALL_WORKPLACE_TEXT);
    expect(field(card, '생긴 연차')).toBeUndefined();
    expect(field(card, '계산 기준')).toBeUndefined();
    expect(card.evidence.text).toBe('인사 근태 기록(근태 숫자 없음 · 5인 미만 사업장)');
    // 숫자(N일)는 어디에도 없어요.
    expect(card.fields.map((f) => f.value).join(' ')).not.toMatch(/\d+(\.\d+)?일/);

    const check = await checkCard(haneul, '11월 4일 연차 쓰고 싶어');
    expect(check.headline).toBe('남은 연차를 보여 드릴 수 없어요');
    expect(field(check, '쓸 날')).toBe('11월 4일(수) 하루');
    expect(field(check, '남은 연차')).toBe(LEAVE_SMALL_WORKPLACE_TEXT);
    expect(field(check, '계산 기준')).toBeUndefined();
    expect(field(check, '소멸일')).toBeUndefined();
    expect(check.evidence.text).toBe('인사 근태 기록(근태 숫자 없음 · 5인 미만 사업장)');
    // 병가 쓴 날은 근태 기록으로 그대로 세요(법정 연차 계산이 아니에요).
    const sick = await checkCard(haneul, '오늘 몸살이라 병가 쓸래');
    expect(sick.headline).toBe('병가는 연차와 따로 셌어요');
    expect(field(sick, '올해 병가')).toBe('1.5일 → 2.5일');

    // 근태 숫자가 있는 사람(서연)은 평소처럼 근태 숫자예요.
    const seoyeon = await t.loginAs(MOCK.facilities);
    expect((await balanceCard(seoyeon)).headline).toBe('남은 연차는 15.5일이에요');
    const hr = await checkCard(seoyeon, '11월 4일 연차 쓰고 싶어');
    expect(field(hr, '남은 연차')).toBe('15.5일 → 14.5일');
    expect(field(hr, '계산 기준')).toBe('근태 기록 기준이에요. 결재 중인 신청은 반영하지 않았어요');
  });

  it('[정확도-5인미만 단위] 오래된 근태 숫자(기간 밖)여도 앱 계산으로 돌아가지 않고, 앱 안 요청 계산도 숫자 없음이에요', () => {
    const stale: LeaveRecord = { hireDate: '2020-03-02', uses: [], balance: { periodStart: '2025-01-01', periodEnd: '2025-12-31', remaining: 3 } };
    expect(leaveNumbers(stale, TODAY, SMALL)).toBeNull();
    expect(leaveNumbers({ ...stale, balance: { periodStart: '2026-01-01', periodEnd: '2026-12-31', remaining: 3 } }, TODAY, SMALL)).toMatchObject({
      source: 'hr',
      remaining: 3,
    });
    expect(leaveRequestBalance({ hireDate: '2020-03-02', uses: [] }, TODAY, [{ date: '2026-11-04', kind: 'full' }], SMALL)).toBeNull();
  });

  it('[정확도-5인미만 앱안] 앱 안 휴가 결재(개발·시험)에서는 [휴가 신청하기]를 주지 않고, 받은 문의함은 숫자 대신 까닭 표시예요', async () => {
    const t = await setup({ leaveInApp: true });
    t.ctx.ops.patchValues({ smallWorkplace: 1 });
    const haneul = await t.loginAs(MOCK.staff);
    const jihu = await t.loginAs(MOCK.hr);
    const card = await balanceCard(haneul);
    expect(card.headline).toBe('남은 연차를 보여 드릴 수 없어요');
    expect(card.actions.secondary.some((a) => a.type === 'leave-request')).toBe(false);
    expect((await haneul.call('GET', '/api/navi/leave/start')).body).toEqual({ action: null });
    const sent = await haneul.call('POST', '/api/navi/inquiries', {
      rowId: 'HR-02',
      question: '휴가 신청',
      reason: '가족 행사',
      requestId: 'req-small-workplace-1',
      leave: { days: [{ date: '2026-11-04', kind: 'full' }] },
    });
    expect(sent.status).toBe(200);
    const [item] = ((await jihu.call('GET', '/api/navi/inquiries/inbox')).body as InquiryListResponse).items;
    expect(item!.leave).toMatchObject({ balance: null, smallWorkplace: true });
  });
});

describe('⑥ 공휴일을 쉬지 않는 회사(운영 값 publicHolidaysOff)', () => {
  it('[정확도-공휴일근무 단위] 0이면 법정 공휴일도 일하는 날로 세고 제안해요. 회사 휴일은 그대로 쉬는 날이에요', () => {
    const work = { publicHolidaysOff: false };
    const q = ruleLeaveQuestion('12월 24~26일 연차 쓰면 몇 개 남아?', TODAY, work);
    expect({ full: q.planFull, dates: q.planDates, holidays: q.holidaysSkipped }).toEqual({ full: 2, dates: ['2026-12-24', '2026-12-25'], holidays: [] });
    expect(isWorkday('2026-12-25', work)).toBe(true);
    expect(isWorkday('2026-11-20', { ...work, companyHolidays: ['2026-11-20'] })).toBe(false);
    // 공휴일을 쉬지 않으면 공휴일 표가 없는 해라는 안내도 필요 없어요.
    expect(splitWorkdays(['2028-01-03'], work).unknownYears).toEqual([]);
    expect(checkLeaveLink({ type: 'annual', days: [{ date: '2026-12-25', kind: 'full' }] }, TODAY, work)).toMatchObject({ ok: true });
    expect(draftDays({ type: 'annual', from: '2026-12-24', to: '2026-12-28', half: 'full' }, TODAY, work).map((d) => d.date)).toEqual([
      '2026-12-24',
      '2026-12-25',
      '2026-12-28',
    ]);
    const slot = { start: Date.parse('2026-12-24T14:00:00+09:00'), end: Date.parse('2026-12-24T15:00:00+09:00'), room: '가상 회의실', own: true };
    expect(freeDaysNear({ date: '2026-12-24', kind: 'full' }, [slot], [], new Set(['2026-12-24']), TODAY, work)).toEqual(['2026-12-23', '2026-12-25']);
    expect(offDaysText()).toBe('주말·공휴일·회사 휴일');
    expect(offDaysText(work)).toBe('주말·회사 휴일');
  });

  it('[정확도-공휴일근무] 운영 값을 0으로 하면 카드가 12/25를 연차로 세고, 회사 휴일은 여전히 빼요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/values', { publicHolidaysOff: 2 })).status).toBe(400);
    expect((await op.call('PUT', '/api/ops/values', { publicHolidaysOff: 0 })).status).toBe(200);
    const haneul = await t.loginAs(MOCK.staff);
    const xmas = await checkCard(haneul, '12월 24일부터 26일까지 연차 쓰고 싶어');
    expect(field(xmas, '쓸 날')).toBe('12월 24일(목) 하루 · 12월 25일(금) 하루 (주말은 뺐어요)');
    expect(field(xmas, '남은 연차')).toBe('10일 → 8일');
    expect(field(xmas, '쉬는 날')).toBeUndefined();
    expect((await op.call('PUT', '/api/ops/holidays', { dates: ['2026-12-24'] })).status).toBe(200);
    const company = await checkCard(haneul, '12월 24일부터 26일까지 연차 쓰고 싶어');
    expect(field(company, '남은 연차')).toBe('10일 → 9일');
    expect(field(company, '쉬는 날')).toBe('12월 24일(목) 회사 휴일 · 공휴일·회사 휴일이라 연차로 세지 않았어요');
    // 앱 쪽 [이 날로 보기]도 공휴일을 받아요.
    expect((await haneul.call('POST', '/api/navi/leave/check', { type: 'annual', days: [{ date: '2026-12-25', kind: 'full' }] })).status).toBe(200);
  });
});

describe('⑦ 주말 근무자(사람별 근무 요일)와 회사 기본 근무 요일', () => {
  it('[정확도-주말근무 단위] 근무 요일이 화~토면 토요일은 세고 월요일은 "근무하지 않는 요일"로 빼요(날 세기·제안·검사·가상 그룹웨어)', () => {
    expect(splitWorkdays(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'], TUE_TO_SAT)).toMatchObject({
      workdays: ['2026-10-31', '2026-11-03'],
      weekend: 2,
    });
    expect(ruleLeaveQuestion('10월 31일부터 11월 3일까지 연차 쓰면', TODAY, TUE_TO_SAT)).toMatchObject({
      planFull: 2,
      planDates: ['2026-10-31', '2026-11-03'],
      weekendSkipped: 2,
    });
    // 회사 기본(월~금)은 그대로 토요일이 주말이에요(MCP 휴가 준비는 근태를 읽지 않아 이 달력이에요).
    expect(checkLeaveLink({ type: 'annual', days: [{ date: '2026-10-31', kind: 'full' }] }, TODAY)).toMatchObject({ message: '10월 31일(토)은 주말이에요' });
    expect(checkLeaveLink({ type: 'annual', days: [{ date: '2026-11-02', kind: 'full' }] }, TODAY, TUE_TO_SAT)).toEqual({
      ok: false,
      code: 'weekend',
      message: '11월 2일(월)은 근무하지 않는 요일이에요',
    });
    expect(checkLeaveLink({ type: 'annual', days: [{ date: '2026-10-31', kind: 'full' }] }, TODAY, TUE_TO_SAT)).toMatchObject({ ok: true });
    // 10/30(금)에 일이 있으면: 기본은 10/29·11/2, 주말 근무자는 10/29·10/31(토)을 제안해요.
    const slot = { start: Date.parse('2026-10-30T14:00:00+09:00'), end: Date.parse('2026-10-30T15:00:00+09:00'), room: '가상 회의실', own: true };
    const exclude = new Set(['2026-10-30']);
    expect(freeDaysNear({ date: '2026-10-30', kind: 'full' }, [slot], [], exclude, TODAY)).toEqual(['2026-10-29', '2026-11-02']);
    expect(freeDaysNear({ date: '2026-10-30', kind: 'full' }, [slot], [], exclude, TODAY, TUE_TO_SAT)).toEqual(['2026-10-29', '2026-10-31']);
    expect(draftDays({ type: 'annual', from: '2026-10-30', to: '2026-11-03', half: 'full' }, TODAY, TUE_TO_SAT).map((d) => d.date)).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-03',
    ]);
    expect(() => draftDays({ type: 'annual', from: '2026-11-01', to: '2026-11-02', half: 'full' }, TODAY, TUE_TO_SAT)).toThrow(
      '고른 날이 모두 근무하지 않는 요일이에요',
    );
    expect(offDaysText(TUE_TO_SAT)).toBe('근무하지 않는 요일·공휴일·회사 휴일');
  });

  it('[정확도-주말근무] 근태가 준 근무 요일로 신청 전 카드·[이 날로 보기]·MCP 링크 카드가 세요. 다른 사람은 회사 기본 그대로예요', async () => {
    const t = await setup({ adapters: { ...createMockAdapters(), leave: weekendWorkerLeave() } });
    const haneul = await t.loginAs(MOCK.staff);
    const sat = await checkCard(haneul, '10월 31일 연차 쓰고 싶어');
    expect(sat.headline).toBe('10월 31일(토) 하루 쓰면 남은 연차는 9일이에요');
    expect(field(sat, '남은 연차')).toBe('10일 → 9일');
    const mon = await checkCard(haneul, '11월 2일 연차 쓰고 싶어');
    expect(field(mon, '쓸 날')).toBe('근무하지 않는 요일이라 연차에서 빼지 않았어요');
    expect(field(mon, '남은 연차')).toBe('10일 → 10일');
    const span = await checkCard(haneul, '10월 31일부터 11월 3일까지 연차 쓰고 싶어');
    expect(field(span, '쓸 날')).toBe('10월 31일(토) 하루 · 11월 3일(화) 하루 (근무하지 않는 요일은 뺐어요)');
    expect(field(span, '남은 연차')).toBe('10일 → 8일');
    // [이 날로 보기]는 본인 근무 요일로 검사해요.
    expect((await haneul.call('POST', '/api/navi/leave/check', { type: 'annual', days: [{ date: '2026-10-31', kind: 'full' }] })).status).toBe(200);
    expect(await haneul.call('POST', '/api/navi/leave/check', { type: 'annual', days: [{ date: '2026-11-02', kind: 'full' }] })).toMatchObject({
      status: 400,
      body: { message: '11월 2일(월)은 근무하지 않는 요일이에요' },
    });
    // MCP 링크(회사 기본 달력으로 검사한 날)를 열면 본인이 일하지 않는 요일은 빼고 알려요.
    const user: DeskUser = {
      sessionId: 's',
      pseudonymId: 'p-haneul',
      idpSubject: MOCK.staff,
      email: 'haneul@corp.example',
      displayName: '가상 직원 하늘',
      department: '재무팀',
      floor: '3',
      roles: [],
    };
    const fromLink = await leaveCheckForLink(
      t.ctx,
      user,
      [
        { date: '2026-10-30', kind: 'full' },
        { date: '2026-11-02', kind: 'full' },
      ],
      'annual',
    );
    expect(field(fromLink, '쓸 날')).toBe('10월 30일(금) 하루 (근무하지 않는 요일은 뺐어요)');
    expect(field(fromLink, '남은 연차')).toBe('10일 → 9일');
    // 회사 기본(월~금)인 도윤은 토요일이 주말이에요.
    const doyun = await t.loginAs(MOCK.dev);
    expect(field(await checkCard(doyun, '10월 31일 연차 쓰고 싶어'), '쓸 날')).toBe('주말이라 연차에서 빼지 않았어요');
  });

  it('[정확도-주말근무 앱안] 앱 안 휴가 요청(개발·시험)도 본인 근무 요일로 검사하고, 양식에 근무 달력을 넘겨요', async () => {
    const t = await setup({ leaveInApp: true, adapters: { ...createMockAdapters(), leave: weekendWorkerLeave() } });
    const haneul = await t.loginAs(MOCK.staff);
    const action = (await balanceCard(haneul)).actions.secondary.find((a): a is Extract<CardAction, { type: 'leave-request' }> => a.type === 'leave-request');
    expect(action?.calendar).toEqual({ weekdays: [2, 3, 4, 5, 6], publicHolidaysOff: true });
    const send = (date: string, n: number) =>
      haneul.call('POST', '/api/navi/inquiries', {
        rowId: 'HR-02',
        question: '휴가 신청',
        reason: '가족 행사',
        requestId: `req-weekend-worker-${n}`,
        leave: { days: [{ date, kind: 'full' }] },
      });
    expect((await send('2026-10-31', 1)).status).toBe(200);
    expect(await send('2026-11-02', 2)).toMatchObject({ status: 400, body: { message: '11월 2일(월)은 근무하지 않는 요일이에요' } });
    // 회사 기본(월~금)인 사람의 양식에는 근무 달력이 없어요.
    const doyun = await t.loginAs(MOCK.dev);
    const plain = (await balanceCard(doyun)).actions.secondary.find((a) => a.type === 'leave-request');
    expect(plain).toBeDefined();
    expect(plain).not.toHaveProperty('calendar');
    // 남은 연차 카드의 "읽은 계획"도 시간 옆에 일을 보여요(11/6).
    expect(field(await balanceCard(doyun, '11월 4일 연차 2시간 쓰면 몇 개 남아?'), '읽은 계획')).toBe('11월 4일(수) 2시간(0.25일)');
  });

  it('[정확도-근무요일] 회사 기본 근무 요일은 운영자만 바꾸고(0~6, 감사에는 개수만), 월~토면 토요일도 세고 일요일은 빼요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    const staff = await t.loginAs(MOCK.staff);
    expect((await staff.call('PUT', '/api/ops/work-weekdays', { weekdays: [1, 2, 3, 4, 5, 6] })).status).toBe(403);
    expect((await op.call('PUT', '/api/ops/work-weekdays', { weekdays: [] })).status).toBe(400);
    expect((await op.call('PUT', '/api/ops/work-weekdays', { weekdays: [7] })).status).toBe(400);
    expect((await op.call('PUT', '/api/ops/work-weekdays', { weekdays: ['월'] })).status).toBe(400);
    expect((await op.call('PUT', '/api/ops/work-weekdays', { weekdays: [6, 1, 2, 3, 4, 5, 5] })).status).toBe(200);
    expect(t.ctx.ops.get().workWeekdays).toEqual([1, 2, 3, 4, 5, 6]);
    const audit = (await t.db.query<{ action: string; result: string }>("select action, result from audit_log where action = 'workWeekdays.set'")).rows;
    expect(audit).toEqual([{ action: 'workWeekdays.set', result: '6' }]);

    const doyun = await t.loginAs(MOCK.dev);
    expect(field(await checkCard(doyun, '10월 31일 연차 쓰고 싶어'), '남은 연차')).toBe('7.5일 → 6.5일');
    expect(field(await checkCard(doyun, '11월 1일 연차 쓰고 싶어'), '쓸 날')).toBe('근무하지 않는 요일이라 연차에서 빼지 않았어요');
    // MCP 휴가 준비(회사 기본 달력)도 토요일을 받아요.
    expect(checkLeaveLink({ type: 'annual', days: [{ date: '2026-10-31', kind: 'full' }] }, TODAY, leavePolicy(t.ctx).calendar)).toMatchObject({ ok: true });
  });

  it('[정확도-주말근무 자료] 가상 근태 파일(DESK_MOCK_LEAVE_JSON)은 사람별 근무 요일을 받고, 0~6이 아니거나 겹치면 거절해요', () => {
    const json = (workWeekdays: unknown) => JSON.stringify({ 'a@corp.example': { hireDate: '2024-01-02', uses: [], workWeekdays } });
    expect(leaveRecordsFromJson(json([2, 3, 4, 5, 6]))['a@corp.example']).toMatchObject({ workWeekdays: [2, 3, 4, 5, 6] });
    expect(() => leaveRecordsFromJson(json([7]))).toThrow();
    expect(() => leaveRecordsFromJson(json([1, 1]))).toThrow();
    expect(() => leaveRecordsFromJson(json([]))).toThrow();
    // 앱에 든 가상 직원 17명은 바꾸지 않았어요(모두 회사 기본).
    expect(Object.values(MOCK_LEAVE_RECORDS).filter((r) => r.workWeekdays)).toEqual([]);
  });
});

describe('⑧ 시간 옆 일 · 다음 연차 기간 한 문장', () => {
  it('[정확도-시간일] 복사 글·상태 카드·남은 연차 카드에서 시간 옆에 일도 보여요(하루 근로시간 운영 값 기준)', async () => {
    expect(leaveHourCopyText('annual', ['2026-11-04', '2026-11-05'], 2, 4)).toBe(
      '휴가 종류: 연차(시간 단위)\n날짜: 11/4(수), 11/5(목)\n시간: 하루 2시간(0.5일)\n사유: 그룹웨어 신청서에 직접 적어 주세요',
    );
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    await t.ctx.adapters.leave.recordUses({ idpSubject: MOCK.dev, email: 'doyun@corp.example' }, [
      { date: '2026-11-05', kind: 'half', type: 'annual', amountDays: 0.25 },
    ]);
    const status = (await doyun.call('POST', '/api/home/ask', { text: '내 휴가 신청 어떻게 됐어?' })).body as HomeAskResponse;
    expect(status.cards.find((c) => c.id === 'navi-leave-status')!.headline).toBe('11월 5일(목) 연차 2시간(0.25일)이 승인됐어요');
    const card = await balanceCard(doyun);
    expect(card.headline).toBe('남은 연차는 7.25일이에요');
    expect(field(card, '쓴 연차(예정 포함)')).toBe('2.75일 · 하루 2번, 반차 1번, 시간 단위 1번(0.25일)');
  });

  it('[정확도-다음기간] 다음 연차 기간 날은 근태 숫자든 앱 계산이든 숫자 없이 한 문장이에요(날짜는 "2027년 1월 1일(금)"처럼)', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const sentence = '12월 1일(화)부터는 새 연차 기간이에요. 그 날은 이번 기간 연차에서 빼지 않았어요';
    const app = await checkCard(doyun, '12월 2일 연차 쓰고 싶어');
    expect(field(app, '다음 연차 기간')).toBe(sentence);
    expect(field(app, '남은 연차')).toBe('7.5일 → 7.5일');
    const jiwoo = await t.loginAs(JIWOO);
    expect(field(await checkCard(jiwoo, '1월 5일 연차 쓰고 싶어'), '다음 연차 기간')).toBe(
      '2027년 1월 1일(금)부터는 새 연차 기간이에요. 그 날은 이번 기간 연차에서 빼지 않았어요',
    );
    // 날 없이 달로 말해도 같은 문장이고, 다음 기간 숫자(→)는 없어요.
    const month = await checkCard(doyun, '12월에 연차 2일 쓰고 싶어');
    expect(field(month, '다음 연차 기간')).toBe(sentence);
    expect(field(month, '다음 연차 기간')).not.toMatch(/→|\d+(\.\d+)?일 /);
    // 앱 안 요청 계산도 다음 기간은 첫날·날 수만이에요.
    const doyunRecord = MOCK_LEAVE_RECORDS['doyun@corp.example']!;
    expect(leaveRequestBalance(doyunRecord, TODAY, [{ date: '2027-02-04', kind: 'full' }])!.next).toEqual({ periodStart: '2026-12-01', days: 1 });
  });

  it('[정확도-AI 새 옵션] 5인 미만·주말 근무자에서도 휴가 해석 모델 입력은 질문 글뿐이에요(근무 요일·숫자 없음)', async () => {
    const provider = new RecordingProvider();
    const t = await setup({ provider, adapters: { ...createMockAdapters(), leave: weekendWorkerLeave() } });
    t.ctx.gateway = new AiGateway(provider, true, t.db);
    t.ctx.ops.patchValues({ smallWorkplace: 1, publicHolidaysOff: 0 });
    const haneul = await t.loginAs(MOCK.staff);
    await askNavi(haneul, '연차 좀 쓰고 싶어');
    await askNavi(haneul, '10월 31일 연차 쓰고 싶어');
    const leaveInputs = provider.inputs.filter((i) => i.purpose === 'leave-question');
    expect(leaveInputs.map((i) => i.input)).toEqual(['질문: 연차 좀 쓰고 싶어']);
    for (const i of provider.inputs) expect(`${i.input}\n${i.system}`, i.purpose).not.toMatch(/\[2,3,4,5,6\]|workWeekdays|2019-03-04|5인 미만|근무하지 않는/);
  });
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

describe('AI에는 질문 글만(기존 그대로)', () => {
  it('[정확도-AI] 시간·공휴일 질문은 규칙이 읽어서 휴가 해석 모델을 부르지 않고, 어떤 모델 입력에도 숫자·근태 자료가 없어요', async () => {
    const provider = new RecordingProvider();
    const t = await setup({ provider });
    t.ctx.gateway = new AiGateway(provider, true, t.db);
    const seoyeon = await t.loginAs(MOCK.facilities);
    for (const text of ['연차 2시간 쓰면 몇 개 남아?', '12월 25일 연차 쓰고 싶어', '반반차 쓰면 몇 개 남아?']) await askNavi(seoyeon, text);
    expect(provider.inputs.filter((i) => i.purpose === 'leave-question')).toEqual([]);
    for (const i of provider.inputs) expect(`${i.input}\n${i.system}`, i.purpose).not.toMatch(/15\.5|14\.5|2022-07-01|2027-06-30|근태 기록 기준/);
  });
});
