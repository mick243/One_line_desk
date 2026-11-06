import { CAFE_TEXT } from '@one-line-desk/shared';

// 카페 판 전용 세션(11/6 3묶음, 사용자 결정, ADR-20 예외·ADR-29).
// 카운터 기기는 로그인 화면의 [카페 판으로 로그인]으로 들어와요. 이 세션은 카페 판 권한만 있어서, 아래 허용 목록의 경로만 열려요.
// 허용 목록 방식이라 새 경로가 생겨도 여기에 적지 않으면 판 세션으로는 403이에요(기본 거부).
// 로그인한 경로는 모두 ctx.guards.user를 지나서, 가드가 이 목록으로 막아요(core/guard.ts).
// 공개 경로(로그인 전 공개 설정·로그인 시작·건강 확인)는 세션을 보지 않아서 여기에 적지 않아요.

/** "방법 경로" 모양이에요. 경로는 Fastify에 등록한 모양(:id)이에요. */
const BOARD_ROUTES: ReadonlySet<string> = new Set([
  // 화면에 꼭 필요한 내 정보 최소(판 세션인지·끝나는 때·CSRF 토큰)와 로그아웃
  'GET /api/me',
  'POST /api/auth/logout',
  // S8 카페 판: 읽기(3초마다 배경 요청)·영업 시작·끝·주문 상태·품절
  'GET /api/cafe/board',
  'POST /api/cafe/board/open',
  'POST /api/cafe/board/close',
  'POST /api/cafe/orders/:id/status',
  'PUT /api/cafe/menu/:id/sold-out',
]);

/** 판 전용 세션으로 이 경로를 불러도 되는지. 등록한 경로 모양(routeUrl)이 없으면(없는 주소) 거부해요. */
export function boardAllows(method: string, routeUrl: string | undefined): boolean {
  return routeUrl !== undefined && BOARD_ROUTES.has(`${method} ${routeUrl}`);
}

/** 허용 목록 밖 경로를 판 세션으로 부르면(403) */
export const BOARD_ONLY = { error: 'board-only', message: CAFE_TEXT.boardOnly } as const;
