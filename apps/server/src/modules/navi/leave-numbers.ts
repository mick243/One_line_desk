import {
  addDays,
  dayLabel,
  dayLabelWithYear,
  DEFAULT_WORK_CALENDAR,
  holidayYearKnown,
  LEAVE_BASIS_APP_TEXT,
  LEAVE_BASIS_HR_TEXT,
  LEAVE_HOLIDAY_SKIPPED_TEXT,
  LEAVE_PENDING_TEXT,
  type LeaveDay,
  type LeaveKind,
  restDayWord,
  type SkippedHoliday,
  type WorkCalendar,
} from '@one-line-desk/shared';
import type { LeaveRecord, LeaveUse } from '../../adapters/types';
import type { AppContext } from '../../context';
import { companyCalendar, personCalendar } from '../../core/work-calendar';

// 휴가 숫자(11/6 휴가 정확도, ADR-18 개정). 앱은 "계산기"가 아니라 근태 숫자를 읽어 보여 주는 곳이에요(사용자 결정).
// - 근태 시스템이 이번 기간 숫자(LeaveRecord.balance)를 주면 그걸 먼저 보여요("근태 기록 기준"). 회계연도·이월·출근율·결근·회사 추가 부여는 근태 몫이에요.
// - 없을 때만 앱이 근로기준법 규칙으로 셈해요(입사일 기준·개근 가정). 카드는 어느 쪽인지 꼭 적어요.
// - 종류 없는 근태 기록은 연차로 세지 않아요. 병가·경조는 운영 값을 따라요(기본 안 뺌), 공가는 늘 안 빼요.
// 숫자·입사일·쓴 날은 등급 2라 AI·로그·DB에 넣지 않아요. 부를 때마다 계산하고 저장하지 않아요.
// 11/6 사용자 결정(이어서):
// - 5인 미만 사업장(운영 값 smallWorkplace=1)은 법정 연차(근로기준법 제60조)가 적용되지 않아 앱이 규칙으로 세지 않아요.
//   근태 숫자가 있으면 그 숫자를 평소처럼, 없으면 숫자 없이 까닭(LEAVE_SMALL_WORKPLACE_TEXT)을 보여요(leaveNumbers가 null).
// - 쉬는 날은 근무 달력(core/work-calendar.ts)이에요: 근무 요일(회사 기본 + 사람별)·공휴일 쉼 여부(publicHolidaysOff)·회사 휴일.
// - 숫자는 일수가 정해진 이번 연차 기간 것만 보여요. 다음 기간 날은 근태 숫자든 앱 계산이든 숫자 없이 한 문장이에요(leaveNextPeriodText).

/** 반차 하나는 0.5일이에요. */
export const HALF_DAY = 0.5;
/** 반반차는 2시간이에요(하루 8시간이면 0.25일). */
export const QUARTER_DAY_HOURS = 2;
/** 근로기준법: 1년 미만은 개근한 달마다 1일(최대 11일), 1년 이상은 15일 + 3년 차부터 2년마다 1일(최대 25일). */
const FIRST_YEAR_MAX = 11;
const BASE_DAYS = 15;
const MAX_DAYS = 25;

/** 휴가 계산에 쓰는 회사 설정(운영 설정에서 읽어요). */
export interface LeavePolicy {
  /** 회사 기본 근무 달력(운영 설정 workWeekdays·publicHolidaysOff·companyHolidays). 사람별 근무 요일은 calendarOf로 덮어요. */
  calendar: WorkCalendar;
  /** 하루 근로시간(운영 값 workdayHours, 기본 8) */
  workdayHours: number;
  /** 연차에서 빼는 종류. 연차는 늘, 병가·경조는 운영 값이 1일 때만, 공가는 늘 빼지 않아요. */
  deducts: ReadonlySet<LeaveKind>;
  /** 5인 미만 사업장(운영 값 smallWorkplace, 11/6). 참이면 앱이 법정 연차를 세지 않고 근태 숫자만 보여요. */
  smallWorkplace: boolean;
}

/** 운영 설정을 하나도 바꾸지 않았을 때(단위 시험용) */
export const DEFAULT_LEAVE_POLICY: LeavePolicy = {
  calendar: DEFAULT_WORK_CALENDAR,
  workdayHours: 8,
  deducts: new Set<LeaveKind>(['annual']),
  smallWorkplace: false,
};

