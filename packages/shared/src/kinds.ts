// 앞문 라우터가 나누는 종류(R7). 화면에는 한글, 코드에는 영문을 써요.
export const KINDS = ['navi', 'notices', 'rooms', 'pantry', 'unknown'] as const;
export type Kind = (typeof KINDS)[number];

// 끄기 스위치가 붙는 모듈. unknown은 담당 안내(navi)로 가요.
// cafeteria(11/6, ADR-29): 사내 카페 주문. 출시 기본 끔이에요. 앞문 라우터 종류(KINDS)에는 아직 넣지 않아요(채팅 주문은 다음 묶음).
export const MODULES = ['navi', 'notices', 'rooms', 'pantry', 'cafeteria'] as const;
export type ModuleKind = (typeof MODULES)[number];

/** 앞문 라우터가 보내는 모듈(종류 중 unknown 빼고). 카페(cafeteria)는 아직 들어 있지 않아요(채팅 주문은 다음 묶음, ADR-29). */
export const ROUTER_MODULES = ['navi', 'notices', 'rooms', 'pantry'] as const satisfies readonly ModuleKind[];
export type RouterModule = (typeof ROUTER_MODULES)[number];

// 역할(R7). 세션에는 누구인지만 담고, 역할은 요청마다 다시 계산해요(ADR-13).
// team-lead(11/4, ADR-28): 팀장. 여러 팀 회의 참석자를 고르고, 마이 페이지에서 팀 회의 담당자를 정해요.
// cafe(11/6, ADR-29): 등록된 바리스타(회사 IdP 역할 그룹 /역할/cafe). 카페 판을 보고 주문 상태·품절·영업을 바꿔요.
const ROLES = ['employee', 'facilities', 'chart-owner', 'operator', 'team-lead', 'cafe'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  employee: '직원',
  facilities: '총무',
  'chart-owner': '분장표 주인',
  operator: '운영자',
  'team-lead': '팀장',
  cafe: '바리스타',
};
