// 앞문 라우터가 나누는 종류(R7). 화면에는 한글, 코드에는 영문을 써요.
export const KINDS = ['navi', 'notices', 'rooms', 'pantry', 'unknown'] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL: Record<Kind, string> = {
  navi: '담당',
  notices: '공지',
  rooms: '회의실',
  pantry: '탕비실',
  unknown: '모름',
};

// 끄기 스위치가 붙는 모듈. unknown은 담당 안내(navi)로 가요.
export const MODULES = ['navi', 'notices', 'rooms', 'pantry'] as const;
export type ModuleKind = (typeof MODULES)[number];

// 역할(R7). 세션에는 누구인지만 담고, 역할은 요청마다 다시 계산해요(ADR-13).
export const ROLES = ['employee', 'facilities', 'chart-owner', 'operator'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  employee: '직원',
  facilities: '총무',
  'chart-owner': '분장표 주인',
  operator: '운영자',
};
