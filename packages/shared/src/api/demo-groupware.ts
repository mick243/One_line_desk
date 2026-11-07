import type { LeaveDayChoice, LeaveKind } from './navi';

// 시연 전용 가상 그룹웨어 전자결재(11/6 사용자 결정, 휴가 A안). 한 줄 데스크가 아니라 "회사 그룹웨어" 자리에 서는 흉내예요.
// 시연 설정에서만 경로가 열려요(/api/demo/groupware/*, 화면 /demo/groupware/leave·/demo/groupware/inbox). 운영에는 경로가 없어요.
// 결재선은 기안자 부서 팀장 → 인사팀(기안자가 팀장이거나 부서에 팀장이 없으면 인사팀만)이에요.
// 최종 승인되면 가상 근태 기록에 휴가가 들어가고, 한 줄 데스크는 그 근태 기록만 읽어요(앱은 이 문서를 읽지 않아요).

/** 화면 머리띠 문구(화면설계 "보안이 보이는 문구") */
export const DEMO_GROUPWARE_BAND = '가상 그룹웨어 · 시연 전용 — 한 줄 데스크가 아니에요';
/** 신청 사유·반려 사유 글자 수 상한 */
export const DEMO_GROUPWARE_REASON_MAX = 200;
/** 신청서 사유가 꼭 있어야 하는 종류(병가·공가·경조). 연차는 골라서 적어요. */
export const reasonRequired = (kind: LeaveKind): boolean => kind !== 'annual';

/** 결재선 한 칸. 팀장 칸은 그 사람, 인사팀 칸은 인사팀 사람 누구나 결재해요. */
export interface GroupwareStep {
  label: string;
  state: 'waiting' | 'current' | 'approved' | 'rejected';
  /** 결재한 사람 이름과 시각("11월 6일(금) 10:02") */
  by?: string;
  at?: string;
}

/** 결재 문서(휴가 신청서) 한 장 */
export interface GroupwareDoc {
  id: string;
  type: LeaveKind;
  typeLabel: string;
  /** "11월 14일(금) 하루 · 11월 17일(월) 오전 반차" */
  daysText: string;
  drafter: { name: string; department: string };
  line: GroupwareStep[];
  state: 'pending' | 'approved' | 'rejected';
  stateLabel: string;
  rejectReason?: string;
  /**
   * 기안자가 적은 사유(11/6). 그 문서의 지금 결재자와 기안자 본인에게만 와요. 가상 그룹웨어 메모리에만 있고
   * 한 줄 데스크·근태 기록·로그·감사·DB로 가지 않아요.
   */
  reason?: string;
  /** 최종 승인 뒤 근태 기록에 들어갔는지 */
  recorded?: boolean;
  /** "11월 6일(금) 09:30" */
  createdAt: string;
}

/** 결재자로 보기 목록 한 줄(가상 직원 중 팀장·인사팀 사람). ref는 이 서버가 뜬 동안만 쓰는 값이에요(IdP 주체가 아니에요). */
export interface GroupwareApprover {
  ref: string;
  name: string;
  department: string;
  role: '팀장' | '인사팀';
}

/** GET /api/demo/groupware/form: 기안자(지금 앱에 로그인한 사람)와 결재선 미리 보기 */
export interface GroupwareFormResponse {
  drafter: { name: string; department: string };
  line: string[];
  /** 오늘(YYYY-MM-DD, 한국 날짜) */
  today: string;
  /**
   * 여러 날 신청서에서 빼는 날 이름(11/6 근무 달력): 기본 "주말·공휴일·회사 휴일", 주말 근무자는 "근무하지 않는 요일·…",
   * 공휴일을 쉬지 않는 회사는 "…·회사 휴일"만이에요. 기안자 본인 근무 요일로 정해요.
   */
  offDays: string;
}

/**
 * POST /api/demo/groupware/drafts. 사유는 병가·공가·경조면 꼭, 연차는 골라서 적어요(11/6 사용자 결정).
 * 공통 입력 검사를 지나고, 가상 그룹웨어 메모리에만 둬요(7일, 서버가 다시 뜨면 비워짐).
 */
export interface GroupwareDraftRequest {
  type: LeaveKind;
  from: string;
  to: string;
  /** 하루짜리면 하루·오전 반차·오후 반차, 여러 날이면 full만 */
  half: LeaveDayChoice;
  reason?: string;
  requestId: string;
}

/** GET /api/demo/groupware/inbox?as=<ref> */
export interface GroupwareInboxResponse {
  approvers: GroupwareApprover[];
  /** 고른 결재자. 안 골랐으면 null이고 waiting은 비어 있어요. */
  as: GroupwareApprover | null;
  /** 고른 결재자 차례인 문서 */
  waiting: GroupwareDoc[];
  /** 내가(앱에 로그인한 사람) 올린 문서 */
  mine: GroupwareDoc[];
}

/** POST /api/demo/groupware/docs/:id/decision. 반려는 사유가 꼭 있어야 해요. */
export interface GroupwareDecisionRequest {
  as: string;
  decision: 'approved' | 'rejected';
  reason?: string;
}
