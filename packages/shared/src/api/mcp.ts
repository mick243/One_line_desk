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
}

/** GET /api/mcp/connections */
export interface ConnectionsResponse {
  /** MCP 전체 스위치와 계약 전 잠금(ADR-15)을 반영해 지금 MCP를 쓸 수 있는지 */
  available: boolean;
  /** 지금 켜져 있는 도구의 범위. 빠진 범위는 S6 줄에서 "지금 꺼져 있어요"로 보여요. */
  tools: McpScope[];
  apps: ConnectedApp[];
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
