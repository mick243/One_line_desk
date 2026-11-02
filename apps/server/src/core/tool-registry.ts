import type { McpScope, ModuleKind, OpsSettings } from '@one-line-desk/shared';

// 도구 레지스트리(ADR-01). 모듈별 허용 목록·MCP 도구 목록·범위·횟수 제한·노출 명세(docs/MCP_도구명세.md)가 이 표 하나를 써요.
// 이름은 모듈 접두어 + 동작이에요. LLM과 MCP 어디에도 쓰기 도구는 없어요.
// MCP 도구를 더할 때(11/2 정리): 여기에 mcp 칸을 적고, modules/mcp/tools.ts의 MCP_TOOL_IMPLS에 입력·출력·실행을 하나 더해요.
// 범위 이름은 shared MCP_SCOPES에 먼저 적어요. 그 밖에 고칠 곳은 없어요(시험이 둘이 맞는지 봐요).
export interface ToolField {
  type: 'string' | 'integer' | 'string[]';
  description: string;
  optional?: boolean;
  maxLength?: number;
}

/** MCP로 내보내는 도구만 가져요. */
export interface McpToolMeta {
  /** 이 도구를 부르려면 연결에 있어야 하는 범위 */
  scope: McpScope;
  /** AI 앱이 보여 주는 이름 */
  title: string;
  /** 일부러 내보내지 않는 칸. 노출 명세에 그대로 적혀요. */
  withheld: string[];
}

export interface ToolDef {
  name: string;
  module: ModuleKind;
  access: 'read';
  mcpExposed: boolean;
  description: string;
  input: Record<string, ToolField>;
  mcp?: McpToolMeta;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'navi_find_rows',
    module: 'navi',
    access: 'read',
    mcpExposed: false,
    // ADR-09·10
    description: '업무 분장표에서 후보 행을 찾아요. LLM은 후보 번호 하나 또는 없음만 골라요. 행 ID는 스키마에 넣지 않아요.',
    input: { query: { type: 'string', description: '공통 검사를 지난 질문', maxLength: 300 } },
  },
  {
    name: 'notices_search',
    module: 'notices',
    access: 'read',
    mcpExposed: true,
    mcp: { scope: 'notices.read', title: '공지 찾기', withheld: ['공지 본문', '발췌·요약', '작성자'] },
    // ADR-14. 설명은 MCP 클라이언트(Claude 등)가 그대로 읽어서 내부 문서 번호를 넣지 않아요.
    description:
      '허용 게시판 공지의 제목·게시일·원문 링크만 찾아요. 본문·요약은 돌려주지 않으니, 내용은 원문 링크에서 확인하라고 안내해 주세요. 하나도 없으면 emptyReason에 찾아본 게시판이 있어요.',
    input: { query: { type: 'string', description: '검색어', maxLength: 100 } },
  },
  {
    name: 'rooms_find_free',
    module: 'rooms',
    access: 'read',
    mcpExposed: true,
    mcp: { scope: 'rooms.read', title: '빈 회의실 찾기', withheld: ['예약자', '회의 제목', '방별 하루 일정', '참석자'] },
    // ADR-14
    description:
      '빈 회의실 후보 최대 3개(인원에 가장 꼭 맞는 회의실부터)와 앱 확인 링크를 돌려줘요. 후보마다 정원·장비·설비가 있어요. 예약자·회의 제목은 없어요. ' +
      '후보가 없으면 emptyReason에 까닭이 있고, 가까운 시간 대안을 최대 2개 줘요.',
    input: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      start: { type: 'string', description: 'HH:MM' },
      minutes: { type: 'integer', description: '회의 길이(분). 비우면 운영 설정 기본값', optional: true },
      people: { type: 'integer', description: '인원' },
      equipment: { type: 'string[]', description: '정해진 장비 목록 중에서', optional: true },
      floor: { type: 'string', description: '층', optional: true },
    },
  },
  {
    name: 'pantry_find_similar',
    module: 'pantry',
    access: 'read',
    mcpExposed: false,
    // R15
    description: '같은 층 열린 품목 중 같은 상품 같아 보이는 것을 찾아요.',
    input: { itemName: { type: 'string', description: '사용자가 확인한 품목 이름', maxLength: 60 } },
  },
];

export type McpToolDef = ToolDef & { mcp: McpToolMeta };

/** MCP로 내보낼 수 있는 도구 전부(스위치와 상관없이). 노출 명세·운영 화면이 써요. */
export const MCP_TOOLS: McpToolDef[] = TOOLS.filter((t): t is McpToolDef => t.mcpExposed && !!t.mcp);

/** MCP 전체 스위치·모듈 스위치가 켬이고, 운영자가 그 도구를 따로 끄지 않았을 때만 나와요(M5, 11/2 도구별 스위치). */
export function listMcpTools(settings: OpsSettings): McpToolDef[] {
  if (!settings.mcp) return [];
  return MCP_TOOLS.filter((t) => settings.modules[t.module] === 'on' && !settings.mcpToolsOff.includes(t.name));
}

/** 모듈 호출에는 그 모듈 허용 목록의 도구만 넣어요(ADR-10). */
export function toolsForModule(module: ModuleKind, settings: OpsSettings): ToolDef[] {
  if (settings.modules[module] === 'off') return [];
  return TOOLS.filter((t) => t.module === module);
}
