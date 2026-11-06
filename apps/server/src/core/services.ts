import type {
  Card,
  AwayKind,
  CardAction,
  InquiryState,
  InvitedMeetingsResponse,
  JointRequestsResponse,
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
  /** 홈 "같은 팀 일정"(11/3)이 쓰는 같은 팀 회의 읽기. rooms 모듈이 채워요. */
  team?: RoomsTeamRead;
}

/** 같은 팀 사람의 회의 한 칸. 누구(가명 ID)·시간·회의실 이름만이에요. 회의 제목·참석자·부른 사람은 없어요. */
export interface TeamMeeting {
  pseudonymId: string;
  start: number;
  end: number;
  roomName: string;
}

interface RoomsTeamRead {
  /**
   * 그 사람들이 앱에서 예약한 회의와 초대받아 "참석할게요"로 답한 회의 중 [from, to)와 겹치는 것.
   * 부르는 쪽(core/home-team.ts)이 묻는 사람과 같은 부서 사람의 가명 ID만 넘겨요. 모의 장부(남의 바깥 예약)는 넣지 않아요.
   */
  meetingsOf(pseudonymIds: string[], from: number, to: number): Promise<TeamMeeting[]>;
}

/** 홈이 모으는 회의실 쪽 내 일. 회의실 쓰기가 꺼져 있으면 enabled가 거짓이고 비어 있어요. */
interface RoomsHomeRead {
  /** 본인 장비 대여(지금 쓰는 것·다가오는 것) */
  myLoans(user: Pick<DeskUser, 'pseudonymId'>): Promise<MyLoansResponse>;
  /** 나를 부른 회의(다가오는 것). 부른 사람 이름은 초대받은 본인에게만 보여요(ADR-17). */
  invited(user: DeskUser): Promise<InvitedMeetingsResponse>;
  /** 내가 골라야 할 여러 팀 회의 참석자 요청(ADR-28, 팀장·회의 담당자만). 부른 사람 이름은 고르는 사람에게만 보여요. */
  jointRequests?(user: DeskUser): Promise<JointRequestsResponse>;
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
  /**
   * 규정 한 줄(11/6 휴가 A안 신청 전 카드): 서버가 정한 찾기 말(사람이 쓴 글 아님)로 허용 게시판 공지를 찾아,
   * 맞는 공지 본문 문장 하나를 고쳐 쓰지 않고 그대로 줘요("원문 한 줄"과 같은 방식, 낱말 규칙만, LLM 없음).
   * mustHave에 맞는 문장이 없으면 null이에요(지어내지 않아요).
   */
  ruleLine?(query: string, mustHave: RegExp): Promise<{ sentence: string; title: string; url: string } | null>;
  /**
   * 게시판 사본 갱신(11/6 새 공지 알림 대상, ADR-09 개정): 새 공지 한 건을 공지 사본에 넣고, 새로 들어왔으면 AI가 알림 대상을 제안해요.
   * 본문은 DB에 두지 않아요. audience: pending = 총무 확인 대기, sent = 자동 보내기로 보냄, null = 공지 기능이 꺼져 제안하지 않음.
   * 허용 밖 게시판·이미 있는 공지면 copied가 거짓이에요. 시연 가상 게시판(routes/demo-groupware-board.ts)이 불러요.
   */
  ingest?(notice: NoticeCopy): Promise<{ copied: boolean; audience: 'pending' | 'sent' | null }>;
}

/** 게시판 사본 한 건(제목·게시일·원문 링크·본문). 본문은 색인·제안에만 쓰고 DB에 두지 않아요. */
export interface NoticeCopy {
  id: string;
  board: string;
  title: string;
  /** YYYY-MM-DD */
  postedOn: string;
  url: string;
  body: string;
}

export interface NaviService {
  /** 분장표에 행을 가진 부서. 분장표 주인 역할 계산에 써요(R17). */
  ownerDepartments(): Promise<Set<string>>;
  /** MCP 읽기 도구용 읽기 함수(11/3, ADR-14 개정). navi 모듈의 mcp-read.ts가 채워요. */
  mcp?: NaviMcpRead;
  /** 홈 "나에게 해당하는 일"(ADR-27)이 쓰는 본인 읽기. navi 모듈의 home-read.ts가 채워요. */
  home?: NaviHomeRead;
  /** 홈 "같은 팀 일정"(11/3)이 쓰는 자리비움 읽기. navi 모듈의 away.ts가 채워요. */
  away?: NaviAwayRead;
}

