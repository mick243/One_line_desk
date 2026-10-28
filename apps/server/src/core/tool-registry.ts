import type { ModuleKind, OpsSettings } from '@one-line-desk/shared';

// 도구 레지스트리(ADR-01). 모듈별 허용 목록·MCP 도구 목록·시험·문서가 이 표 하나를 써요.
// 이름은 모듈 접두어 + 동작이에요. LLM과 MCP 어디에도 쓰기 도구는 없어요.
export interface ToolField {
  type: 'string' | 'integer' | 'string[]';
  description: string;
  optional?: boolean;
  maxLength?: number;
}

export interface ToolDef {
  name: string;
  module: ModuleKind;
  access: 'read';
  mcpExposed: boolean;
  description: string;
  input: Record<string, ToolField>;
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

/** 모듈이 켬이고 MCP 전체 스위치가 켬일 때만 MCP 도구가 나와요(M5). */
export function listMcpTools(settings: OpsSettings): ToolDef[] {
  if (!settings.mcp) return [];
  return TOOLS.filter((t) => t.mcpExposed && settings.modules[t.module] === 'on');
}

/** 모듈 호출에는 그 모듈 허용 목록의 도구만 넣어요(ADR-10). */
export function toolsForModule(module: ModuleKind, settings: OpsSettings): ToolDef[] {
  if (settings.modules[module] === 'off') return [];
  return TOOLS.filter((t) => t.module === module);
}
