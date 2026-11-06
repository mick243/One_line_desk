// 한국 법정 공휴일 표(11/6 휴가 정확도 ①). 5인 이상 사업장은 관공서 공휴일이 유급휴일이라(근로기준법 제55조 제2항)
// 그날을 연차로 세면 안 돼요. 휴가 날 세기·"걸린 일이 없는 날" 제안·MCP 휴가 준비·가상 그룹웨어 신청서가 이 표 하나를 써요.
//
// **해가 바뀌면 다음 해 표를 더해야 해요.** 우주항공청이 그 전해 6월 말쯤 다음 해 월력요항(관보)을 내요.
// 표에 없는 해의 날은 공휴일인지 몰라서 "공휴일 정보가 없는 해예요"를 보여 줘요(평일로 세되 사람이 확인하게).
// 임시공휴일·회사 휴일(창립기념일 등)은 이 표에 넣지 않고 운영 설정 `companyHolidays`(날짜만)로 운영자가 넣어요.
//
// 출처(2026-11-06 확인)
// - 2026 월력요항(한국천문연구원 천문우주지식정보): https://astro.kasi.re.kr/kor/life/post/calendarData?search_year=2026
//   설 2/16~18, 대체공휴일 3/2·5/25·8/17·10/5, 6/3 전국동시지방선거, 추석 9/24~26(토요일과 겹쳐도 설·추석은 대체공휴일 없음).
// - 2027 월력요항(같은 곳): https://astro.kasi.re.kr/kor/life/post/calendarData?search_year=2027
//   설 2/6~8 + 대체 2/9, 노동절 5/1 + 대체 5/3, 제헌절 7/17 + 대체 7/19, 광복절 대체 8/16, 추석 9/14~16,
//   개천절 대체 10/4, 한글날 대체 10/11, 기독탄신일 대체 12/27. 기사: https://www.fnnews.com/news/202606290904291637
// - 제헌절 공휴일 재지정(공휴일법 개정, 2026-01-29 국회·2026-02-03 국무회의): https://www.khan.co.kr/article/202602031558011
//   2026 월력요항(2025-06 발표)에는 없던 날이라 2026-07-17을 따로 넣었어요.
// - 근로자의 날 → 노동절(2026년부터 이름, 공휴일 지정): https://www.fnnews.com/news/202605010606001014
//   근로자의 날은 원래부터 근로기준법상 유급휴일(근로자의날 제정에 관한 법률)이라 2026-05-01도 쉬는 날이에요.
// - 선거일: 관공서의 공휴일에 관한 규정 제2조 제10호(공직선거법 제34조 임기만료 선거의 선거일).
//
// 근무 달력(11/6 사용자 결정, ADR-18 보강): 쉬는 날은 "일하는 요일이 아닌 날 + 법정 공휴일(운영 값 publicHolidaysOff가 1일 때) + 회사 휴일"이에요.
// - 일하는 요일은 회사 기본(운영 설정 workWeekdays, 기본 월~금) 위에 사람별 근무 요일(근태 어댑터 LeaveRecord.workWeekdays)이 덮여요.
//   교대·주말 근무자는 토요일도 일하는 날이고, 대신 쉬는 평일이 있어요. 기본(월~금)이면 쉬는 요일을 "주말"이라고 불러요.
// - 법정 공휴일을 쉬는 날로 보는지는 운영 값 publicHolidaysOff(기본 1)예요. 0이면 공휴일도 일하는 날로 세요(5인 미만 사업장처럼
//   공휴일이 유급휴일이 아닌 회사). 회사 휴일(companyHolidays)은 늘 쉬는 날이에요.

/** 표가 있는 해. 해가 바뀌면 다음 해를 더해요. */
export const KR_HOLIDAY_YEARS: readonly number[] = [2026, 2027];

