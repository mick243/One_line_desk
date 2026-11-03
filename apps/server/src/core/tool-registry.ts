import type { McpScope, ModuleKind, OpsSettings } from '@one-line-desk/shared';

// 도구 레지스트리(ADR-01). 모듈별 허용 목록·MCP 도구 목록·범위·횟수 제한·노출 명세(docs/MCP_도구명세.md)가 이 표 하나를 써요.
// 이름은 모듈 접두어 + 동작이에요. LLM과 MCP 어디에도 쓰기 도구는 없어요.
// MCP 도구를 더할 때(11/2 정리): 여기에 mcp 칸을 적고, modules/mcp/tools.ts의 MCP_TOOL_IMPLS에 입력·출력·실행을 하나 더해요.
// 범위 이름은 shared MCP_SCOPES에 먼저 적어요. 그 밖에 고칠 곳은 없어요(시험이 둘이 맞는지 봐요).
interface ToolField {
  type: 'string' | 'integer' | 'string[]' | 'object[]';
  description: string;
  optional?: boolean;
  maxLength?: number;
}

/** MCP로 내보내는 도구만 가져요. */
interface McpToolMeta {
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
  // 11/3 2단계(ADR-14 개정, 사용자 결정): 읽기 도구 셋을 더해요. 모두 규칙·색인만 쓰고 LLM을 부르지 않아요.
  // 쓰기는 결과의 앱 확인 링크를 사람이 열어 앱에서 한 번 눌러요. 설명은 AI 앱이 그대로 읽어서 내부 문서 번호를 넣지 않아요.
  {
    name: 'navi_find_team',
    module: 'navi',
    access: 'read',
    mcpExposed: true,
    mcp: {
      scope: 'navi.read',
      title: '받을 팀 찾기',
      withheld: ['분장표 행 ID', '주인 부서', '담당자 이름', '질문 글(어디에도 남지 않아요)', '남은 연차'],
    },
    description:
      '업무 분장표에서 이 일을 어느 팀에 물어야 하는지 후보 최대 3개(업무·담당 팀·창구·지금 할 일·처리 기간·개정일)를 돌려줘요. 사람 이름은 없어요. ' +
      '후보마다 문의 양식 앱 링크가 있어요. 링크는 받을 팀만 담고 질문 글은 담지 않아서, 사람이 앱에서 내용을 직접 써서 [보내기]를 눌러요. 확정은 앱에서 한 번이에요. ' +
      '맞는 업무가 없으면 emptyReason과 대표 창구 문의 링크를 줘요. 분장표에 없는 내용을 지어내지 말아 주세요.',
    input: { query: { type: 'string', description: '무슨 일인지 한 줄(예: 법인카드를 잃어버렸어요)', maxLength: 300 } },
  },
  {
    name: 'navi_it_faq',
    module: 'navi',
    access: 'read',
    mcpExposed: true,
    mcp: { scope: 'navi.read', title: 'IT 오류 FAQ 찾기', withheld: ['붙여 넣은 오류 글(어디에도 남지 않아요)', 'FAQ 내부 번호', '분장표 행 ID'] },
    description:
      'IT 오류 창의 글로 사내 IT FAQ를 찾아 원문 단계를 그대로 돌려줘요. 단계를 고치거나 지어내지 말고 그대로 전해 주세요. ' +
      '오류 글에 든 이메일·사용자 폴더 같은 값은 가린 뒤 찾고, 글은 어디에도 남지 않아요. 키·비밀번호·주민번호가 든 글은 거절해요. ' +
      '안 풀리면 IT 담당 팀 문의 양식 앱 링크를 열어 사람이 직접 보내요(확정은 앱에서 한 번).',
    input: { text: { type: 'string', description: '오류 창에 뜬 글', maxLength: 1000 } },
  },
  {
    name: 'navi_onboarding',
    module: 'navi',
    access: 'read',
    mcpExposed: true,
    mcp: { scope: 'navi.read', title: '첫 2주 할 일', withheld: ['분장표 행 ID', '주인 부서', '담당자 이름', '진행 여부(저장하지 않아요)'] },
    description:
      '신규 입사자가 첫 1주·2주에 할 일 목록(업무·담당 팀·창구·지금 할 일·처리 기간)을 돌려줘요. 누구나 읽는 안내이고, 신규 입사자인지는 묻지도 판단하지도 않아요.',
    input: {},
  },
  {
    name: 'my_requests_status',
    module: 'navi',
    access: 'read',
    mcpExposed: true,
    mcp: {
      scope: 'mine.read',
      title: '내 요청 상태',
      withheld: ['문의·답장·반려 사유 글', '답한 사람 이름', '휴가 날짜와 남은 연차', '다른 사람의 요청', '참석자'],
    },
    description:
      '연결한 사람 본인이 보낸 문의·휴가 요청의 업무 이름·받은 팀·상태·보낸 날·답장 있음 여부와, 본인의 다가오는 회의실 예약(방·시간)을 돌려줘요. ' +
      '문의·답장 글은 없어서 내용은 앱에서 확인하라고 안내해 주세요. 취소·답장은 앱에서 해요.',
    input: {},
  },
  // 11/3 확인 링크 넓히기(ADR-14 개정, 사용자 요청): 휴가 준비·탕비실·장비 대여. 모두 읽기와 링크만이고 LLM을 부르지 않아요.
  // 링크(봉인 제안 토큰)에는 날짜·종류·카드 ID·장비 종류·시각 같은 구조 값만 넣어요. 사람이 쓴 글(사유·품목 이름)은 넣지 않아요.
  {
    name: 'leave_prepare',
    module: 'navi',
    access: 'read',
    mcpExposed: true,
    mcp: {
      scope: 'leave.prepare',
      title: '휴가 신청 준비',
      withheld: ['남은 연차', '올해 병가 쓴 날', '사유(앱에서 직접 골라요)', '받는 팀 담당자 이름'],
    },
    description:
      '휴가 신청 양식을 고른 날짜·종류로 채워 여는 앱 링크를 돌려줘요. 서버는 날짜 형식·주말·신청할 수 있는 기간만 확인해요. ' +
      '남은 연차나 병가 쓴 날 같은 숫자는 돌려주지 않으니, 숫자를 물으면 앱에서 보라고 안내해 주세요. ' +
      '사유는 링크에 담지 않아서 사람이 앱 양식에서 직접 고르거나 써요. 보내기는 앱 확인 시트에서 한 번이에요. 링크를 여는 것만으로는 아무것도 보내지 않아요.',
    input: {
      days: {
        type: 'object[]',
        description: '쓸 날 목록. 날마다 date(YYYY-MM-DD)와 kind(full 하루 · am 오전 반차 · pm 오후 반차). 반차인데 오전·오후를 모르면 먼저 사람에게 물어요',
      },
      type: { type: 'string', description: '종류: annual(연차) · official(공가) · sick(병가)' },
    },
  },
  {
    name: 'pantry_find_similar',
    module: 'pantry',
    access: 'read',
    mcpExposed: true,
    mcp: {
      scope: 'pantry.read',
      title: '탕비실 요청 찾기',
      withheld: ['표를 준 사람', '요청을 올린 사람', '찾은 품목 이름(어디에도 남지 않아요)', '다른 층 판'],
    },
    // R15. 묻기(LLM 허용 목록)와 MCP가 같이 써요. MCP 경로는 이름 규칙만 쓰고 LLM을 부르지 않아요.
    description:
      '연결한 사람 층의 탕비실 요청판에서 같은 상품 같아 보이는 열린 품목을 최대 3개(이름·지금 표 수) 돌려줘요. 누가 표를 줬는지는 없어요. ' +
      '품목마다 [여기에 +1] 앱 링크가 있고, +1은 사람이 앱에서 직접 눌러요. 찾는 품목이 없으면 새 요청 쓰기 앱 링크를 줘요. ' +
      '링크에는 품목 이름을 담지 않아서 새 요청은 사람이 앱에서 직접 써요. 링크를 여는 것만으로는 아무것도 바뀌지 않아요.',
    input: { itemName: { type: 'string', description: '찾을 품목 이름(예: 제로콜라)', maxLength: 60 } },
  },
  {
    name: 'rooms_find_equipment',
    module: 'rooms',
    access: 'read',
    mcpExposed: true,
    mcp: { scope: 'rooms.read', title: '장비 대여 확인', withheld: ['빌린 사람', '장비별 대여 일정', '장비 보관 위치'] },
    description:
      '그 시간에 이동식 장비를 빌릴 수 있는지(남은 수·전체 수)와 대여 확인 앱 링크를 돌려줘요. 누가 빌렸는지는 없어요. ' +
      '빌리기는 사람이 링크를 열어 앱 확인 시트에서 한 번 눌러요. 링크를 여는 것만으로는 빌리지 않아요. 빌릴 수 없으면 emptyReason에 까닭이 있어요.',
    input: {
      kind: { type: 'string', description: '정해진 장비 종류 중에서' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      start: { type: 'string', description: 'HH:MM' },
      minutes: { type: 'integer', description: '빌릴 시간(분). 비우면 운영 설정 기본 회의 길이', optional: true },
    },
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
