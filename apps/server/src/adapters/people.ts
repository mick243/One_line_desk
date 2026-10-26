import type { EmployeeProfile } from './types';

/** 이름·부서에 검색어가 들어 있는 사람(모의 직원·임시 IdP가 같이 써요). 빈 검색어면 아무도 주지 않아요. */
export function matchPeople<T extends EmployeeProfile>(people: T[], query: string, limit: number): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return people.filter((p) => p.displayName.toLowerCase().includes(q) || p.department.toLowerCase().includes(q)).slice(0, limit);
}