export function leavePolicy(ctx: Pick<AppContext, 'ops'>): LeavePolicy {
  const s = ctx.ops.get();
  const deducts = new Set<LeaveKind>(['annual']);
  if (s.values.sickLeaveFromAnnual === 1) deducts.add('sick');
  if (s.values.eventLeaveFromAnnual === 1) deducts.add('family-event');
  return { calendar: companyCalendar(ctx), workdayHours: s.values.workdayHours, deducts, smallWorkplace: s.values.smallWorkplace === 1 };
}

/** 그 사람의 근무 달력(11/6 주말 근무자): 근태 기록에 맞는 근무 요일이 있으면 그 요일, 없으면 회사 기본이에요. */
export const calendarOf = (policy: Pick<LeavePolicy, 'calendar'>, record: Pick<LeaveRecord, 'workWeekdays'> | null | undefined): WorkCalendar =>
  personCalendar(policy.calendar, record);

/** 쓴 양(일): amountDays가 있으면 그 값, 없으면 하루 1·반차 0.5 */
export const amountOf = (u: Pick<LeaveUse, 'kind' | 'amountDays'>): number => u.amountDays ?? (u.kind === 'full' ? 1 : HALF_DAY);

/** 고른 날들의 일수(반차 0.5) */
export const daysOf = (days: readonly LeaveDay[]): number => days.reduce((n, d) => n + (d.kind === 'full' ? 1 : HALF_DAY), 0);

/** 시간 → 일(하루 근로시간 기준) */
export const hoursToDays = (hours: number, workdayHours: number): number => hours / workdayHours;

/** "7.5일" · "0.25일" · "6일". 소수 둘째 자리까지 보여요(반반차·시간 단위). */
export const fmtDays = (n: number): string => `${Math.round(n * 100) / 100}일`;

/** 올해면 "11월 30일(월)", 다른 해면 "2027년 3월 3일(수)" */
export const dateWithYear = dayLabelWithYear;

// ── 카드 글(신청 전 카드·남은 연차 카드가 같이 써요, 화면설계 "보안이 보이는 문구") ─────────────

/** "2시간(0.25일, 하루 8시간 기준)" */
export const hoursText = (hours: number, workdayHours: number): string =>
  `${hours}시간(${fmtDays(hoursToDays(hours, workdayHours))}, 하루 ${workdayHours}시간 기준)`;

/** 짧은 꼴 "2시간(0.25일)"(11/6 사용자 결정: 시간을 보여 주는 곳에는 일도 같이). 머리·읽은 계획·복사 글에 써요. */
export const hoursDaysText = (hours: number, workdayHours: number): string => `${hours}시간(${fmtDays(hoursToDays(hours, workdayHours))})`;

/**
 * 시간 단위 계획 글(11/6). 하루면 "2시간(0.25일…)", 여러 날이면 "날마다 2시간 · 모두 4시간(0.5일…)"이에요.
 * totalHours는 모든 날을 합한 시간이에요. long이면 "하루 8시간 기준"까지 붙여요.
 */
export function hourPlanText(totalHours: number, dayCount: number, workdayHours: number, long: boolean): string {
  const text = long ? hoursText : hoursDaysText;
  if (dayCount <= 1) return text(totalHours, workdayHours);
  return `날마다 ${Math.round((totalHours / dayCount) * 100) / 100}시간 · 모두 ${text(totalHours, workdayHours)}`;
}

/** 쉬는 요일을 뺐다는 짧은 말: " (주말은 뺐어요)" · 주말 근무자는 " (근무하지 않는 요일은 뺐어요)" */
export const restSkippedNote = (weekdays: readonly number[]): string => ` (${restDayWord(weekdays)}은 뺐어요)`;

/** 쉬는 날이라 뺀 날: "12월 25일(금) 기독탄신일 · … · 공휴일·회사 휴일이라 연차로 세지 않았어요" */
export function holidaysText(list: readonly SkippedHoliday[]): string {
  const shown = list.slice(0, 4).map((h) => `${dayLabel(h.date)} ${h.name}`);
  return `${shown.join(' · ')}${list.length > 4 ? ` 외 ${list.length - 4}일` : ''} · ${LEAVE_HOLIDAY_SKIPPED_TEXT}`;
}

