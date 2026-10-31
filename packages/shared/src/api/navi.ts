import type { CardAction } from '../cards';
import type { Kind } from '../kinds';
import { RECORD_KEEP_DAYS } from '../retention';

// "틀렸어요" 선택지(R8). 세 문서가 같은 넷을 써요.
export const WRONG_REASONS = ['other-owner', 'not-listed', 'content-changed', 'wrong-kind'] as const;
export type WrongReason = (typeof WRONG_REASONS)[number];

export const WRONG_REASON_LABEL: Record<WrongReason, string> = {
  'other-owner': '다른 담당이에요',
  'not-listed': '목록에 없어요',
  'content-changed': '안내 내용이 바뀌었어요',
  'wrong-kind': '종류가 달라요',
};

/** 분장표 행 ID 모양(예: FIN-01). 파일 가져오기·피드백·행 카드가 같이 써요. */
export const NAVI_ROW_ID_PATTERN = '^[A-Z]{2,5}-[0-9]{2,3}$';

/** 기록은 이 여섯 칸뿐이에요. 사용자 ID·가명 ID·질문 원문은 없어요(R8). 시각은 서버가 붙여요. */
export interface WrongFeedbackRequest {
  predictedKind: Kind;
  correctedKind?: Kind;
  predictedRowId?: string;
  chosenRowId?: string;
  reason: WrongReason;
}

export interface WrongFeedbackResponse {
  saved: true;
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
  feedback: Record<WrongReason, number>;
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
export const INQUIRY_STATES = ['new', 'seen', 'done', 'approved', 'rejected'] as const;
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

/** 휴가 하루. 반차는 0.5일이에요. */
export interface LeaveDay {
  /** YYYY-MM-DD(한국 날짜) */
  date: string;
  kind: 'full' | 'half';
}

/** POST /api/navi/inquiries. requestId는 같은 문의를 두 번 보내지 않게 하는 값이에요(화면이 만들어요). */
export interface InquiryRequest {
  rowId: string | null;
  question: string;
  reason: string;
  requestId: string;
  /** 휴가 요청이면 쓸 날(ADR-24). 받는 팀(인사팀)이 승인하면 근태 기록에 들어가요. */
  leave?: { days: LeaveDay[] };
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
export interface LeaveNextPeriod {
  /** 다음 연차 기간 첫날 */
  periodStart: string;
  /** 다음 기간에 생기는 연차에서 이미 잡힌 날을 뺀 값 */
  remaining: number;
  after: number;
  days: number;
}

export interface InquiryReply {
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
  /** 휴가 요청이면 날과 일수. balance는 받은 문의함에서, 아직 결정 전일 때만 와요. */
  leave?: { days: LeaveDay[]; total: number; balance?: LeaveRequestBalance | null };
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

export interface ItFaq {
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
  const body = `${head}\n\n오류 글(가린 글):\n${input.maskedText.trim()}`;
  return body.length > INQUIRY_QUESTION_MAX ? `${body.slice(0, INQUIRY_QUESTION_MAX - 1)}…` : body;
}
