import { MODULES, type ModuleKind, ROUTER_MODULES, type RouterModule } from './kinds';

// 끄기 스위치(ADR-12, R4). 운영자만 바꾸고, 바꿀 때마다 감사 로그에 남겨요.
export type ModuleSwitch = 'on' | 'link' | 'off';

/**
 * 운영 설정 링크 칸: 기능별 그룹웨어 화면 + 그룹웨어 팀 일정(11/4) + 그룹웨어 휴가 신청·결재함(11/6 A안).
 * leave: 휴가 신청 주소. {from}·{to}·{type}·{half} 자리 표시가 있으면 날짜·종류 코드로 채워요(글은 넣지 않아요).
 * approvals: 결재함 주소. 결재 진행 상황은 앱이 모르니 이 주소로 보내요.
 */
export const OPS_LINK_KEYS = [...MODULES, 'teamSchedule', 'leave', 'approvals'] as const;
/** 빈 글로 지울 수 있는 링크 칸(비우면 버튼 없이 글 안내만 해요) */
export const OPS_CLEARABLE_LINKS = ['teamSchedule', 'leave', 'approvals'] as const;
export type OpsLinkKey = (typeof OPS_LINK_KEYS)[number];
export interface OpsSettings {
  modules: Record<ModuleKind, ModuleSwitch>;
  /** 끄면 회의실 카드 주 버튼과 MCP 링크가 그룹웨어 링크로 바뀌어요. */
  roomsWrite: boolean;
  /** MCP 전체 스위치(M5). 해당 모듈이 켬일 때만 그 도구가 나와요. */
  mcp: boolean;
  /** 운영자가 따로 끈 MCP 도구 이름(11/2). 비어 있으면 모듈·MCP 스위치만 봐요. */
  mcpToolsOff: string[];
  /** 채팅 자동 실행(ADR-19). 끄면 채팅도 카드와 확인 시트로만 예약·대여해요. */
  autoActions: boolean;
  /** 홈 AI 채팅 "나에게 해당하는 일"(ADR-27). 끄면 홈 칸과 홈 경로가 닫혀요. 읽기만 해서 출시 기본값도 켬이에요. */
  homeAsk: boolean;
  /**
   * 홈 채팅 "같은 팀 일정"(11/3). 같은 부서 사람의 휴가(하루/오전/오후, 종류·사유 없음)·회의(시간·회의실)·자리비움을 보여요.
   * 다른 사람의 인사 자료·일정이라 회사 규정·보안팀 확인 뒤 켜요: 개발·시연은 켬, 출시 기본값은 끔이에요.
   * 끄면 마이 페이지의 "자리비움 알리기"도 닫혀요(보는 곳이 팀 일정뿐이라서요).
   */
  teamSchedule: boolean;
  /** 이번 2주는 고정이에요(M6). */
  noticeSummary: false;
  s5Mode: 'list-only';
  /**
   * "링크만"일 때 보내는 그룹웨어 화면 주소. 회사 그룹웨어가 정해지면 바꿔요(사용자 확인 1).
   * teamSchedule(11/4 사용자 결정): 그룹웨어 팀 일정 주소. 홈 채팅이 팀 일정을 보여 주지 못할 때(다른 팀·꺼짐·연결 안 됨)
   * [그룹웨어 팀 일정 열기] 버튼으로 붙어요. 빈 글이면 버튼 없이 글 안내만 해요.
   */
  links: Record<OpsLinkKey, string>;
  /**
   * 사내 카페 회사 계좌 안내 글(11/6 2묶음, ADR-29). 직원 청구서에 그대로 보여요. 80자 안, 줄바꿈 없음, 운영자가 바꿔요.
   * 비어 있으면 "계좌는 총무에게 물어봐 주세요"를 보여요. 앱은 돈을 받거나 보내지 않아서 계좌 글은 안내일 뿐이에요.
   */
  cafeAccount: string;
  /**
   * 회사 휴일·임시공휴일 날짜(YYYY-MM-DD, 11/6 휴가 정확도). 창립기념일처럼 법정 공휴일 표(holidays.ts)에 없는 쉬는 날을 운영자가 넣어요.
   * 휴가 날 세기·걸린 일이 없는 날 제안·MCP 휴가 준비·가상 그룹웨어 신청서에서 공휴일처럼 빼요. 날짜만이고 이름·사유는 받지 않아요.
   */
  companyHolidays: string[];
  /**
   * 회사 기본 근무 요일(0 일요일 … 6 토요일, 11/6 사용자 결정, 기본 월~금). 휴가 날 세기·걸린 일이 없는 날 제안·MCP 휴가 준비·
   * 가상 그룹웨어 신청서·앱 안 휴가 요청이 이 요일이 아닌 날을 쉬는 요일로 빼요. 교대·주말 근무자처럼 사람마다 다르면
   * 근태 어댑터가 준 사람별 근무 요일(LeaveRecord.workWeekdays)이 먼저예요. 감사에는 개수만 남아요.
   */
  workWeekdays: number[];
  values: {
    /** 아래 값은 아직 정하지 않은 임시값이에요. 운영 설정에서 바꿔요. */
    defaultMeetingMinutes: number;
    proposalTtlSeconds: number;
    planTtlSeconds: number;
    employmentRecheckSeconds: number;
    /**
     * 이만큼 쓰지 않으면 로그인이 끊겨요(안전성 확보조치 기준 제6조④, ADR-20). 기본 3시간: 점심을 넣은 정규 업무시간(9시간)에
     * 다시 인증이 많아야 3번이에요(10/28 사용자 결정). 시간은 내부 관리계획에 적어요(안내서 74쪽, CD-31).
     */
    idleTimeoutMinutes: number;
    rateLimitPerMinute: number;
    /** 연간 병가 한도(일, 11/3). 0이면 한도 없음이라 "올해 병가 M일 썼어요"만 보여요. 표시만 하고 막지 않아요. */
    sickLeaveYearDays: number;
    /** 병가 요청이 이 일수를 넘으면 "진단서는 인사팀에 따로 내 주세요"를 보여요(11/3, 기본 3일). */
    sickNoteOverDays: number;
    /** 여러 팀 회의 참석자 고르기 마감: 회의 시작 이만큼(분) 전까지(11/4, ADR-28, 기본 60분). 지나면 짐작한 인원 그대로예요. */
    jointPickLeadMinutes: number;
    /** 사내 카페 10분 픽업 칸마다 받는 잔 수 상한(11/6, ADR-29 피크, 기본 10잔). 꽉 찬 칸은 고를 수 없어요. */
    cafeSlotCapacity: number;
    /** 사내 카페 한 사람의 한 달 주문 합계 한도(원, 11/6 2묶음, 기본 50만 원). 총무가 [늘려 주기]로 그 달만 늘려요. */
    cafeMonthlyLimitWon: number;
    /** 사내 카페 납부 기한(청구일부터 며칠, 기본 7일). 다음 날부터 미납자의 새 주문을 막아요(ADR-29). */
    cafeDueDays: number;
    /**
     * 카운터 기기의 카페 판 전용 세션 길이(시간, 11/6 3묶음, ADR-20 예외·ADR-29). 쉬는 시간으로 끊지 않고 로그인부터 이만큼 뒤 끊어요(1~13, 기본 13).
     * 서버는 요청마다 지금 값으로 봐서, 줄이면 이미 열린 판 세션도 더 일찍 끊겨요.
     */
    cafeBoardSessionHours: number;
    /** 하루 근로시간(11/6 휴가 정확도, 기본 8). "연차 2시간"을 0.25일로 바꿀 때 써요. 회사 규정의 소정근로시간에 맞춰요. */
    workdayHours: number;
    /**
     * 병가를 연차에서 빼는 회사인지(11/6, 0 안 뺌 · 1 뺌, 기본 0). 병가의 연차 차감은 회사 규정(취업규칙)에 달려요.
     * 1이면 남은 연차 계산과 신청 전 카드가 병가를 연차처럼 빼요. 공가는 법 근거라 늘 빼지 않아요.
     */
    sickLeaveFromAnnual: number;
    /** 경조를 연차에서 빼는 회사인지(11/6, 0 안 뺌 · 1 뺌, 기본 0). 병가와 같아요. */
    eventLeaveFromAnnual: number;
    /**
     * 5인 미만 사업장인지(11/6 사용자 결정, 0 아님 · 1 맞음, 기본 0). 5인 미만은 법정 연차(근로기준법 제60조)가 적용되지 않아서,
     * 1이면 앱이 근로기준법 규칙으로 연차를 세지 않아요. 근태 시스템 숫자(LeaveRecord.balance)가 있으면 그 숫자만 보여 주고, 없으면 숫자 없이 까닭을 적어요.
     */
    smallWorkplace: number;
    /**
     * 법정 공휴일을 쉬는 날로 보는지(11/6 사용자 결정, 0 일하는 날 · 1 쉬는 날, 기본 1). 0이면 공휴일도 일하는 날로 세고 제안해요
     * (공휴일이 유급휴일이 아닌 5인 미만 사업장 등). 회사 휴일(companyHolidays)은 값과 상관없이 늘 쉬는 날이에요. smallWorkplace와 따로예요.
     */
    publicHolidaysOff: number;
  };
}

