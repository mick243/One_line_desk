import type { Card, CardAction } from '../cards';
import { RECORD_KEEP_DAYS } from '../retention';

// 받는 곳을 바꿔 보낸 기록의 이유(11/2 ADR-26, 옛 "틀렸어요" 자리). 수정 제안함 기록 묶음은 이 둘만 세요.
// DB check 제약(110_navi.sql)에는 옛 값 둘(content-changed·wrong-kind)이 남아 있지만 이제 쓰지 않아요(11/3).
export const REROUTE_REASONS = ['other-owner', 'not-listed'] as const;
export type RerouteReason = (typeof REROUTE_REASONS)[number];

export const REROUTE_REASON_LABEL: Record<RerouteReason, string> = {
  'other-owner': '다른 팀으로 바꿔 보냄',
  'not-listed': '대표 창구로 바꿔 보냄',
};

/** 분장표 행 ID 모양(예: FIN-01). 파일 가져오기·문의·행 카드가 같이 써요. */
export const NAVI_ROW_ID_PATTERN = '^[A-Z]{2,5}-[0-9]{2,3}$';

/**
 * 분장표 창구 링크 버튼 이름(11/3). mailto:면 메일 앱이 열려서 [메일 보내기], 아니면(https) [창구 열기]예요.
 * 담당 카드(서버)·첫 2주 할 일(화면)이 같이 써요.
 */
export function deskLinkText(url: string): '메일 보내기' | '창구 열기' {
  return /^mailto:/i.test(url.trim()) ? '메일 보내기' : '창구 열기';
}

/** POST /api/navi/rows/card 본문. 행 ID가 URL·접근 기록에 남지 않게 POST 본문으로 보내요(R11). */
export interface NaviRowCardRequest {
  rowId: string;
}

// 분장표 파일 칸(ADR-09). "담당자 이름"처럼 여기에 없는 칸은 가져올 때 버려요(D9).
export const CHART_COLUMNS = {
  id: '행 ID',
  task: '업무',
  aliases: '다른 말',
  team: '담당 팀',
  desk: '창구',
  deskUrl: '창구 링크',
  nextStep: '지금 할 일',
  processingPeriod: '처리 기간',
  revisedOn: '개정일',
  ownerDepartment: '주인 부서',
  // 신규 입사자 첫 2주 할 일(1·2, 비우면 아님). 없어도 되는 칸이에요(10/31 넓힐 후보 ①).
  onboardingWeek: '온보딩 주차',
} as const;
export type ChartColumn = keyof typeof CHART_COLUMNS;
/** "다른 말" 칸 안에서 여러 값을 나누는 글자 */
export const CHART_ALIAS_SEPARATOR = '|';

/** S5 행 하나. 기록 묶음은 개정일 뒤에 쌓인 건수예요. 누가 골랐는지·질문 원문은 없어요. */
export interface ChartRowSummary {
  id: string;
  task: string;
  team: string;
  desk: string;
  deskUrl?: string;
  nextStep: string;
  processingPeriod?: string;
  aliases: string[];
  /** YYYY-MM-DD */
  revisedOn: string;
  feedback: Record<RerouteReason, number>;
  total: number;
}

export interface ChartListResponse {
  department: string;
  rows: ChartRowSummary[];
}

/** S5 분장표 파일 다시 올리기. 파일 글자는 POST 본문으로만 보내요. */
export interface ChartUploadRequest {
  csv: string;
}

export interface ChartApplyRequest extends ChartUploadRequest {
  /** 미리보기 때 우리 부서 행 상태. 그사이 바뀌었으면 반영하지 않아요. */
  baseVersion: string;
}

export interface ChartChange {
  rowId: string;
  task: string;
  type: 'changed' | 'added';
  fields: { name: string; before?: string; after: string }[];
}