/** 공휴일 표가 없는 해의 날이 있으면 그 해들(11/6). 공휴일을 쉬지 않는 회사(publicHolidaysOff 0)는 표와 상관없어서 비어요. */
export const unknownHolidayYears = (dates: readonly string[], publicHolidaysOff = true): number[] =>
  publicHolidaysOff ? [...new Set(dates.filter((d) => !holidayYearKnown(d)).map((d) => Number(d.slice(0, 4))))].sort() : [];

/** 계산 기준 줄(11/6): 근태 숫자인지 앱 계산인지와, 결재 중인 신청은 반영하지 않았다는 것 */
export function basisText(source: 'hr' | 'app'): string {
  return `${source === 'hr' ? LEAVE_BASIS_HR_TEXT : LEAVE_BASIS_APP_TEXT}. ${LEAVE_PENDING_TEXT}`;
}

/** 소멸일 줄(11/6): "이번 연차는 11월 30일(월)까지예요" */
export const expiryText = (periodEnd: string, today: string): string => `이번 연차는 ${dateWithYear(periodEnd, today)}까지예요`;

const pad = (n: number) => String(n).padStart(2, '0');

/** 날짜에 달을 더해요. 그 달에 없는 날(2월 30일 등)은 그 달 마지막 날이에요. */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

/** 시작일에서 step만큼씩 더해 today를 넘지 않는 횟수(다 채운 달·해 수) */
function completed(from: string, today: string, step: number): number {
  let n = 0;
  while (n < 1200 && addMonths(from, step * (n + 1)) <= today) n += 1;
  return n;
}

/** 앱 계산(근로기준법, 입사일 기준, 개근 가정)의 이번 연차 기간 숫자 */
export interface LeaveBalance {
  /** 이번 연차 기간(입사일 기준). end는 마지막 날이에요. */
  periodStart: string;
  periodEnd: string;
  /** 입사 1년 미만인지(개근한 달마다 1일) */
  firstYear: boolean;
  /** 다 채운 근속 연수 */
  years: number;
  granted: number;
  /** 1년 미만일 때 생긴 연차를 센 날(쓰려는 날 기준, 11/6). 1년 이상이면 오늘이에요. */
  grantAsOf: string;
  usedFull: number;
  usedHalf: number;
  /** 하루·반차가 아닌 쓰기(반반차·시간 단위) 횟수 */
  usedOther: number;
  used: number;
  remaining: number;
}

/**
 * 앱 계산: 이번 연차 기간의 생긴 연차·쓴 연차·남은 연차. 쓴 날은 이번 기간 안의 것만 세고, 앞으로 쓸(승인된) 날도 넣어요.
 * - 종류 없는 기록은 세지 않아요(11/6). 병가·경조는 policy가 빼라고 할 때만 세요.
 * - grantAsOf(11/6): 입사 1년 미만이면 "그 날까지 생기는 연차"로 세요(신청 날 기준). 이번 기간 끝을 넘으면 기간 끝까지예요.
 */
export function computeLeave(record: LeaveRecord, today: string, opts: { policy?: LeavePolicy; grantAsOf?: string } = {}): LeaveBalance {
  const policy = opts.policy ?? DEFAULT_LEAVE_POLICY;
  const years = completed(record.hireDate, today, 12);
  const firstYear = years === 0;
  const periodStart = firstYear ? record.hireDate : addMonths(record.hireDate, 12 * years);
  const nextStart = addMonths(record.hireDate, 12 * (years + 1));
  const periodEnd = addDays(nextStart, -1);
  const asOf = firstYear && opts.grantAsOf && opts.grantAsOf > today ? (opts.grantAsOf > periodEnd ? periodEnd : opts.grantAsOf) : today;
  const granted = firstYear ? Math.min(FIRST_YEAR_MAX, completed(record.hireDate, asOf, 1)) : Math.min(MAX_DAYS, BASE_DAYS + Math.floor((years - 1) / 2));
  const inPeriod = record.uses.filter((u) => u.type !== undefined && policy.deducts.has(u.type) && u.date >= periodStart && u.date < nextStart);
  const isFull = (u: LeaveUse) => amountOf(u) === 1 && u.kind === 'full';
  const isHalf = (u: LeaveUse) => amountOf(u) === HALF_DAY && u.kind === 'half';
  const usedFull = inPeriod.filter(isFull).length;
  const usedHalf = inPeriod.filter(isHalf).length;
  const usedOther = inPeriod.length - usedFull - usedHalf;
  const used = inPeriod.reduce((n, u) => n + amountOf(u), 0);
  return { periodStart, periodEnd, firstYear, years, granted, grantAsOf: asOf, usedFull, usedHalf, usedOther, used, remaining: granted - used };
}

