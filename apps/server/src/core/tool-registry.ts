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
    description: '업무 분장표에서 후보 행을 찾아요. LLM은 후보 중 행 ID 하나 또는 없음만 골라요(ADR-09).',
    input: { query: { type: 'string', description: '공통 검사를 지난 질문', maxLength: 300 } },
  },
  {
    name: 'notices_search',
    module: 'notices',
    access: 'read',
    mcpExposed: true,
    description: '허용 게시판 공지의 제목·게시일·원문 링크만 찾아요. 본문·요약은 돌려주지 않아요(ADR-14).',
    input: { query: { type: 'string', description: '검색어', maxLength: 100 } },
  },
  {
    name: 'rooms_find_free',
    module: 'rooms',
    access: 'read',
    mcpExposed: true,
    description: '빈 회의실 후보 최대 3개와 앱 확인 링크를 돌려줘요. 예약자·회의 제목은 없어요(ADR-14).',
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
    description: '같은 층 열린 품목 중 같은 상품 같아 보이는 것을 찾아요(R15).',
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
