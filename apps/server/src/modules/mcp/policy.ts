import { MCP_SCOPES, type McpScope, type OpsSettings } from '@one-line-desk/shared';
import type { AdapterCapabilities } from '../../adapters/types';
import { listMcpTools, type ToolDef } from '../../core/tool-registry';

// 허용 클라이언트 정책과 MCP 켜기 규칙(ADR-12·15, M2·M5).

export interface ClientPolicy {
  securityApproved: boolean;
  demoOnly: boolean;
}

/** 데이터가 모두 모의(등급 0)인지. 어댑터 하나라도 실제면 거짓이에요. */
export function isAllMockData(adapters: AdapterCapabilities[]): boolean {
  return adapters.every((a) => a.mock);
}

/**
 * 허용 목록 안인지(허용 두 겹 중 정책 겹).
 * 보안팀 승인 목록에 오른 클라이언트이거나, 시연용 클라이언트이면서 데이터가 모두 모의일 때만이에요.
 */
export function isClientAllowed(client: ClientPolicy, allMockData: boolean): boolean {
  return client.securityApproved || (client.demoOnly && allMockData);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function loopbackUrl(uri: string): URL | null {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password && !url.hash ? url : null;
  } catch {
    return null;
  }
}

/**
 * 리디렉트 주소가 등록된 주소와 맞는지(ADR-15, 11/2 개정).
 * - 기본은 글자 그대로 같아야 해요.
 * - 등록 주소가 포트 없는 루프백(http://localhost/callback·http://127.0.0.1/callback·http://[::1]/callback)이면
 *   CLI가 고른 포트는 상관없이 호스트·경로·쿼리만 맞추면 받아요(RFC 8252 §7.3). localhost와 127.0.0.1은 서로 다른 주소로 봐요.
 * - 공개 클라이언트는 루프백 주소로만 돌아가요. 비밀이 없어서 바깥 주소로 코드를 보내면 가로챌 수 있어요.
 */
export function redirectMatches(client: { redirectUris: string[]; publicClient: boolean }, given: string): boolean {
  const givenLoopback = loopbackUrl(given);
  if (client.publicClient && !givenLoopback) return false;
  return client.redirectUris.some((registered) => {
    if (registered === given) return true;
    const reg = loopbackUrl(registered);
    if (!reg || reg.port !== '' || !givenLoopback) return false;
    return givenLoopback.hostname === reg.hostname && givenLoopback.pathname === reg.pathname && givenLoopback.search === reg.search;
  });
}

/**
 * 실제 어댑터인데 허용 목록(보안팀 승인 클라이언트)이 비어 있으면 MCP를 켜지 않아요(ADR-12·15).
 * 모의 데이터만 쓰는 시연에서는 스위치만 보면 돼요.
 */
export function canRunMcp(input: { switchOn: boolean; allMockData: boolean; approvedClients: number }): boolean {
  if (!input.switchOn) return false;
  return input.allMockData || input.approvedClients > 0;
}

/** 지금 MCP에 내보내는 도구. MCP를 못 켜면 비어 있어요. 모듈 스위치는 레지스트리가 봐요(M5). */
export function availableTools(settings: OpsSettings, runnable: boolean): ToolDef[] {
  return runnable ? listMcpTools(settings) : [];
}

/** 도구마다 필요한 범위(레지스트리의 mcp.scope). 범위가 없는 도구는 MCP로 부를 수 없어요. */
export function scopeOf(tool: Pick<ToolDef, 'mcp'>): McpScope | undefined {
  return tool.mcp?.scope;
}

/** 지금 쓸 수 있는 도구의 범위 목록 */
export function scopesOf(tools: ToolDef[]): McpScope[] {
  return MCP_SCOPES.filter((s) => tools.some((t) => scopeOf(t) === s));
}