export const DEFAULT_OPS_SETTINGS: OpsSettings = {
  // 사내 카페(11/6, ADR-29)는 출시 기본 끔이에요. 개발·시연도 운영자가 켜야 보여요(시연 배포는 DESK_DEMO_SWITCHES=cafeteria).
  modules: { navi: 'on', notices: 'on', rooms: 'on', pantry: 'on', cafeteria: 'off' },
  roomsWrite: true,
  mcp: false,
  mcpToolsOff: [],
  autoActions: true,
  homeAsk: true,
  teamSchedule: true,
  noticeSummary: false,
  s5Mode: 'list-only',
  links: {
    navi: 'https://groupware.example.com/helpdesk',
    notices: 'https://groupware.example.com/board',
    rooms: 'https://groupware.example.com/resources',
    pantry: 'https://groupware.example.com/supplies',
    cafeteria: 'https://groupware.example.com/cafe',
    teamSchedule: 'https://groupware.example.com/calendar/team',
    // 휴가 신청·결재함(11/6 A안)은 회사마다 주소가 달라서 비워 둬요. 비어 있으면 시연은 가상 그룹웨어 주소를 쓰고(navi/leave-handoff.ts),
    // 운영은 [그룹웨어에서 신청하기] 대신 "그룹웨어에서 신청해 주세요" 글만 보여요.
    leave: '',
    approvals: '',
  },
  cafeAccount: '',
  companyHolidays: [],
  workWeekdays: [1, 2, 3, 4, 5],
  values: {
    defaultMeetingMinutes: 60,
    proposalTtlSeconds: 600,
    planTtlSeconds: 600,
    // 퇴사 시 늦어도 10분 안에 끊겨야 해서 10분보다 짧게 둬요(ADR-13).
    employmentRecheckSeconds: 300,
    idleTimeoutMinutes: 180,
    rateLimitPerMinute: 20,
    // 회사 병가 규정이 정해지기 전에는 한도 없음(0)이에요.
    sickLeaveYearDays: 0,
    sickNoteOverDays: 3,
    jointPickLeadMinutes: 60,
    cafeSlotCapacity: 10,
    cafeMonthlyLimitWon: 500_000,
    cafeDueDays: 7,
    cafeBoardSessionHours: 13,
    workdayHours: 8,
    sickLeaveFromAnnual: 0,
    eventLeaveFromAnnual: 0,
    smallWorkplace: 0,
    publicHolidaysOff: 1,
  },
};

