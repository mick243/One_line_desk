import { normalizeWorkWeekdays, type WorkCalendar } from '@one-line-desk/shared';
import type { LeaveRecord } from '../adapters/types';
import type { AppContext } from '../context';

// 근무 달력(11/6 사용자 결정, ADR-18 보강). 휴가 날 세기·쉬는 요일 빼기·걸린 일이 없는 날 제안·휴가 날 검사가 같이 써요.
// - 회사 기본: 운영 설정 workWeekdays(기본 월~금)·publicHolidaysOff(기본 1)·companyHolidays
// - 사람별: 근태 어댑터가 준 근무 요일(LeaveRecord.workWeekdays, 교대·주말 근무자)이 있으면 회사 기본 요일 대신 써요.
//   근무 요일은 근태 자료라 본인 화면 계산에만 쓰고 저장·로그·AI에 넣지 않아요. MCP 휴가 준비는 근태를 읽지 않아서 회사 기본으로 검사해요.

/** 회사 기본 근무 달력(운영 설정) */
export function companyCalendar(ctx: Pick<AppContext, 'ops'>): WorkCalendar {
  const s = ctx.ops.get();
  return { weekdays: s.workWeekdays, publicHolidaysOff: s.values.publicHolidaysOff === 1, companyHolidays: s.companyHolidays };
}

/** 그 사람의 근무 달력: 근태 어댑터가 맞는 근무 요일을 주면 그 요일, 아니면 회사 기본이에요. */
export function personCalendar(company: WorkCalendar, record: Pick<LeaveRecord, 'workWeekdays'> | null | undefined): WorkCalendar {
  const own = record?.workWeekdays ? normalizeWorkWeekdays(record.workWeekdays) : null;
  return own ? { ...company, weekdays: own } : company;
}