export interface ChartPreviewResponse {
  department: string;
  baseVersion: string;
  changes: ChartChange[];
  /** 파일에 있었지만 바뀌지 않은 우리 부서 행 수 */
  unchanged: number;
  /** 파일에 없어서 그대로 두는 우리 부서 행 수(지우지 않아요) */
  untouched: number;
}

export interface ChartApplyResponse {
  applied: number;
  /** YYYY-MM-DD */
  revisedOn: string;
  message: string;
}

// ── 담당 팀에 문의 보내기(10/26, ADR-16) ─────────────────────────
// 받는 곳은 분장표 행의 주인 부서예요(담당자 이름은 없어요, D9). 확인 시트에서 [보내기]를 누른 글만 저장하고 7일 뒤 지워요(10/28, 처음엔 90일).

export const INQUIRY_QUESTION_MAX = 1000;
export const INQUIRY_REASON_MAX = 500;
export const INQUIRY_KEEP_DAYS = RECORD_KEEP_DAYS;
/** 승인·반려는 휴가 요청에만 있어요(10/30, ADR-24). */
const INQUIRY_STATES = ['new', 'seen', 'done', 'approved', 'rejected'] as const;
export type InquiryState = (typeof INQUIRY_STATES)[number];
export const INQUIRY_STATE_LABEL: Record<InquiryState, string> = {
  new: '새 문의',
  seen: '확인했어요',
  done: '처리했어요',
  approved: '승인했어요',
  rejected: '반려했어요',
};
export const INQUIRY_REPLY_MAX = 1000;
export const LEAVE_REJECT_REASON_MAX = 500;
/** 한 번에 신청할 수 있는 날 수 */
export const LEAVE_REQUEST_MAX_DAYS = 30;

/** 휴가 요청 종류(11/1 공가, 11/3 병가). 공가·병가는 연차에서 빠지지 않아요(docs/병가준비_2026-11-01.md). */
export const LEAVE_TYPES = ['annual', 'official', 'sick'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const LEAVE_TYPE_LABEL: Record<LeaveType, string> = { annual: '연차', official: '공가', sick: '병가' };

/**
 * 그룹웨어로 넘기는 휴가 종류(11/6 A안): 위 셋에 경조(family-event)를 더해요. 경조는 연차에서 빠지지 않아요(공가처럼).
 * 신청 전 카드·가상 그룹웨어·근태 기록이 써요. 앱 안 휴가 요청(DB 제약)과 MCP 휴가 준비는 LEAVE_TYPES 그대로예요.
 */
export const LEAVE_KINDS = [...LEAVE_TYPES, 'family-event'] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];
export const LEAVE_KIND_LABEL: Record<LeaveKind, string> = { ...LEAVE_TYPE_LABEL, 'family-event': '경조' };
/**
 * 날을 미리 고를 수 있는 휴가인지(11/6 사용자 결정). 연차·반차만이에요. 병가·공가·경조는 날을 고를 수 없어서
 * 신청 전 카드가 다른 날을 제안하지 않고, 그날 잡혀 있던 내 일만 알려요.
 */
export const leaveDayPickable = (kind: LeaveKind): boolean => kind === 'annual';

/** 공가 사유는 정해진 것만 골라요. 자유 글 사유 칸은 따로 있어요. */
export const OFFICIAL_LEAVE_REASONS = ['reserve', 'vote', 'summons', 'duty'] as const;
export type OfficialLeaveReason = (typeof OFFICIAL_LEAVE_REASONS)[number];
export const OFFICIAL_LEAVE_REASON_LABEL: Record<OfficialLeaveReason, string> = {
  reserve: '예비군·민방위 훈련',
  vote: '선거 투표',
  summons: '법원·관공서 출석',
  duty: '그 밖의 공적 의무',
};

/**
 * 병가 사유(11/3, 사용자 결정 1: 정해진 선택지만, 자유 글 없음). 건강 정보를 드러내지 않는 일반 표현이고 코드로 저장해요.
 * 병명·증상은 받지 않아요. 진단서는 앱이 받지 않고 인사팀에 따로 내요(진료확인서 올려 받기는 보류).
 */
