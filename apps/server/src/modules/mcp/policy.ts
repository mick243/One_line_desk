import { MCP_SCOPES, type McpScope, type OpsSettings } from '@one-line-desk/shared';
import type { AdapterCapabilities } from '../../adapters/types';
import { listMcpTools, type ToolDef } from '../../core/tool-registry';

// 허용 클라이언트 정책과 MCP 켜기 규칙(ADR-12·15, M2·M5).

interface ClientPolicy {
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

/** 루프백(localhost·127.0.0.1·[::1]) http 주소인지. 공개 클라이언트는 이런 주소로만 돌아가요. */
function isLoopbackRedirect(uri: string): boolean {
  return loopbackUrl(uri) !== null;
}

export const APP_NAME_MAX = 40;
export const MAX_REDIRECTS = 5;
const REDIRECT_MAX_LENGTH = 500;

/**
 * 운영자가 등록하는 클라이언트 검사(11/3, 1단계). 맞으면 다듬은 값, 아니면 화면에 보일 까닭이에요.
 * - 공개 클라이언트: 루프백 http 주소만(비밀이 없어서 바깥 주소로 코드를 보내면 가로챌 수 있어요)
 * - 기밀 클라이언트: https 주소(사용자 정보·조각 없음) 또는 개발용 루프백
 */
export function checkRegistration(input: {
  appName: string;
  kind: 'confidential' | 'public';
  redirectUris: string[];
}): { ok: true; appName: string; redirectUris: string[] } | { ok: false; reason: string } {
  const appName = input.appName.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (!appName || appName.length > APP_NAME_MAX) return { ok: false, reason: `앱 이름은 1~${APP_NAME_MAX}자로 적어 주세요` };
  const uris = [...new Set(input.redirectUris.map((u) => u.trim()).filter(Boolean))];
  if (uris.length === 0 || uris.length > MAX_REDIRECTS) return { ok: false, reason: `리디렉트 주소는 1~${MAX_REDIRECTS}개예요` };
  for (const uri of uris) {
    if (uri.length > REDIRECT_MAX_LENGTH) return { ok: false, reason: '리디렉트 주소가 너무 길어요' };
    if (isLoopbackRedirect(uri)) continue;
    if (input.kind === 'public') return { ok: false, reason: '공개 클라이언트는 루프백 주소(http://localhost/… · http://127.0.0.1/…)로만 돌아가요' };
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return { ok: false, reason: `주소 모양이 아니에요: ${uri.slice(0, 80)}` };
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      return { ok: false, reason: '기밀 클라이언트 리디렉트는 https 주소예요(사용자 정보·# 조각 없이)' };
  }
  return { ok: true, appName, redirectUris: uris };
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
