import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { AdapterCapabilities, LeaveAdapter, LeaveRecord, LeaveSystemBalance, LeaveUse } from '../types';

// 시연용 가상 인사 근태 기록이에요. 실제 사람이 아니에요. 가상 직원 17명(모의 직원·임시 IdP 같은 사람)의 입사일과 휴가 쓴 날만 있어요.
// 회사 메일로 찾아서 모의 로그인·임시 IdP 어느 쪽으로 들어와도 같은 기록을 봐요.
// 11/6 휴가 정확도: 연차 기록에는 종류(annual)를 꼭 넣어요(종류 없는 기록은 연차로 세지 않아요). 공휴일(packages/shared holidays.ts)에는
// 연차를 넣지 않아요(시험으로 지켜요). 서연·지우는 근태 시스템이 준 숫자(balance)가 있어서 "근태 기록 기준" 경로를, 나머지는 앱 계산 경로를 보여요.

const full = (...dates: string[]): LeaveUse[] => dates.map((date) => ({ date, kind: 'full' as const, type: 'annual' as const }));
const half = (...dates: string[]): LeaveUse[] => dates.map((date) => ({ date, kind: 'half' as const, type: 'annual' as const }));

const RECORDS: Record<string, LeaveRecord> = {
  // 근속 7년: 18일. 지난 연차 기간(2월)에 쓴 날은 이번 기간에 들어가지 않아요. 11월 6일은 예정이에요.
  // 병가(11/3): 2025-12-15는 지난해라 올해 병가에 세지 않고, 1월 19일 하루·9월 7일 반차로 올해 병가 1.5일이에요. 연차에서는 빠지지 않아요.
  'haneul@corp.example': {
    hireDate: '2019-03-04',
    uses: [
      ...full('2026-02-13', '2026-04-10', '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-11-06'),
      ...half('2026-05-22', '2026-09-18'),
      { date: '2025-12-15', kind: 'full', type: 'sick' },
      { date: '2026-01-19', kind: 'full', type: 'sick' },
      { date: '2026-09-07', kind: 'half', type: 'sick' },
    ],
  },
  // 입사 1년 미만: 개근한 달마다 1일
  'doyun@corp.example': { hireDate: '2025-12-01', uses: [...full('2026-03-13', '2026-08-14'), ...half('2026-06-05')] },
  // 6월 16일은 공가(예비군)라 연차에서 빠지지 않아요. 3월 9~10일·9월 22일 오후는 병가라 연차에서 빠지지 않고 올해 병가 2.5일로 세요.
  // 근태 시스템이 준 숫자(11/6): 입사일 기준, 생긴 18일(근속 4년 16일 + 이월 2일), 쓴 2.5일, 남은 15.5일. 앱 계산(13.5일)보다 먼저 보여요.
  'seoyeon@corp.example': {
    hireDate: '2022-07-01',
    uses: [
      ...full('2026-08-03', '2026-08-04'),
      ...half('2026-10-02'),
      { date: '2026-06-16', kind: 'full', type: 'official' },
      { date: '2026-03-09', kind: 'full', type: 'sick' },
      { date: '2026-03-10', kind: 'full', type: 'sick' },
      { date: '2026-09-22', kind: 'half', type: 'sick' },
    ],
    balance: { basis: 'hire-date', periodStart: '2026-07-01', periodEnd: '2027-06-30', granted: 18, used: 2.5, remaining: 15.5 },
  },
  // 설 연휴(2/16·2/17)·한글날(10/9) 반차로 잡혀 있던 날을 11/6에 가까운 평일로 옮겼어요(2/19·2/20, 10/8).
  'jihu@corp.example': {
    hireDate: '2016-01-04',
    uses: [
      ...full('2026-02-19', '2026-02-20', '2026-05-04', '2026-05-06', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'),
      ...half('2026-06-12', '2026-10-08'),
    ],
  },
  // 대체공휴일(10/5)이던 반차를 10/6으로 옮겼어요(11/6).
  'minjun@corp.example': { hireDate: '2023-09-01', uses: half('2026-10-06') },
  'seojun@corp.example': { hireDate: '2024-02-19', uses: [...full('2026-03-20'), ...half('2026-09-11')] },
  'haeun@corp.example': { hireDate: '2021-11-08', uses: full('2026-01-02', '2026-06-19') },
  // 근태 시스템이 준 숫자(11/6): 회계연도 기준(1월 1일 ~ 12월 31일), 생긴 16일, 쓴 3.5일, 남은 12.5일. 이번 연차는 12월 31일까지예요.
  'jiwoo@corp.example': {
    hireDate: '2020-05-25',
    uses: [...full('2026-07-06', '2026-07-07', '2026-07-08'), ...half('2026-10-16')],
    balance: { basis: 'fiscal-year', periodStart: '2026-01-01', periodEnd: '2026-12-31', granted: 16, used: 3.5, remaining: 12.5 },
  },
  'yejun@corp.example': { hireDate: '2018-08-13', uses: half('2026-09-04', '2026-10-23') },
  // 추석(9/25)이던 날을 9/23으로 옮겼어요(11/6).
  'sua@corp.example': { hireDate: '2026-06-01', uses: full('2026-09-23') },
  // 대체공휴일(8/17)이던 날을 8/19로 옮겼어요(11/6).
  'eunwoo@corp.example': { hireDate: '2015-03-02', uses: full('2026-04-03', '2026-08-18', '2026-08-19') },
  'yuna@corp.example': { hireDate: '2024-10-14', uses: [] },
  'siwoo@corp.example': { hireDate: '2023-01-09', uses: [...full('2026-02-02'), ...half('2026-05-15', '2026-07-24')] },
  // 노동절(5/1)이던 날을 4/30으로 옮겼어요(11/6).
  'dain@corp.example': { hireDate: '2012-04-02', uses: full('2026-04-30', '2026-10-19', '2026-10-20') },
  'juwon@corp.example': { hireDate: '2005-06-07', uses: [...full('2026-06-08', '2026-08-24', '2026-08-25'), ...half('2026-09-30')] },
  'harin@corp.example': { hireDate: '2023-03-02', uses: [...full('2026-05-04')] },
  // 사내 카페 바리스타(11/6, ADR-29)
  'hajun@corp.example': { hireDate: '2024-09-02', uses: [...full('2026-06-12')] },
};

const LeaveFileSchema = z.record(
  z.email(),
  z.strictObject({
    hireDate: z.iso.date(),
    uses: z.array(
      z.strictObject({
        date: z.iso.date(),
        kind: z.enum(['full', 'half']),
        half: z.enum(['am', 'pm']).optional(),
        type: z.enum(['annual', 'official', 'sick', 'family-event']).optional(),
        amountDays: z.number().positive().max(1).optional(),
      }),
    ),
    balance: z
      .strictObject({
        basis: z.enum(['hire-date', 'fiscal-year']).optional(),
        periodStart: z.iso.date(),
        periodEnd: z.iso.date(),
        granted: z.number().min(0).max(100).optional(),
        used: z.number().min(0).max(100).optional(),
        remaining: z.number().min(-100).max(100),
      })
      .optional(),
    // 사람별 근무 요일(11/6 주말 근무자): 0 일요일 … 6 토요일, 겹치지 않게 1~7개
    workWeekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, '근무 요일이 겹쳐요')
      .optional(),
  }),
);