/** 카드가 보여 줄 이번 기간 숫자. 근태 숫자가 있으면 그것(hr), 없으면 앱 계산(app)이에요. */
export interface LeaveNumbers {
  source: 'hr' | 'app';
  basis: 'hire-date' | 'fiscal-year' | null;
  periodStart: string;
  /** 이번 연차가 사라지는 날(소멸일) */
  periodEnd: string;
  granted: number | null;
  used: number | null;
  remaining: number;
  /** 앱 계산일 때만 자세한 값 */
  app: LeaveBalance | null;
}

/**
 * 숫자 우선순위(11/6): 근태 숫자(오늘이 그 기간 안일 때) → 앱 계산. grantAsOf는 앱 계산의 1년 미만에만 써요
 * (근태 숫자는 근태가 정한 그대로예요).
 * 5인 미만 사업장(policy.smallWorkplace, 11/6 사용자 결정)은 앱 계산을 하지 않아서 근태 숫자가 없으면 null이에요.
 */
export function leaveNumbers(record: LeaveRecord, today: string, policy: LeavePolicy = DEFAULT_LEAVE_POLICY, grantAsOf?: string): LeaveNumbers | null {
  const hr = record.balance;
  if (hr && hr.periodStart <= today && today <= hr.periodEnd) {
    return {
      source: 'hr',
      basis: hr.basis ?? null,
      periodStart: hr.periodStart,
      periodEnd: hr.periodEnd,
      granted: hr.granted ?? null,
      used: hr.used ?? null,
      remaining: hr.remaining,
      app: null,
    };
  }
  // 5인 미만 사업장은 법정 연차(제60조)가 적용되지 않아요. 앱이 규칙으로 세면 틀린 숫자가 되어서 숫자를 만들지 않아요.
  if (policy.smallWorkplace) return null;
  const app = computeLeave(record, today, { policy, ...(grantAsOf ? { grantAsOf } : {}) });
  return {
    source: 'app',
    basis: 'hire-date',
    periodStart: app.periodStart,
    periodEnd: app.periodEnd,
    granted: app.granted,
    used: app.used,
    remaining: app.remaining,
    app,
  };
}

/** 다음 연차 기간 첫날(이번 기간 끝 다음 날). 그 날부터 고른 날은 이번 기간에서 빼지 않고, 숫자 없이 한 문장으로 알려요(11/6). */
export const nextPeriodStart = (current: Pick<LeaveNumbers, 'periodEnd'>): string => addDays(current.periodEnd, 1);

/**
 * 고른 날들을 이번 기간으로 계산해요: 이번 기간 날은 남은 연차에서 빼고, 1년 미만이면 그 기간의 마지막 고른 날까지 생기는 연차로 세요.
 * 더 생긴 연차(extra)는 카드에 "그날까지 N일이 더 생겨요"로 보여요.
 */
export function planInPeriod(
  record: LeaveRecord,
  today: string,
  policy: LeavePolicy,
  base: LeaveNumbers,
  dates: readonly string[],
  amount: number,
): { after: number; extra: number; asOf: string | null } {
  const inPeriod = dates.filter((d) => d <= base.periodEnd).sort();
  const last = inPeriod.at(-1);
  if (base.source === 'app' && base.app?.firstYear && last && last > today) {
    const at = computeLeave(record, today, { policy, grantAsOf: last });
    const extra = at.remaining - base.remaining;
    return { after: at.remaining - amount, extra, asOf: extra > 0 ? last : null };
  }
  return { after: base.remaining - amount, extra: 0, asOf: null };
}
