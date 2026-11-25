import { describe, expect, it } from 'vitest';
import { leaveNextPeriodText } from './api/navi';
import { isDefaultWorkWeek, isWorkday, KR_HOLIDAY_YEARS, krHolidayDates, normalizeWorkWeekdays, offDayName, restDayWord, workCalendar } from './holidays';
import { dayLabelWithYear } from './time';

// 근무 달력(11/6 사용자 결정, ADR-18 보강). 서버·화면이 같이 쓰는 함수라 여기서도 지켜요.

describe('근무 달력', () => {
  it('근무 요일 검사는 0~6 정수만 1~7개 받고, 겹친 요일은 하나로 작은 순이에요', () => {
    expect(normalizeWorkWeekdays([6, 2, 3, 4, 5, 5])).toEqual([2, 3, 4, 5, 6]);
    expect(normalizeWorkWeekdays([])).toBeNull();
    expect(normalizeWorkWeekdays([7])).toBeNull();
    expect(normalizeWorkWeekdays([1.5])).toBeNull();
    expect(normalizeWorkWeekdays(['1'])).toBeNull();
    expect(normalizeWorkWeekdays([0, 1, 2, 3, 4, 5, 6, 6])).toBeNull();
  });

  it('쉬는 요일 이름: 월~금이면 "주말", 아니면 "근무하지 않는 요일"이에요', () => {
    expect(isDefaultWorkWeek([5, 4, 3, 2, 1])).toBe(true);
    expect(restDayWord()).toBe('주말');
    expect(restDayWord([2, 3, 4, 5, 6])).toBe('근무하지 않는 요일');
    expect(restDayWord([1, 2, 3, 4, 5, 6])).toBe('근무하지 않는 요일');
  });

  it('공휴일을 쉬지 않으면(publicHolidaysOff 거짓) 공휴일은 일하는 날이고, 회사 휴일은 늘 쉬는 날이에요', () => {
    expect(offDayName('2026-12-25')).toBe('기독탄신일');
    expect(offDayName('2026-12-25', { publicHolidaysOff: false })).toBeNull();
    expect(isWorkday('2026-12-25', { publicHolidaysOff: false })).toBe(true);
    expect(offDayName('2026-12-25', { publicHolidaysOff: false, companyHolidays: ['2026-12-25'] })).toBe('회사 휴일');
    // 2026-10-31은 토요일이에요.
    expect(isWorkday('2026-10-31')).toBe(false);
    expect(isWorkday('2026-10-31', { weekdays: [2, 3, 4, 5, 6] })).toBe(true);
    expect(workCalendar({})).toEqual({ weekdays: [1, 2, 3, 4, 5], publicHolidaysOff: true, companyHolidays: [] });
  });

  it('다음 연차 기간 문장은 숫자 없이 날짜만이고, 다른 해면 해를 붙여요', () => {
    expect(dayLabelWithYear('2026-12-01', '2026-10-26')).toBe('12월 1일(화)');
    expect(dayLabelWithYear('2027-03-02', '2026-10-26')).toBe('2027년 3월 2일(화)');
    expect(leaveNextPeriodText('2027-03-02', '2026-10-26')).toBe('2027년 3월 2일(화)부터는 새 연차 기간이에요. 그 날은 이번 기간 연차에서 빼지 않았어요');
  });
});

describe('공휴일 표 모양(11/25)', () => {
  it('모든 날짜가 실제 날짜이고, 해는 KR_HOLIDAY_YEARS와 서로 맞아요. 해마다 신정·3·1절·기독탄신일이 있어요', () => {
    const dates = krHolidayDates();
    for (const d of dates) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10)).toBe(d);
    }
    const years = [...new Set(dates.map((d) => Number(d.slice(0, 4))))].sort();
    expect(years).toEqual([...KR_HOLIDAY_YEARS].sort());
    for (const y of KR_HOLIDAY_YEARS) {
      expect(dates).toEqual(expect.arrayContaining([`${y}-01-01`, `${y}-03-01`, `${y}-12-25`]));
    }
    // 해는 빠짐없이 이어져요(중간 해를 빼먹지 않아요).
    expect(years.at(-1)! - years[0]! + 1).toBe(years.length);
  });
});
