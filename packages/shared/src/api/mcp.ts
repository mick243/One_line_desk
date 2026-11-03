// 읽기 전용 MCP(ADR-14·15). 범위는 둘뿐이에요.
export const MCP_SCOPES = ['rooms.read', 'notices.read'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

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
export interface CliApp {
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
 * GET /api/ops/mcp/report. 셈만 있고 사람·검색어·도구 입력은 없어요.
 * 감사 로그는 7일만 남아서(ADR-21) 결과별 셈은 "최근 7일"이에요. 접속기록(1년)으로 셀 수 있는 연결·호출·끊기만 "이번 달"이에요.
 */
export interface McpReport {
  /** 셈한 시각(ISO) */
  generatedAt: string;
  /** 이번 달(한국 시간 1일 0시부터), 접속기록에서 */
  month: { from: string; connects: number; calls: number; callers: number; disconnects: number };
  /** 최근 7일, 감사 로그에서 */
  recent7Days: {
    from: string;
    toolCalls: { found: number; none: number; refused: number; error: number };
    consents: { allowed: number; denied: number };
    tokenRefused: number;
    /** 등록되지 않았거나 허락되지 않은 앱이 연결하려다 막힌 수 */
    blockedApps: number;
    /** 재직 재확인에서 퇴사로 끊긴 수(웹 세션과 MCP 승인을 함께 끊어요) */
    leaverEnded: number;
  };
  /** 지금 */
  now: { clients: number; approvedClients: number; people: number; devices: number };
}