const KR_HOLIDAYS: Readonly<Record<string, string>> = {
  // 2026
  '2026-01-01': '신정',
  '2026-02-16': '설날 연휴',
  '2026-02-17': '설날',
  '2026-02-18': '설날 연휴',
  '2026-03-01': '3·1절',
  '2026-03-02': '대체공휴일(3·1절)',
  '2026-05-01': '노동절',
  '2026-05-05': '어린이날',
  '2026-05-24': '부처님오신날',
  '2026-05-25': '대체공휴일(부처님오신날)',
  '2026-06-03': '전국동시지방선거일',
  '2026-06-06': '현충일',
  '2026-07-17': '제헌절',
  '2026-08-15': '광복절',
  '2026-08-17': '대체공휴일(광복절)',
  '2026-09-24': '추석 연휴',
  '2026-09-25': '추석',
  '2026-09-26': '추석 연휴',
  '2026-10-03': '개천절',
  '2026-10-05': '대체공휴일(개천절)',
  '2026-10-09': '한글날',
  '2026-12-25': '기독탄신일',
  // 2027
  '2027-01-01': '신정',
  '2027-02-06': '설날 연휴',
  '2027-02-07': '설날',
  '2027-02-08': '설날 연휴',
  '2027-02-09': '대체공휴일(설날)',
  '2027-03-01': '3·1절',
  '2027-05-01': '노동절',
  '2027-05-03': '대체공휴일(노동절)',
  '2027-05-05': '어린이날',
  '2027-05-13': '부처님오신날',
  '2027-06-06': '현충일',
  '2027-07-17': '제헌절',
  '2027-07-19': '대체공휴일(제헌절)',
  '2027-08-15': '광복절',
  '2027-08-16': '대체공휴일(광복절)',
  '2027-09-14': '추석 연휴',
  '2027-09-15': '추석',
  '2027-09-16': '추석 연휴',
  '2027-10-03': '개천절',
  '2027-10-04': '대체공휴일(개천절)',
  '2027-10-09': '한글날',
  '2027-10-11': '대체공휴일(한글날)',
  '2027-12-25': '기독탄신일',
  '2027-12-27': '대체공휴일(기독탄신일)',
};

/** 운영 설정 회사 휴일(창립기념일·임시공휴일 등)의 이름. 운영자는 날짜만 넣어요. */
export const COMPANY_HOLIDAY_NAME = '회사 휴일';
/** 운영 설정 회사 휴일 날짜 수 상한 */
export const COMPANY_HOLIDAYS_MAX = 60;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** 회사 기본 근무 요일(월~금). 0 일요일 … 6 토요일이에요. */
export const DEFAULT_WORK_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/**
 * 근무 달력(11/6 사용자 결정). 휴가 날 세기·제안·검사가 이걸로 쉬는 날을 정해요.
 * 회사 기본은 운영 설정(workWeekdays·publicHolidaysOff·companyHolidays)이고, 사람마다 근무 요일만 근태 어댑터 값으로 덮여요.
 */
export interface WorkCalendar {
  /** 일하는 요일(0 일요일 … 6 토요일). 기본 월~금이에요. */
  weekdays: readonly number[];
  /** 법정 공휴일을 쉬는 날로 보는지(운영 값 publicHolidaysOff, 기본 참). 거짓이면 공휴일도 일하는 날로 세요. */
  publicHolidaysOff: boolean;
  /** 회사 휴일·임시공휴일(운영 설정 companyHolidays). 늘 쉬는 날이에요. */
  companyHolidays: readonly string[];
}

/** 아무것도 바꾸지 않은 근무 달력(월~금, 공휴일 쉼, 회사 휴일 없음) */
export const DEFAULT_WORK_CALENDAR: WorkCalendar = { weekdays: DEFAULT_WORK_WEEKDAYS, publicHolidaysOff: true, companyHolidays: [] };

/** 일부만 받은 근무 달력을 채워요(빠진 칸은 기본값). */
export const workCalendar = (cal: Partial<WorkCalendar> = {}): WorkCalendar => ({
  weekdays: cal.weekdays ?? DEFAULT_WORK_WEEKDAYS,
  publicHolidaysOff: cal.publicHolidaysOff ?? true,
  companyHolidays: cal.companyHolidays ?? [],
});

/** 토·일요일인지 */
export const isWeekend = (date: string): boolean => [0, 6].includes(weekdayOf(date));

/** 근무 요일이 기본(월~금)인지. 기본이면 쉬는 요일을 "주말"이라고 불러요. */
export const isDefaultWorkWeek = (weekdays: readonly number[]): boolean =>
  weekdays.length === DEFAULT_WORK_WEEKDAYS.length && DEFAULT_WORK_WEEKDAYS.every((d) => weekdays.includes(d));

/** 쉬는 요일을 부르는 말: 월~금이면 "주말", 아니면 "근무하지 않는 요일"(11/6 주말 근무자) */
export const restDayWord = (weekdays: readonly number[] = DEFAULT_WORK_WEEKDAYS): string => (isDefaultWorkWeek(weekdays) ? '주말' : '근무하지 않는 요일');

