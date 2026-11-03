import type { MyReservationsResponse, NoticeHit, RoomQuery, RoomSearchResult } from '@one-line-desk/shared';
import type { DeskUser } from './user';

// 모듈 사이에 필요한 기능은 이 인터페이스로만 주고받아요(ADR-01 모듈 경계).
// 제공하는 모듈이 자기 팩토리에서 ctx.services에 넣고, 쓰는 쪽(MCP 등)은 여기서 꺼내요.

export interface RoomsService {
  /** 빈 회의실 후보 최대 3개와 대안. 읽기만 하고 예약자·회의 제목은 없어요(ADR-06·14). */
  findFree(query: RoomQuery): Promise<RoomSearchResult>;
  /** 후보 하나로 앱 확인 링크용 제안 토큰을 만들어요(M3). */
  proposeReservation(user: Pick<DeskUser, 'pseudonymId'>, candidate: { roomId: string; start: string; end: string; query: RoomQuery }): string;
  /** 본인의 다가오는 예약(MCP 내 요청 상태, 11/3). 쓰는 쪽은 방·시간만 골라 내보내요. */
  myReservations?(user: Pick<DeskUser, 'pseudonymId'>): Promise<MyReservationsResponse>;
}

export interface NoticesService {
  /** 허용 게시판의 제목·게시일·원문 링크만(ADR-14). LLM을 부르지 않아요. */
  search(query: string, limit: number): Promise<{ mock: boolean; hits: NoticeHit[] }>;
  /** 찾아보는 허용 게시판 이름. 결과가 없을 때 어디를 찾았는지 알려 줘요. */
  boards(): string[];
}

export interface NaviService {
  /** 분장표에 행을 가진 부서. 분장표 주인 역할 계산에 써요(R17). */
  ownerDepartments(): Promise<Set<string>>;
  /** MCP 읽기 도구용 읽기 함수(11/3, ADR-14 개정). navi 모듈의 mcp-read.ts가 채워요. */
  mcp?: NaviMcpRead;
}

/** 담당 팀 한 줄. rowId는 앱 확인 링크(봉인 토큰)를 만들 때만 쓰고 MCP 출력에는 넣지 않아요. 대표 창구는 rowId가 null이에요. */
export interface NaviTeamRow {
  rowId: string | null;
  task: string;
  team: string;
  desk: string;
  nextStep: string;
  processingPeriod: string | null;
  revisedOn: string;
}

export interface NaviMcpRead {
  /** 질문 글로 분장표 후보(규칙 순위, 최대 3개). 글은 메모리에서만 쓰고 저장하지 않아요. 공통 검사에 걸리면 locked예요. */
  findTeam(text: string): Promise<{ mock: boolean; locked?: string; rows: (NaviTeamRow & { strong: boolean })[]; general: NaviTeamRow }>;
  /** IT 오류 글 → FAQ 원문 단계. 글은 가린 뒤 찾고 저장하지 않아요. */
  itFaq(text: string): Promise<{
    mock: boolean;
    locked?: string;
    faq?: { title: string; steps: string[]; revisedOn: string };
    others: string[];
    inquiry: Pick<NaviTeamRow, 'rowId' | 'team' | 'task'>;
  }>;
  /** 첫 2주 할 일(누구나 읽는 자료) */
  onboarding(): Promise<{ mock: boolean; weeks: { week: 1 | 2; items: NaviTeamRow[] }[] }>;
  /** 본인이 보낸 문의·휴가 요청(글·답한 사람·휴가 날짜 없음) */
  myRequests(
    pseudonymId: string,
  ): Promise<{ kind: 'inquiry' | 'leave' | 'official-leave'; task: string; team: string; state: string; sentOn: string; hasReply: boolean }[]>;
  /** 문의 양식 앱 링크용 봉인 제안 토큰. 받을 행만 담고 질문 글은 담지 않아요. */
  proposeInquiry(user: Pick<DeskUser, 'pseudonymId'>, rowId: string | null): string;
  /** 링크를 열 때: 그 행이 아직 있으면 받는 곳, 없으면 null */
  inquiryTarget(rowId: string | null): Promise<Pick<NaviTeamRow, 'rowId' | 'team' | 'task'> | null>;
}

export interface McpService {
  /** 모든 기기 로그아웃·퇴사 확인 때 그 사람의 MCP 승인(갱신 토큰)을 모두 지워요(ADR-13·15). 지운 수를 돌려줘요. */
  revokeAll(pseudonymId: string): Promise<number>;
  /** 지금 MCP를 켤 수 있는지. 실제 데이터인데 보안팀이 승인한 앱이 없으면 거짓이에요(ADR-12·15). */
  canEnable(): Promise<boolean>;
}

export interface Services {
  rooms?: RoomsService;
  notices?: NoticesService;
  navi?: NaviService;
  mcp?: McpService;
}
