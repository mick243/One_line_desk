import type { Kind } from '../kinds';

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