/**
 * 회사마다 따로 둔 가상 근태 기록 파일(11/5, 회사별 분리 시험). 시연·개발에서 DESK_MOCK_LEAVE_FILE로만 읽어요.
 * 다른 회사(임시 IdP의 다른 영역)를 띄워 볼 때 그 회사 가상 직원의 입사일·휴가 쓴 날을 저장소 밖 파일에 둬요.
 * 모양: { "메일": { "hireDate": "YYYY-MM-DD", "uses": [{ "date": "YYYY-MM-DD", "kind": "full" | "half", "type": "annual" }],
 *         "balance"?: { "periodStart", "periodEnd", "remaining", "granted"?, "used"?, "basis"? }, "workWeekdays"?: [2, 3, 4, 5, 6] } }
 * 종류(type)가 없는 쓰기는 연차로 세지 않아요(11/6). workWeekdays는 주말 근무자의 근무 요일(0 일요일 … 6 토요일, 11/6)이에요.
 */
export function loadLeaveRecords(path: string): Record<string, LeaveRecord> {
  return leaveRecordsFromJson(readFileSync(path, 'utf8'));
}

/** 같은 모양을 글자로 받아요(배포 시연은 파일 대신 비밀 값 DESK_MOCK_LEAVE_JSON으로 넣어요). */
export function leaveRecordsFromJson(json: string): Record<string, LeaveRecord> {
  return LeaveFileSchema.parse(JSON.parse(json));
}

const amountOf = (u: LeaveUse) => u.amountDays ?? (u.kind === 'full' ? 1 : 0.5);

/** 시연 중 승인된 연차를 근태 숫자에 반영해요(실제 근태 시스템처럼 승인되면 남은 연차가 줄어요). */
function withApproved(balance: LeaveSystemBalance, approved: readonly LeaveUse[]): LeaveSystemBalance {
  const taken = approved
    .filter((u) => u.type === 'annual' && u.date >= balance.periodStart && u.date <= balance.periodEnd)
    .reduce((n, u) => n + amountOf(u), 0);
  if (!taken) return { ...balance };
  return { ...balance, ...(balance.used !== undefined ? { used: balance.used + taken } : {}), remaining: balance.remaining - taken };
}

export class MockLeave implements LeaveAdapter {
  readonly capabilities: AdapterCapabilities = { name: 'mock-leave', label: '인사 근태 기록(가상 연차 자료)', mock: true };
  readonly connected = true;
  /** 시연 중 인사팀이 승인한 날(ADR-24). 이 서버 메모리에만 있고, 다시 뜨면 처음 자료로 돌아가요. */
  private readonly approved = new Map<string, LeaveUse[]>();

  /** records가 없으면 앱에 든 가상 직원 17명 기록이에요. 회사별 시험은 파일에서 읽은 기록을 넘겨요. */
  constructor(private readonly records: Record<string, LeaveRecord> = RECORDS) {}

  async leaveOf(person: { idpSubject: string; email?: string }): Promise<LeaveRecord | null> {
    const record = person.email ? this.records[person.email] : undefined;
    if (!record) return null;
    const approved = this.approved.get(person.email!) ?? [];
    return {
      hireDate: record.hireDate,
      uses: [...record.uses, ...approved].map((u) => ({ ...u })),
      ...(record.balance ? { balance: withApproved(record.balance, approved) } : {}),
      ...(record.workWeekdays ? { workWeekdays: [...record.workWeekdays] } : {}),
    };
  }

  async recordUses(person: { idpSubject: string; email?: string }, uses: LeaveUse[]): Promise<'recorded' | 'not-found'> {
    if (!person.email || !this.records[person.email]) return 'not-found';
    this.approved.set(person.email, [...(this.approved.get(person.email) ?? []), ...uses.map((u) => ({ ...u }))]);
    return 'recorded';
  }
}

/** 시험용: 앱에 든 가상 근태 기록(메일 → 기록). 공휴일에 연차가 없는지 시험이 봐요. */
export const MOCK_LEAVE_RECORDS: Readonly<Record<string, LeaveRecord>> = RECORDS;
