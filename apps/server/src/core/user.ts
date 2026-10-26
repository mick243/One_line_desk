import type { Role } from '@one-line-desk/shared';

/** 요청마다 세션 + 디렉터리로 만드는 사용자. 세션에는 "누구인지"만 있고 역할은 매번 계산해요(R17). */
export interface DeskUser {
  sessionId: string;
  pseudonymId: string;
  idpSubject: string;
  displayName: string;
  department: string;
  floor: string;
  roles: Role[];
}

export function hasRole(user: DeskUser, role: Role): boolean {
  return user.roles.includes(role);
}