const SICK_LEAVE_REASON_CODES = ['unwell', 'clinic', 'family'] as const;
/** 저장된 병가 사유 코드. 'family'는 11/4에 뺀 사유라 그 전에 보낸 요청(7일 보관)을 보여 줄 때만 와요. */
export type SickLeaveReason = (typeof SICK_LEAVE_REASON_CODES)[number];
/** 고를 수 있는 병가 사유(11/4 사용자 결정: "가족 돌봄"은 병가보다 가족돌봄휴가에 가까워 뺐어요). */
export const SICK_LEAVE_REASONS: readonly SickLeaveReason[] = ['unwell', 'clinic'];
export const SICK_LEAVE_REASON_LABEL: Record<SickLeaveReason, string> = {
  unwell: '몸이 안 좋아요',
  clinic: '병원 진료',
  family: '가족 돌봄',
};
/** 병가는 오늘부터 이만큼 지난 날까지 신청할 수 있어요(11/3 사용자 결정 2: 지난 3일까지). 연차·공가는 지난 날을 받지 않아요. */
export const SICK_LEAVE_PAST_DAYS = 3;
/** 진단서 안내 문구(11/3 사용자 결정 5). 운영 값 sickNoteOverDays를 넘는 병가 요청에 보여요. */
export const SICK_NOTE_TEXT = '진단서는 인사팀에 따로 내 주세요';

/**
 * 올해 병가 쓴 날(서버가 근태 기록으로 계산, 저장 안 함, ADR-18). limit은 운영 값 sickLeaveYearDays이고 0이면 한도 없음(null)이에요.
 * 본인 카드·양식과, 받은 팀이 그 요청을 처리할 때만 와요.
 */
export interface SickLeaveUsage {
  /** 달력 연도(1월 1일 ~ 12월 31일) */
  year: number;
  /** 올해 근태 기록의 병가 일수(예정 포함, 반차 0.5) */
  used: number;
  limit: number | null;
}