/** 자리비움 한 칸. 누구(가명 ID)·종류 코드·시간만이에요. 자유 글은 없어요. */
export interface TeamAway {
  pseudonymId: string;
  kind: AwayKind;
  start: number;
  end: number;
}

export interface NaviAwayRead {
  /** 그 사람들이 스스로 알린 자리비움 중 [from, to)와 겹치는 것. 부르는 쪽이 같은 부서 사람의 가명 ID만 넘겨요. */
  ofPeople(pseudonymIds: string[], from: number, to: number): Promise<TeamAway[]>;
}

/** 홈에 보이는 내 문의·휴가 요청 한 줄. 글(질문·사유·답장·반려 사유)·답한 사람은 없어요. 휴가 날은 본인 것이라 본인 홈에만 가요(ADR-18). */
interface NaviHomeRequest {
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
  /**
   * "내 휴가 신청 어떻게 됐어?"(11/6 휴가 A안): 근태 기록에 들어간(승인된) 본인 휴가 중 [from, to] 날의 카드와,
   * 결재 중인 신청은 그룹웨어 결재함에서 보라는 안내([결재함 열기]). 앱은 그룹웨어 결재 문서를 읽지 않아요. 본인 것만이에요.
   */
  leaveStatus?(user: DeskUser, from: string, to: string): Promise<Card>;
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
  /** 링크를 열 때, 앱 안 휴가 결재가 꺼져 있으면(11/6 A안, 운영 기본): 그 날짜·종류의 신청 전 카드(본인 것만) */
  leaveCheck(user: DeskUser, link: LeaveLink): Promise<Card>;
}

/** 휴가 준비 링크 값. 날짜·하루/반차·종류만이에요. */
export interface LeaveLink {
  days: LeaveDay[];
  type: LeaveType;
}

interface PantryService {
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

interface McpService {
  /** 모든 기기 로그아웃·퇴사 확인 때 그 사람의 MCP 승인(갱신 토큰)을 모두 지워요(ADR-13·15). 지운 수를 돌려줘요. */
  revokeAll(pseudonymId: string): Promise<number>;
  /** 지금 MCP를 켤 수 있는지. 실제 데이터인데 보안팀이 승인한 앱이 없으면 거짓이에요(ADR-12·15). */
  canEnable(): Promise<boolean>;
}

/**
 * 사내 카페(11/6 3묶음, ADR-29)가 홈 채팅에 주는 기능. cafe 모듈이 채워요. 모두 읽기만 하고 아무것도 쓰지 않아요.
 * 홈은 카페 표를 직접 읽지 않고 이것만 불러요.
 */
export interface CafeService {
  /** 홈 낱말 규칙이 카페 주문 문장을 알아보는 낱말: 파는 메뉴 이름과 그 메뉴의 별칭(띄어쓰기 없앰). 값은 없어요. */
  menuWords(): Promise<string[]>;
  /**
   * 홈 채팅 주문 문장 → 카드. 받을 수 있으면 [확인하고 주문하기](제안 토큰, 누르면 확인 시트)가 붙은 제안 카드,
   * 아니면(영업 안 함·미납·한도·품절·칸 꽉 참·메뉴를 못 알아들음) 안내 카드예요. 주문은 쓰지 않아요(자동 실행 없음).
   * 글은 이 요청 메모리에서만 쓰고, 모델에는 질문 글과 메뉴 이름·옵션 이름만 가요(금액·청구·내 주문 없음).
   */
  orderCards(user: DeskUser, text: string): Promise<Card[]>;
  /** "이번 달 커피값 얼마야?": 본인 이번 달 지금까지·남은 한도·미납 청구서를 서버가 계산한 카드(본인만, 저장 안 함) */
  spendCard(user: DeskUser): Promise<Card>;
}

export interface Services {
  rooms?: RoomsService;
  notices?: NoticesService;
  navi?: NaviService;
  pantry?: PantryService;
  mcp?: McpService;
  cafe?: CafeService;
}
