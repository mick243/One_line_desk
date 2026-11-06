import type { Role } from '@one-line-desk/shared';
import type { EmployeeProfile } from '../adapters/types';

// 역할은 세션에 담지 않고 요청마다 다시 계산해요(ADR-13, R17).
export function computeRoles(profile: EmployeeProfile, chartOwnerDepartments: Set<string>): Role[] {
  const roles: Role[] = ['employee'];
  if (profile.groups.includes('facilities')) roles.push('facilities');
  if (chartOwnerDepartments.has(profile.department)) roles.push('chart-owner');
  if (profile.groups.includes('operator')) roles.push('operator');
  if (profile.groups.includes('team-lead')) roles.push('team-lead');
  // 바리스타(11/6, ADR-29): 회사 IdP 역할 그룹 /역할/cafe. 다른 역할과 같은 길이에요.
  if (profile.groups.includes('cafe')) roles.push('cafe');
  return roles;
}