/** 그 날이 일하는 요일인지(공휴일·회사 휴일은 보지 않아요) */
export const isWorkWeekday = (date: string, weekdays: readonly number[] = DEFAULT_WORK_WEEKDAYS): boolean => weekdays.includes(weekdayOf(date));

/** 그 해 공휴일 표가 있는지. 없으면 그해 공휴일은 몰라요. */
export const holidayYearKnown = (date: string): boolean => KR_HOLIDAY_YEARS.includes(Number(date.slice(0, 4)));

/** 표에 없는 해를 알려 주는 글 */
export const holidayUnknownText = (years: readonly number[]): string =>
  `${years.map((y) => `${y}년`).join('·')}은 공휴일 정보가 없는 해예요. 공휴일이 끼어 있으면 그날은 빼고 신청해 주세요`;

/** 법정 공휴일 이름(주말과 겹친 날도 이름은 있어요). 아니면 null이에요. */
export const publicHolidayName = (date: string): string | null => KR_HOLIDAYS[date] ?? null;

/**
 * 쉬는 날 이름: 법정 공휴일(publicHolidaysOff일 때만) 또는 운영 설정 회사 휴일. 요일은 보지 않아요.
 */
export function offDayName(date: string, cal: Partial<WorkCalendar> = {}): string | null {
  const c = workCalendar(cal);
  return (c.publicHolidaysOff ? publicHolidayName(date) : null) ?? (c.companyHolidays.includes(date) ? COMPANY_HOLIDAY_NAME : null);
}

/** 일하는 날(일하는 요일이고 공휴일·회사 휴일이 아님)인지. 휴가는 이 날만 세요. */
export const isWorkday = (date: string, cal: Partial<WorkCalendar> = {}): boolean => {
  const c = workCalendar(cal);
  return isWorkWeekday(date, c.weekdays) && !offDayName(date, c);
};

/** 일하는 요일인데 쉬는 날이라 뺀 날 */
export interface SkippedHoliday {
  date: string;
  name: string;
}

/**
 * 날 목록을 일하는 날·쉬는 요일(weekend: 기본이면 주말, 주말 근무자는 근무하지 않는 요일)·쉬는 날로 나눠요.
 * unknownYears는 공휴일 표가 없는 해(일하는 날로 남겨 두고 알려요). 공휴일을 쉬지 않는 회사(publicHolidaysOff 거짓)는 표와 상관없어서 비어요.
 * 순서는 받은 순서 그대로예요.
 */
export function splitWorkdays(
  dates: readonly string[],
  cal: Partial<WorkCalendar> = {},
): { workdays: string[]; weekend: number; holidays: SkippedHoliday[]; unknownYears: number[] } {
  const c = workCalendar(cal);
  const workdays: string[] = [];
  const holidays: SkippedHoliday[] = [];
  const unknown = new Set<number>();
  let weekend = 0;
  for (const date of dates) {
    if (!isWorkWeekday(date, c.weekdays)) {
      weekend += 1;
      continue;
    }
    const name = offDayName(date, c);
    if (name) {
      holidays.push({ date, name });
      continue;
    }
    if (c.publicHolidaysOff && !holidayYearKnown(date)) unknown.add(Number(date.slice(0, 4)));
    workdays.push(date);
  }
  return { workdays, weekend, holidays, unknownYears: [...unknown].sort() };
}

/**
 * 운영 설정·근태 어댑터의 근무 요일 검사: 0~6 정수만, 1~7개. 겹친 요일은 하나로, 작은 순으로 돌려줘요. 틀리면 null이에요.
 */
export function normalizeWorkWeekdays(days: readonly unknown[]): number[] | null {
  if (!days.length || days.length > 7) return null;
  const out = new Set<number>();
  for (const d of days) {
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) return null;
    out.add(d);
  }
  return [...out].sort((a, b) => a - b);
}

/** 운영 설정 회사 휴일 검사: 진짜 날짜(YYYY-MM-DD)만, 상한까지. 겹친 날은 하나로, 날짜 순으로 돌려줘요. 틀리면 null이에요. */
export function normalizeCompanyHolidays(dates: readonly unknown[]): string[] | null {
  if (dates.length > COMPANY_HOLIDAYS_MAX) return null;
  const out = new Set<string>();
  for (const d of dates) {
    if (typeof d !== 'string' || !DATE.test(d)) return null;
    const real = new Date(`${d}T00:00:00Z`);
    if (Number.isNaN(real.getTime()) || real.toISOString().slice(0, 10) !== d) return null;
    out.add(d);
  }
  return [...out].sort();
}
