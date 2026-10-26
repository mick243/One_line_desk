import { MCP_SCOPES, type McpScope, type ModuleKind, type OpsSettings } from '@one-line-desk/shared';
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

const SCOPE_BY_MODULE: Partial<Record<ModuleKind, McpScope>> = { rooms: 'rooms.read', notices: 'notices.read' };

/** 도구마다 필요한 범위. rooms_find_free → rooms.read, notices_search → notices.read. 범위가 없는 도구는 MCP로 부를 수 없어요. */
export function scopeOf(tool: Pick<ToolDef, 'module'>): McpScope | undefined {
  return SCOPE_BY_MODULE[tool.module];
}

/** 지금 쓸 수 있는 도구의 범위 목록 */
export function scopesOf(tools: ToolDef[]): McpScope[] {
  return MCP_SCOPES.filter((s) => tools.some((t) => scopeOf(t) === s));
}
