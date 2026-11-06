import type { Card, CardAction } from '../cards';

// 읽기 전용 MCP(ADR-14·15). 11/3 2단계(ADR-14 개정): 담당 찾기·IT FAQ·첫 2주(navi.read)와 내 요청 상태(mine.read)를 더해 넷이에요.
// 11/3 확인 링크 넓히기: 휴가 준비(leave.prepare)·같이 채워요(pantry.read)를 더해요. 장비 대여는 회의실(rooms.read) 안이에요.
// 이미 연결한 사람은 끊지 않아요. 새 범위의 도구를 부르면 403 insufficient_scope로 다시 허락을 받아요.
export const MCP_SCOPES = ['rooms.read', 'notices.read', 'navi.read', 'mine.read', 'leave.prepare', 'pantry.read'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** POST /api/mcp/link: 앱 확인 링크(/r/<토큰>)가 무엇을 여는지. 링크를 연 것만으로는 아무것도 쓰지 않아요. */
export interface LinkOpenRequest {
  proposalToken: string;
}

/** 열지 못한 링크가 어느 기능 것인지. 화면이 기능에 맞는 안내와 버튼을 골라요. 담당 팀 문의 링크는 비워 둬요. */
export type LinkAbout = 'leave' | 'pantry' | 'equipment';

/**
 * - rooms: 회의실 예약 링크 → 화면이 /api/rooms/recheck로 지금 다시 확인해요
 * - inquiry: 담당 팀 문의 링크 → 그 팀 문의 양식을 빈 칸으로 열어요(질문 글은 링크에 없어요, R13)
 * - leave: 휴가 준비 링크 → 휴가 신청 양식을 그 날짜·종류로 채워 열어요. 사유는 앱에서 직접 골라요(남은 연차는 본인 화면에서만)
 * - leave-check: 11/6 A안(앱 안 휴가 결재가 꺼져 있을 때, 운영 기본) → 그 날짜·종류의 신청 전 카드(남은 연차·그날 내 일정·
 *   [그룹웨어에서 신청하기]). 신청·결재는 회사 그룹웨어가 해요
 * - pantry:판 품목 링크 → 지금 다시 읽은 그 품목 카드. [여기에 +1]은 사람이 누르는 고정 버튼이에요
 * - pantry-new: 새 요청 링크 → 판의 요청 쓰기 칸을 빈 채로 열어요(품목 이름은 링크에 없어요)
 * - equipment: 장비 대여 링크 → 지금 다시 확인한 남은 수 카드. [빌리기] → 확인 시트가 유일한 확인이에요
 * - gone: 그 업무·품목이 없어요 · expired: 링크 시간이 지났어요 · off: 그 기능이 꺼져 있어요
 */
export type LinkOpenResponse =
  | { kind: 'rooms' }
  | { kind: 'inquiry'; rowId: string | null; team: string; task: string }
  | { kind: 'leave'; action: Extract<CardAction, { type: 'leave-request' }> }
  | { kind: 'leave-check'; card: Card }
  | { kind: 'pantry'; cards: Card[] }
  | { kind: 'pantry-new' }
  | { kind: 'equipment'; cards: Card[] }
  | { kind: 'gone' | 'expired' | 'off'; about?: LinkAbout };

/** S6 "연결된 AI 앱" 줄. "마지막 사용"은 두지 않아요(M4). */
export interface ConnectedApp {
  clientId: string;
  appName: string;
  /** YYYY-MM-DD */
  connectedOn: string;
  scopes: McpScope[];
  /** 이 앱을 연결해 둔 기기 수(11/2, 기기별 승인). [끊기]는 모든 기기를 끊어요. */
  devices: number;
}

/** S6 "연결하는 법": 회사가 허락한 CLI 앱(공개 클라이언트). 클라이언트 ID는 비밀이 아니에요. */
interface CliApp {
  clientId: string;
  appName: string;
}

/** GET /api/mcp/connections */
export interface ConnectionsResponse {
  /** MCP 전체 스위치와 계약 전 잠금(ADR-15)을 반영해 지금 MCP를 쓸 수 있는지 */
  available: boolean;
  /** 지금 켜져 있는 도구의 범위. 빠진 범위는 S6 줄에서 "지금 꺼져 있어요"로 보여요. */
  tools: McpScope[];
  apps: ConnectedApp[];
  /** CLI에 넣을 MCP 주소 */
  mcpUrl: string;
  /** 지금 연결할 수 있는 CLI 앱. MCP를 못 쓰면 비어 있어요. */
  cliApps: CliApp[];
}

/**
 * GET /api/mcp/consent?req=… 동의 시트에 그릴 것(M4).
 * - ready: 앱 이름, 돌아갈 곳(리디렉트 호스트), 지금 쓸 수 있는 도구
 * - not-allowed: 허용 목록 밖 앱 → "회사가 허락하지 않은 앱이라 연결할 수 없어요"
 * - no-tools: MCP 끔이거나 도구가 하나도 없음 → "지금 연결할 수 있는 도구가 없어요"
 * - expired·invalid: 연결 요청이 오래됐거나 맞지 않아요
 */
export type ConsentInfo =
  | { status: 'ready'; appName: string; redirectHost: string; tools: McpScope[]; roomsWrite: boolean }
  | { status: 'not-allowed' | 'no-tools' | 'expired' | 'invalid' };

/** POST /api/mcp/consent. 동의 시트 자체가 확인이에요(R2). 버튼 둘은 무게가 같고 기본 선택이 없어요. */
export interface ConsentDecisionRequest {
  req: string;
  decision: 'allow' | 'deny';
}

export interface ConsentDecisionResponse {
  result: 'allowed' | 'denied';
  /** AI 앱으로 돌아갈 주소(인가 코드 또는 access_denied) */
  redirectTo: string;
}

// ── 운영자 관리(11/3, MCP 통합 회의 1단계). 운영자 웹 화면은 없고(R7) API와 명령 도구(npm run mcp:clients)만 있어요. ──

/** GET /api/ops/mcp/clients 한 줄. 연결한 사람의 이름·가명 ID 목록은 없고 셈만 있어요. */
export interface McpClientSummary {
  clientId: string;
  appName: string;
  /** 기밀(비밀 있음) 또는 공개(비밀 없음, 루프백 리디렉트만) */
  kind: 'confidential' | 'public';
  /** 시연용: 데이터가 모두 모의일 때만 허용 목록 안이에요. */
  demoOnly: boolean;
  /** 보안팀 승인. 실제 자료는 승인 클라이언트에만 가요. */
  securityApproved: boolean;
  redirectUris: string[];
  /** 지금 연결해 둔 사람 수 */
  people: number;
  /** 지금 연결해 둔 기기 수(승인 수) */
  devices: number;
  /** YYYY-MM-DD */
  createdOn: string;
}

/** POST /api/ops/mcp/clients. 등록만 하고 보안팀 승인은 따로 켜요. */
export interface McpClientCreateRequest {
  appName: string;
  kind: 'confidential' | 'public';
  redirectUris: string[];
  demoOnly?: boolean;
}

/** 기밀 클라이언트의 비밀은 이 응답에서 한 번만 보여요. 서버에는 해시만 남아요. */
export interface McpClientCreateResponse {
  client: McpClientSummary;
  clientSecret?: string;
}

/**
 * MCP 날마다 셈의 종류(11/3, 530_mcp_daily_counts.sql의 check 목록과 같아요). 감사 로그를 남기는 자리에서 그때그때 +1 해요.
 * - call.*: 도구 호출 결과(감사 로그 결과 found·none·refused·error)
 * - connect·connect.denied: 동의 시트 [연결 허락]·[허락하지 않기]
 * - disconnect: 끊긴 연결(기기) 수 — 본인 [끊기]·기기 폐기(RFC 7009)·모든 기기 로그아웃·퇴사 확인
 * - disconnect.ops: 운영자가 끊은 연결(기기) 수 — 앱별 강제 끊기·회수·사람별 강제 끊기
 * - token.refused: 갱신 거부, authorize.blocked: 등록 안 됐거나 허락 안 된 앱, employment.ended: MCP 쪽 재직 재확인에서 퇴사로 끊김
 */
export const MCP_COUNT_KINDS = [
  'call.found',
  'call.none',
  'call.refused',
  'call.error',
  'connect',
  'connect.denied',
  'disconnect',
  'disconnect.ops',
  'token.refused',
  'authorize.blocked',
  'employment.ended',
] as const;
export type McpCountKind = (typeof MCP_COUNT_KINDS)[number];

/**
 * GET /api/ops/mcp/report?month=YYYY-MM. 셈만 있고 사람·검색어·도구 입력·클라이언트 ID는 없어요.
 * 종류별·앱별 합계는 날마다 셈 표(13개월 보관, ADR-21 예외)에서, 호출한 사람 수는 접속기록(1년)에서만 셀 수 있어요.
 */
export interface McpReport {
  /** 셈한 시각(ISO) */
  generatedAt: string;
  /** 보고한 달(YYYY-MM, 한국 시간) */
  month: string;
  /** 그 달 1일 0시(한국 시간)와 다음 달 1일 0시(ISO) */
  from: string;
  to: string;
  /** 그 달 종류별 합계(날마다 셈 표). 없는 종류는 0이에요. */
  totals: Record<McpCountKind, number>;
  /** 그 달 앱 이름별 종류 합계. 앱을 모르는 셈(등록 안 된 앱이 막힌 것 등)은 '-'예요. */
  byApp: { app: string; counts: Partial<Record<McpCountKind, number>> }[];
  /** 그 달 접속기록에서 센 연결 허락·도구 호출·끊기 줄 수와 호출한 사람 수(사람 수는 접속기록에서만 셀 수 있어요) */
  accessLog: { connects: number; calls: number; callers: number; disconnects: number };
  /** 지금 */
  now: { clients: number; approvedClients: number; people: number; devices: number };
}

/** POST /api/ops/mcp/people/disconnect. 직원 검색(POST /api/people/search)이 돌려준 ref를 그대로 보내요. */
export interface McpPersonDisconnectRequest {
  ref: string;
}

/** 끊은 연결(기기) 수만 돌려줘요. 그 사람이 어떤 앱을 언제 연결했는지는 돌려주지 않아요. */
export interface McpPersonDisconnectResponse {
  removed: number;
}
