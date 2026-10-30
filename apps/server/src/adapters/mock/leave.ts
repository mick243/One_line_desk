import type { AdapterCapabilities, LeaveAdapter, LeaveRecord, LeaveUse } from '../types';

// 시연용 가상 인사 근태 기록이에요. 실제 사람이 아니에요. 가상 직원 15명(모의 직원·임시 IdP 같은 사람)의 입사일과 휴가 쓴 날만 있어요.
// 회사 메일로 찾아서 모의 로그인·임시 IdP 어느 쪽으로 들어와도 같은 기록을 봐요.

const full = (...dates: string[]): LeaveUse[] => dates.map((date) => ({ date, kind: 'full' as const }));
const half = (...dates: string[]): LeaveUse[] => dates.map((date) => ({ date, kind: 'half' as const }));

const RECORDS: Record<string, LeaveRecord> = {
  // 근속 7년: 18일. 지난 연차 기간(2월)에 쓴 날은 이번 기간에 들어가지 않아요. 11월 6일은 예정이에요.
  'haneul@corp.example': {
    hireDate: '2019-03-04',
    uses: [
      ...full('2026-02-13', '2026-04-10', '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-11-06'),
      ...half('2026-05-22', '2026-09-18'),
    ],
  },
  // 입사 1년 미만: 개근한 달마다 1일
  'doyun@corp.example': { hireDate: '2025-12-01', uses: [...full('2026-03-13', '2026-08-14'), ...half('2026-06-05')] },
  'seoyeon@corp.example': { hireDate: '2022-07-01', uses: [...full('2026-08-03', '2026-08-04'), ...half('2026-10-02')] },
  'jihu@corp.example': {
    hireDate: '2016-01-04',
    uses: [
      ...full('2026-02-16', '2026-02-17', '2026-05-04', '2026-05-06', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'),
      ...half('2026-06-12', '2026-10-09'),
    ],
  },
  'minjun@corp.example': { hireDate: '2023-09-01', uses: half('2026-10-05') },
  'seojun@corp.example': { hireDate: '2024-02-19', uses: [...full('2026-03-20'), ...half('2026-09-11')] },
  'haeun@corp.example': { hireDate: '2021-11-08', uses: full('2026-01-02', '2026-06-19') },
  'jiwoo@corp.example': { hireDate: '2020-05-25', uses: [...full('2026-07-06', '2026-07-07', '2026-07-08'), ...half('2026-10-16')] },
  'yejun@corp.example': { hireDate: '2018-08-13', uses: half('2026-09-04', '2026-10-23') },
  'sua@corp.example': { hireDate: '2026-06-01', uses: full('2026-09-25') },
  'eunwoo@corp.example': { hireDate: '2015-03-02', uses: full('2026-04-03', '2026-08-17', '2026-08-18') },
  'yuna@corp.example': { hireDate: '2024-10-14', uses: [] },
  'siwoo@corp.example': { hireDate: '2023-01-09', uses: [...full('2026-02-02'), ...half('2026-05-15', '2026-07-24')] },
  'dain@corp.example': { hireDate: '2012-04-02', uses: full('2026-05-01', '2026-10-19', '2026-10-20') },
  'juwon@corp.example': { hireDate: '2005-06-07', uses: [...full('2026-06-08', '2026-08-24', '2026-08-25'), ...half('2026-09-30')] },
};

export class MockLeave implements LeaveAdapter {
  readonly capabilities: AdapterCapabilities = { name: 'mock-leave', label: '인사 근태 기록(가상 연차 자료)', mock: true };
  /** 시연 중 인사팀이 승인한 날(ADR-24). 이 서버 메모리에만 있고, 다시 뜨면 처음 자료로 돌아가요. */
  private readonly approved = new Map<string, LeaveUse[]>();

  async leaveOf(person: { idpSubject: string; email?: string }): Promise<LeaveRecord | null> {
    const record = person.email ? RECORDS[person.email] : undefined;
    if (!record) return null;
    return { hireDate: record.hireDate, uses: [...record.uses, ...(this.approved.get(person.email!) ?? [])].map((u) => ({ ...u })) };
  }

  async recordUses(person: { idpSubject: string; email?: string }, uses: LeaveUse[]): Promise<'recorded' | 'not-found'> {
    if (!person.email || !RECORDS[person.email]) return 'not-found';
    this.approved.set(person.email, [...(this.approved.get(person.email) ?? []), ...uses.map((u) => ({ ...u }))]);
    return 'recorded';
  }
}