/** "올해 병가 N일 중 M일 썼어요" / 한도가 없으면 "올해 병가 M일 썼어요" */
export function sickUsageText(u: Pick<SickLeaveUsage, 'used' | 'limit'>): string {
  const d = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}일`;
  return u.limit ? `올해 병가 ${d(u.limit)} 중 ${d(u.used)} 썼어요` : `올해 병가 ${d(u.used)} 썼어요`;
}

/** 반차의 오전·오후(11/3 사용자 결정). */
export type HalfPart = 'am' | 'pm';

/**
 * 휴가 하루. 반차는 0.5일이에요.
 * 11/3: 반차는 오전·오후 중 하나(half)가 꼭 있어야 해요. 근태 기록(LeaveUse)과 같은 모양이라 승인하면 그대로 넘어가요.
 * half가 없는 반차는 그 전에 보낸 요청(7일 보관)에만 남아 있고 "반차(구분 없음)"로 보여요. 새로 보내는 요청은 받지 않아요.
 */
export interface LeaveDay {
  /** YYYY-MM-DD(한국 날짜) */
  date: string;
  kind: 'full' | 'half';
  /** 반차의 오전·오후. 하루(full)에는 없어요. */
  half?: HalfPart;
}

/** 휴가 신청 양식에서 날마다 고르는 값: 하루 · 오전 반차 · 오후 반차 */
export type LeaveDayChoice = 'full' | HalfPart;
export const LEAVE_DAY_CHOICES: readonly LeaveDayChoice[] = ['full', 'am', 'pm'];
export const LEAVE_DAY_CHOICE_LABEL: Record<LeaveDayChoice, string> = { full: '하루', am: '오전 반차', pm: '오후 반차' };
/** 오전·오후 구분 없이 남아 있는 옛 반차(11/3 전 요청) */
const LEAVE_HALF_UNKNOWN_LABEL = '반차(구분 없음)';

/** 고른 값 → 휴가 하루 */
export const leaveDayOf = (date: string, choice: LeaveDayChoice): LeaveDay =>
  choice === 'full' ? { date, kind: 'full' } : { date, kind: 'half', half: choice };

/** 휴가 하루 → 고른 값. 구분 없는 옛 반차는 null이에요(양식에서 다시 골라요). */
export const leaveDayChoice = (d: Pick<LeaveDay, 'kind' | 'half'>): LeaveDayChoice | null =>
  d.kind === 'full' ? 'full' : d.half === 'am' || d.half === 'pm' ? d.half : null;

/** "하루" · "오전 반차" · "오후 반차" · "반차(구분 없음)" */
export function leaveDayWord(d: Pick<LeaveDay, 'kind' | 'half'>): string {
  const choice = leaveDayChoice(d);
  return choice ? LEAVE_DAY_CHOICE_LABEL[choice] : LEAVE_HALF_UNKNOWN_LABEL;
}

/** 그 날 차지하는 반나절. 하루와 구분 없는 반차는 어느 쪽인지 몰라서 둘 다로 봐요(겹침 검사). */
export function leaveDayHalves(d: Pick<LeaveDay, 'kind' | 'half'>): HalfPart[] {
  const choice = leaveDayChoice(d);
  return choice === 'am' || choice === 'pm' ? [choice] : ['am', 'pm'];
}

/** 같은 날 오전 반차와 오후 반차를 같이 고르면 하루로 합쳐요(일수는 그대로 1일). 그 밖의 같은 날 두 번은 그대로 둬서 검사가 막아요. */
export function mergeLeaveHalves<T extends LeaveDay>(days: readonly T[]): LeaveDay[] {
  const out: LeaveDay[] = [];
  for (const d of days) {
    const pair = d.kind === 'half' && d.half ? out.findIndex((o) => o.date === d.date && o.kind === 'half' && o.half && o.half !== d.half) : -1;
    if (pair >= 0) out[pair] = { date: d.date, kind: 'full' };
    else out.push(d.kind === 'full' ? { date: d.date, kind: 'full' } : { date: d.date, kind: 'half', ...(d.half ? { half: d.half } : {}) });
  }
  return out;
}

/** POST /api/navi/inquiries. requestId는 같은 문의를 두 번 보내지 않게 하는 값이에요(화면이 만들어요). */
export interface InquiryRequest {
  rowId: string | null;
  /**
   * 문의하기가 처음 골랐던 행(11/2, ADR-26). 사람이 받는 곳을 바꿔 보내면 서버가 그 행에 "바꿔 보냄" 기록을 남겨요
   * (이유·고른 행·날짜만, 글·보낸 사람 없음). 분장표 주인이 수정 제안함에서 봐요. 고른 곳 그대로면 아무것도 남지 않아요.
   */
  suggestedRowId?: string | null;
  question: string;
  /** 사유(자유 글). 병가 요청에는 보내지 않아요(오면 400, 병가 사유는 sickReason 코드만). 그 밖에는 꼭 있어야 해요. */
  reason?: string;
  requestId: string;
  /**
   * 휴가 요청이면 쓸 날(ADR-24). 받는 팀(인사팀)이 승인하면 근태 기록에 들어가요.
   * type이 없으면 연차예요. 공가(official)는 officialReason이, 병가(sick)는 sickReason이 꼭 있어야 하고 연차에서 빠지지 않아요.
   */
  leave?: { days: LeaveDay[]; type?: LeaveType; officialReason?: OfficialLeaveReason; sickReason?: SickLeaveReason };
}

/** POST /api/navi/inquiries/:id/reply. 받은 팀이 보내는 답장이에요. 7일 보관해요. */
export interface InquiryReplyRequest {
  text: string;
  requestId: string;
}

/** POST /api/navi/inquiries/:id/decision. 휴가 요청만. 반려는 사유가 꼭 있어야 해요. */
export interface InquiryDecisionRequest {
  decision: 'approved' | 'rejected';
  reason?: string;
}

/** 휴가 요청 계산(서버 규칙, ADR-18). 받은 팀 화면에서 그 요청을 보낸 사람 것만 보여요. 저장하지 않고 열 때마다 계산해요. */
export interface LeaveRequestBalance {
  /** 이번 연차 기간 남은 연차(이미 승인돼 근태 기록에 들어간 날 포함해 뺀 값) */
  remaining: number;
  /** 이 요청을 승인하면 이번 기간에 남는 연차. 모자라면 음수예요. */
  after: number;
  /** 이번 연차 기간 마지막 날 */
  periodEnd: string;
  /** 이 요청 중 이번 기간에 드는 일수 */
  days: number;
  /**
   * 요청한 날이 다음 연차 기간(입사일 기준)에 들면 그 기간 계산이에요. 이번 기간에서는 빠지지 않아요.
   * (10/30: "남은 7.5일 → 7.5일"처럼 이유 없이 그대로 보이던 문제)
   */
  next?: LeaveNextPeriod;
}

/** 다음 연차 기간에서 빠지는 몫 */
interface LeaveNextPeriod {
  /** 다음 연차 기간 첫날 */
  periodStart: string;
  /** 다음 기간에 생기는 연차에서 이미 잡힌 날을 뺀 값 */
  remaining: number;
  after: number;
  days: number;
}

interface InquiryReply {
  /** 지금은 받은 팀만 답장해요 */
  from: 'team';
  /** 답장한 팀 사람 이름(보낸 사람 화면에서 누가 답했는지 보여요) */
  name: string;
  text: string;
  /** ISO 시각(+09:00) */
  at: string;
}

export interface InquiryItem {
  id: string;
  task: string;
  team: string;
  question: string;
  reason: string;
  state: InquiryState;
  /** ISO 시각(+09:00) */
  createdAt: string;
  updatedAt: string;
  /** 받은 문의함에서만 와요. 답하려면 누구인지 알아야 해서요. */
  sender?: { name: string; department: string };
  /** 받은 문의함: [확인했어요]·[처리했어요](휴가 요청은 [확인했어요]만, 승인·반려는 decision으로) */
  actions: CardAction[];
  kind: 'general' | 'leave';
  /**
   * 휴가 요청이면 종류·날·일수. balance는 받은 문의함에서, 아직 결정 전인 연차 요청일 때만 와요(공가·병가는 연차에서 빠지지 않아요).
   * sick은 받은 문의함에서 결정 전인 병가 요청일 때만 와요(보낸 사람 올해 병가, 열 때마다 계산). sickNote는 진단서 안내 대상(운영 값 일수를 넘음)이에요.
   */
  leave?: {
    type: LeaveType;
    officialReason?: OfficialLeaveReason;
    sickReason?: SickLeaveReason;
    days: LeaveDay[];
    total: number;
    balance?: LeaveRequestBalance | null;
    sick?: SickLeaveUsage | null;
    sickNote?: true;
  };
  /** 반려 사유(반려했을 때만) */
  decisionReason?: string;
  /** 승인했는데 근태 기록에 넣지 못했으면 false(근태 연결 안 함). 그룹웨어 근태에 직접 반영해야 해요. */
  recorded?: boolean;
  replies: InquiryReply[];
  /** 받은 문의함에서 지금 답장·승인·반려를 할 수 있는지 */
  canReply?: boolean;
  canDecide?: boolean;
}

/** GET /api/navi/inquiries/inbox · /mine. 받은 문의함은 분장표에 행이 있는 부서만 열려요(enabled). */
export interface InquiryListResponse {
  enabled: boolean;
  items: InquiryItem[];
}

// ── 신규 입사자 첫 2주 할 일(10/31 넓힐 후보 ①) ───────────────────
// 분장표 "온보딩 주차" 칸(1·2)이 붙은 행을 주차별로 보여 줘요. 누가 무엇을 했는지(진행)는 저장하지 않아요(ADR-21).

export interface OnboardingItem {
  rowId: string;
  task: string;
  team: string;
  desk: string;
  deskUrl?: string;
  nextStep: string;
  processingPeriod?: string;
  /** YYYY-MM-DD */
  revisedOn: string;
}

/**
 * GET /api/navi/leave/start(11/5, 처음 쓰는 직원 점검: 휴가 신청 버튼이 앞에 보였으면). 본인 휴가 신청 양식을 날 없이 열어요.
 * 남은 연차는 열 때 계산하고 저장하지 않아요(ADR-18). 근태 기록이 없거나 분장표에 휴가 신청 줄이 없으면 action이 null이에요.
 */
export interface LeaveStartResponse {
  action: Extract<CardAction, { type: 'leave-request' }> | null;
  /**
   * 11/6 A안(그룹웨어로 넘기기): 앱 안 휴가 결재가 꺼져 있으면(운영 기본) 양식 대신 신청 전 카드가 와요.
   * 남은 연차와 [그룹웨어에서 신청하기]만 있고, 신청·결재는 회사 그룹웨어가 해요.
   */
  card?: Card;
}

// ── 휴가 A안: 그룹웨어로 넘기기(11/6 사용자 결정, ADR-24 개정) ─────────────────────
// 휴가 신청·결재(팀장 → 인사)는 회사 그룹웨어 전자결재가 해요. 앱은 신청 전 판단(남은 연차·그날 내 일정·규정 한 줄)과
// 승인 뒤 반영(근태 기록 읽기)만 해요. 결재 권한·근태 쓰기는 없어요.

/** 신청 전 카드 꼬리(화면설계 "보안이 보이는 문구"). 카드가 신청이 아니라는 걸 늘 보여요. */
export const LEAVE_HANDOFF_TEXT = '아직 신청 전이에요. 그룹웨어에서 신청해야 결재가 시작돼요';
/** 휴가 신청 링크 칸이 비어 있을 때 버튼 대신 보이는 글 */
export const LEAVE_APPLY_IN_GROUPWARE = '그룹웨어에서 신청해 주세요';
/** 결재 중인 신청은 앱이 모르니 결재함으로 보내요(상태 묻기 답) */
export const LEAVE_APPROVALS_TEXT = '결재 진행 상황은 그룹웨어 결재함에서 봐요';
/** 병가·공가·경조 카드(11/6): 앱은 사유를 받지 않아요. 사유는 그룹웨어 신청서에만 적어요. */
export const LEAVE_REASON_IN_GROUPWARE = '사유는 그룹웨어 신청서에 적어 주세요';
/** 신청 전 카드가 걸린 일이 없는 날을 찾는 범위: 고른 날 앞뒤로 이만큼의 평일(회사 휴일은 몰라서 평일만 봐요) */
export const LEAVE_FREE_DAY_RANGE = 7;
/** 제안하는 날 수 */
export const LEAVE_FREE_DAY_MAX = 2;

/**
 * 그룹웨어 휴가 신청 주소의 자리 표시 값(11/6). 날짜·종류 코드만 넣어요. 사람이 쓴 글(질문·사유)은 넣지 않아요(R13).
 * - from·to: 첫날·끝날(YYYY-MM-DD). 날을 말하지 않았으면 빈 값이에요.
 * - type: annual · official · sick · family-event(경조)
 * - half: 하루면 빈 값, 하루짜리 반차면 am · pm, 오전·오후를 모르는 반차면 half
 */
export interface LeaveLinkValues {
  from: string;
  to: string;
  type: LeaveKind;
  half: '' | HalfPart | 'half';
}

/** POST /api/navi/leave/check(11/6 [이 날로 보기]): 그 날·종류로 신청 전 카드를 다시 계산해요. 날짜·종류 코드만 와요(글 없음). */
export interface LeaveCheckRequest {
  type: LeaveKind;
  days: LeaveDay[];
}

export interface LeaveCheckResponse {
  card: Card;
}

/**
 * 링크의 {from}·{to}·{type}·{half} 자리를 채워요. 운영자가 경로에 넣어 %7B…%7D로 바뀐 자리 표시도 채워요.
 * 값은 코드라서 URL 글자로 감싸 넣어요.
 */
export function fillLeaveLink(template: string, v: LeaveLinkValues): string {
  const values: Record<string, string> = { from: v.from, to: v.to, type: v.type, half: v.half };
  return template.replace(/\{(from|to|type|half)\}|%7B(from|to|type|half)%7D/gi, (_m, a?: string, b?: string) =>
    encodeURIComponent(values[(a ?? b ?? '').toLowerCase()] ?? ''),
  );
}

/** GET /api/navi/onboarding. 누구나 읽어요. 신규 입사자인지는 묻지도 판단하지도 않아요. */
export interface OnboardingResponse {
  weeks: { week: 1 | 2; items: OnboardingItem[] }[];
}

// ── 부서 간 문의 셈(10/31 넓힐 후보 ④, 사용자 결정: 받은 부서 주간 건수 · 7일 보관) ──

/** 이보다 적은 주는 숫자를 접어요(작은 묶음으로 사람을 알아보지 못하게). */
export const INQUIRY_WEEK_MIN = 10;

export interface InquiryWeekStat {
  /** ISO 주(예: 2026-W44, 한국 시간) */
  week: string;
  /** 그 주 월요일·일요일(YYYY-MM-DD) */
  from: string;
  to: string;
  /** 10건이 안 돼서 숫자를 접었으면 true이고 숫자 칸이 없어요. */
  folded: boolean;
  sent?: number;
  handled?: number;
  /** 처리 전(새 문의·확인함)에 보관 기간이 지나 지워진 건 */
  expiredOpen?: number;
}

/** GET /api/navi/inquiry-stats. 분장표 주인이 자기 부서(받은 쪽) 것만 봐요. */
export interface InquiryStatsResponse {
  department: string;
  weeks: InquiryWeekStat[];
}

// ── IT 오류 문장 → IT FAQ 원문 단계(10/31 넓힐 후보 ②) ─────────────
// 붙여 넣은 오류 문장은 저장하지 않아요. 화면이 공통 입력 검사로 가린 글만 POST 본문으로 보내요.
// 사용자 결정(10/31): 복사 버튼은 만들지 않고, 해결이 안 되면 앱 안 문의(확인 시트 → [보내기])로만 IT팀에 보내요.

/** 붙여넣기 한도. 문의 글 한도와 같아서 보낼 때 잘리지 않아요. */
export const IT_HELP_TEXT_MAX = INQUIRY_QUESTION_MAX;

export interface ItHelpRequest {
  text: string;
}

interface ItFaq {
  id: string;
  title: string;
  /** FAQ 원문 단계(고치지 않고 그대로) */
  steps: string[];
  /** YYYY-MM-DD */
  revisedOn: string;
}

/** POST /api/navi/it-help. 붙여 넣은 글은 응답에 다시 싣지 않아요. */
export interface ItHelpResponse {
  /** 근거 점수를 넘은 FAQ 하나. 못 찾았으면 없어요. */
  faq?: ItFaq;
  /** 비슷한 다른 FAQ 제목(최대 3개) */
  others: { id: string; title: string }[];
  /** 해결이 안 될 때 문의를 보낼 분장표 행(IT지원팀). 분장표에 없으면 null이에요. */
  inquiryRowId: string | null;
  /** 받는 팀 이름(문의 시트 머리에 써요) */
  inquiryTeam: string;
  /** 그 행의 업무 이름(문의 시트에 써요) */
  inquiryTask: string;
}

/** 해결이 안 됐을 때 IT팀 문의 글을 채우는 틀. 가린 글만 받아요. 브라우저가 만들고, 사람이 확인 시트에서 고친 뒤 [보내기]를 눌러요. */
export function itInquiryDraft(input: { maskedText: string; faqTitle?: string }): string {
  const head = input.faqTitle ? `IT FAQ "${input.faqTitle}"의 단계를 해 봤는데 해결되지 않았어요.` : '비슷한 IT FAQ를 찾지 못했어요.';
  const label = '\n\n오류 글(개인정보를 가린 글):\n';
  const text = input.maskedText.trim();
  const room = INQUIRY_QUESTION_MAX - head.length - label.length;
  // 넘치면 앞을 줄이고 끝을 남겨요. 오류 원인은 대개 끝에 있어요(11/1 QA M5).
  const kept = text.length > room ? `…${text.slice(text.length - room + 1)}` : text;
  return `${head}${label}${kept}`;
}

// ── IT FAQ 파일 올리기(11/3, ADR-25 "다시 볼 조건"). 분장표 S5 올리기와 같은 방식이에요. ──
// IT FAQ 주인 부서(FAQ "문의 행"이 가리키는 분장표 행의 주인 부서, 지금은 IT지원팀)의 분장표 주인만 올려요.
// 정해진 칸만 읽고 나머지 칸(사람 이름 등)은 버려요. 단계는 원문 그대로 저장해요(AI가 고치지 않아요).

export const IT_FAQ_COLUMNS = {
  id: 'ID',
  title: '제목',
  aliases: '다른 말',
  errorCodes: '오류 코드',
  steps: '단계',
  revisedOn: '개정일',
  rowId: '문의 행',
} as const;
export type ItFaqColumn = keyof typeof IT_FAQ_COLUMNS;
/** "다른 말"·"오류 코드" 칸 안에서 여러 값을 나누는 글자. "단계"는 칸 안 줄바꿈으로 나눠요. */
export const IT_FAQ_LIST_SEPARATOR = '|';

/** IT FAQ 한 항목(올리기 화면 목록) */
interface ItFaqSummary {
  id: string;
  title: string;
  aliases: string[];
  errorCodes: string[];
  steps: string[];
  /** YYYY-MM-DD */
  revisedOn: string;
  /** 해결이 안 될 때 문의를 보내는 분장표 행 */
  rowId: string | null;
  /** 가상 FAQ(demo)인지 올린 FAQ(upload)인지 */
  source: 'demo' | 'upload';
}

/** GET /api/navi/it-faq. IT FAQ 주인 부서가 아니면 enabled가 false이고 목록이 비어 있어요. */
export interface ItFaqListResponse {
  department: string;
  enabled: boolean;
  faqs: ItFaqSummary[];
}

export interface ItFaqChange {
  faqId: string;
  title: string;
  type: 'changed' | 'added';
  fields: { name: string; before?: string; after: string }[];
}

/** POST /api/navi/it-faq/preview(본문은 ChartUploadRequest와 같아요) */
export interface ItFaqPreviewResponse {
  department: string;
  baseVersion: string;
  changes: ItFaqChange[];
  /** 파일에 있었지만 바뀌지 않은 FAQ 수 */
  unchanged: number;
  /** 파일에 없어서 그대로 두는 우리 부서 FAQ 수(지우지 않아요) */
  untouched: number;
}

/** POST /api/navi/it-faq/apply(본문은 ChartApplyRequest와 같아요) */
export interface ItFaqApplyResponse {
  applied: number;
  /** YYYY-MM-DD */
  revisedOn: string;
  message: string;
}