/**
 * 출시(운영) 기본값(CD-14): 회의실 쓰기·MCP·채팅 자동 실행·같은 팀 일정은 끈 채로 시작해요. 운영자가 바꾸면 운영 설정 표에 남아요.
 * 같은 팀 일정(11/3)은 회사 규정·보안팀 확인 뒤 켜요.
 */
export const LAUNCH_OPS_SETTINGS: OpsSettings = {
  ...DEFAULT_OPS_SETTINGS,
  roomsWrite: false,
  mcp: false,
  autoActions: false,
  teamSchedule: false,
  // 팀 일정·휴가 신청·결재함 주소는 회사마다 달라서 비워 두고 운영자가 넣어요.
  links: { ...DEFAULT_OPS_SETTINGS.links, teamSchedule: '', leave: '', approvals: '' },
};

/** "같이 채워요 단독" 모드 = navi·notices·rooms 모두 끔. 묻기 탭을 숨기고 같이 채워요 탭이 첫 화면이에요. */
export function isPantryStandalone(settings: OpsSettings): boolean {
  return (['navi', 'notices', 'rooms'] as const).every((m) => settings.modules[m] === 'off');
}

/** 회의실 쓰기(예약·취소·참석자 초대)가 켜져 있는지. 회의실이 `켬`이고 회의실 쓰기가 켜졌을 때만이에요. */
export function roomsWriteOn(settings: OpsSettings): boolean {
  return settings.modules.rooms === 'on' && settings.roomsWrite;
}

/** 라우터 후보에 남는 종류. 끔인 종류는 빠지고, 링크만은 남아서 링크 카드를 받아요. 카페는 아직 라우터 종류가 아니에요(ADR-29). */
export function routableModules(settings: OpsSettings): RouterModule[] {
  return ROUTER_MODULES.filter((m) => settings.modules[m] !== 'off');
}

/** 자리비움 알리기(11/3)가 열려 있는지. 보는 곳이 같은 팀 일정뿐이라 같은 팀 일정과 담당 찾기가 모두 켬일 때만이에요. */
export function awayOn(settings: OpsSettings): boolean {
  return settings.modules.navi === 'on' && settings.teamSchedule;
}
