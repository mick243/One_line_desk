import type {
  Card,
  CardAction,
  InquiryState,
  InvitedMeetingsResponse,
  LeaveDay,
  LeaveType,
  LoanKind,
  MyLoansResponse,
  MyRequestsResponse,
  MyReservationsResponse,
  NoticeHit,
  RoomQuery,
  RoomSearchResult,
} from '@one-line-desk/shared';
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
  /** MCP 장비 대여 확인(11/3 확인 링크 넓히기). rooms 모듈의 equipment.ts가 채워요. */
  equipment?: RoomsEquipmentRead;
  /** 홈 "나에게 해당하는 일"(ADR-27)이 쓰는 본인 읽기. rooms 모듈이 채워요. */
  home?: RoomsHomeRead;
}

/** 홈이 모으는 회의실 쪽 내 일. 회의실 쓰기가 꺼져 있으면 enabled가 거짓이고 비어 있어요. */
export interface RoomsHomeRead {
  /** 본인 장비 대여(지금 쓰는 것·다가오는 것) */
  myLoans(user: Pick<DeskUser, 'pseudonymId'>): Promise<MyLoansResponse>;
  /** 나를 부른 회의(다가오는 것). 부른 사람 이름은 초대받은 본인에게만 보여요(ADR-17). */
  invited(user: DeskUser): Promise<InvitedMeetingsResponse>;
}

/** 장비 대여 링크 값. 장비 종류와 하루 안의 한 구간(KST ISO)만이에요. */
export interface RentLink {
  kind: LoanKind;
  start: string;
  end: string;
}

export interface RoomsEquipmentRead {
  /** 그 구간에 그 종류의 남은 수·전체 수. 누가 빌렸는지는 없어요. */
  stock(kind: LoanKind, from: number, to: number): Promise<{ free: number; total: number }>;
  /** 장비 대여 앱 링크용 봉인 제안 토큰. 열어 보기만 되고 plan 만들기·바로 실행은 막혀요. */
  proposeRentLink(user: Pick<DeskUser, 'pseudonymId'>, link: RentLink): string;
  /** 링크를 열 때: 지금 다시 확인한 남은 수 카드. 빌릴 수 있으면 [빌리기](확인 시트)가 붙어요. */
  linkCards(user: Pick<DeskUser, 'pseudonymId'>, link: RentLink): Promise<Card[]>;
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
  /** 홈 "나에게 해당하는 일"(ADR-27)이 쓰는 본인 읽기. navi 모듈의 home-read.ts가 채워요. */
  home?: NaviHomeRead;
}

/** 홈에 보이는 내 문의·휴가 요청 한 줄. 글(질문·사유·답장·반려 사유)·답한 사람은 없어요. 휴가 날은 본인 것이라 본인 홈에만 가요(ADR-18). */
export interface NaviHomeRequest {
  kind: 'inquiry' | 'leave';
  /** 휴가 요청 종류. 일반 문의는 null이에요. */
  leaveType: LeaveType | null;
  task: string;
  team: string;
  state: InquiryState;
  sentAt: number;
  /** 상태가 바뀌거나 답장이 온 마지막 때 */
  updatedAt: number;
  hasReply: boolean;
  /** 휴가 요청의 쓸 날(본인 것). 일반 문의는 빈 배열이에요. */
  days: LeaveDay[];
}

export interface NaviHomeRead {
  /** 본인이 보낸 문의·휴가 요청(보관 기간 7일 안) */
  myRequests(pseudonymId: string): Promise<NaviHomeRequest[]>;
  /** 내 부서가 받은 새 문의 수만. 받는 부서가 아니면 null이에요. 보낸 사람·글은 없어요. */
  newInboxCount(user: Pick<DeskUser, 'department'>): Promise<number | null>;
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
  /**
   * 휴가 준비 링크(11/3 확인 링크 넓히기): 날짜 형식·주말·기간만 검사해 맞으면 봉인 제안 토큰을 줘요.
   * 연차 자료(등급 2)는 읽지 않아요. 토큰에는 날짜·하루/반차·종류만 들어가고 사유는 없어요.
   */
  prepareLeave(
    user: Pick<DeskUser, 'pseudonymId'>,
    link: LeaveLink,
  ): { ok: true; token: string; days: LeaveDay[] } | { ok: false; code: string; message: string };
  /** 링크를 열 때(앱, 본인 로그인): 그 날짜·종류로 채운 휴가 신청 양식 행동. 앱에서 휴가를 신청할 수 없으면 null이에요. */
  leaveTarget(user: DeskUser, link: LeaveLink): Promise<Extract<CardAction, { type: 'leave-request' }> | null>;
}

/** 휴가 준비 링크 값. 날짜·하루/반차·종류만이에요. */
export interface LeaveLink {
  days: LeaveDay[];
  type: LeaveType;
}

export interface PantryService {
  /** MCP 탕비실 요청 찾기(11/3 확인 링크 넓히기). pantry 모듈이 채워요. */
  mcp?: PantryMcpRead;
  /** 홈 "나에게 해당하는 일"(ADR-27): 내가 올리거나 +1한 품목 상태(투표자 없음). 같이 채워요가 켬일 때만 불러요. */
  home?: { myRequests(user: DeskUser): Promise<MyRequestsResponse> };
}

export interface PantryMcpRead {
  /** 그 층 열린 품목 중 같은 상품 같아 보이는 것(이름 규칙, LLM 없음). 이름은 메모리에서만 쓰고 저장하지 않아요. 공통 검사에 걸리면 locked예요. */
  findSimilar(floor: string, itemName: string): Promise<{ locked?: string; items: { cardId: number; name: string; votes: number }[] }>;
  /** 판 앱 링크용 봉인 제안 토큰. 카드 ID만 담아요(null이면 새 요청 쓰기). 열어 보기만 돼요. */
  proposeBoardLink(user: Pick<DeskUser, 'pseudonymId'>, cardId: number | null): string;
  /** 링크를 열 때: 내 층 열린 묶음이면 지금 다시 읽은 품목 카드([여기에 +1] 고정 버튼), 아니면 null이에요. */
  linkCards(user: DeskUser, cardId: number): Promise<Card[] | null>;
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
  pantry?: PantryService;
  mcp?: McpService;
}
