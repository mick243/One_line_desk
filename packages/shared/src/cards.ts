import type { LeaveKind } from './api/navi';
import type { RoomOverview } from './api/rooms';
import type { Kind, ModuleKind } from './kinds';

// 카드 머리 라벨은 넷이고, 글자로 보여 줘요. 색만으로 가르지 않아요(R7).
const CARD_LABELS = ['제안', '확정', '안내', '막힘'] as const;
export type CardLabel = (typeof CARD_LABELS)[number];

// 막힘은 확인 순간 재검사에서만 써요(R5).
const BLOCKED_REASONS = ['다른 예약', '올릴 수 없는 글자', '기능 꺼짐'] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/**
 * 카드 행동. 쓰기는 사람이 한 번 확인해야만 실행돼요(R2).
 * - propose: 주 버튼 → 서버가 plan을 만들고 확인 시트를 돌려줘요(회의실 예약 등)
 * - post: 공개 미리보기의 [올리기]. 이 카드 자체가 확인이에요(게시)
 * - fixed: 고정 버튼 쓰기(+1·표 거두기 등). 모듈 경로를 바로 불러요
 * - link: 바깥 링크(원문·그룹웨어·창구)
 * - reask: 같은 문장을 다른 기능 페이지로 옮겨 다시 찾아요("종류가 달라요", 문의함에서 찾기)
 * - navigate: 앱 안 화면으로 가요
 */
export type CardAction =
  | { type: 'propose'; text: string; proposalToken: string }
  /** 공개 판 [올리기]. nameBlock은 서버가 초안에서 이 이름을 막을 때 이유(명단 대조 포함)예요. 이름을 고치면 브라우저가 다시 검사해요(QA-26). */
  | { type: 'post'; text: string; proposalToken: string; itemName: string; nameBlock?: { kinds: string[]; message: string } }
  | {
      type: 'fixed';
      text: string;
      method: 'POST' | 'DELETE';
      path: string;
      body?: Record<string, unknown>;
      /** 있으면 화면이 확인 시트를 먼저 띄워요(예약 취소·합치기·되돌리기 등). 없으면 바로 실행해요(+1·표 거두기). */
      confirm?: { title: string; lines: string[]; confirmLabel: string; note?: string };
    }
  | { type: 'link'; text: string; href: string }
  /**
   * 글을 클립보드에 복사해요(11/6 A안 [신청 내용 복사]). value는 서버가 정한 구조 값 글(종류·날짜)이고 사람이 쓴 글이 아니에요.
   * 앱은 복사한 글을 어디에도 남기지 않아요(브라우저 저장소·서버 0).
   */
  | { type: 'copy'; text: string; value: string }
  /**
   * [이 날로 보기](11/6 A안 신청 전 카드): 걸린 일이 없는 가까운 날로 신청 전 카드를 다시 계산해요(읽기만, 쓰기 없음).
   * 날짜·종류 코드만 들고, 화면이 POST /api/navi/leave/check로 보내요.
   */
  | { type: 'leave-day'; text: string; leaveType: LeaveKind; days: { date: string; kind: 'full' | 'half'; half?: 'am' | 'pm' }[] }
  | { type: 'reask'; text: string; kind: Kind }
  | { type: 'navigate'; text: string; to: AppDestination }
  /**
   * 담당 팀에 문의 보내기 양식을 열어요(ADR-16). 양식은 페이지가 띄우고, 보내기는 확인 시트를 거쳐요.
   * routed는 문의하기(11/2, ADR-26)에서 서버가 받는 팀을 골랐을 때만 와요. by는 누가 골랐는지(ai는 모델이 실제로 고른 때만),
   * alternatives는 사람이 받는 곳을 바꿀 수 있는 다른 후보예요. 보내기 전에 사람이 확인 시트에서 봐요(AI가 보내지 않아요).
   */
  | {
      type: 'inquire';
      text: string;
      rowId: string | null;
      team: string;
      task: string;
      routed?: { by: InquiryRouteBy; alternatives: InquiryTarget[] };
    }
  /**
   * 휴가 신청 양식을 열어요(ADR-24). days는 질문에서 읽은 날(규칙·AI)로 미리 채우고, 사람이 고쳐요.
   * remaining은 본인 남은 연차(본인 화면에만 와요). 보내기는 확인 시트를 거쳐요.
   */
  | {
      type: 'leave-request';
      text: string;
      rowId: string;
      team: string;
      task: string;
      /** 반차는 half(오전 am · 오후 pm)가 같이 와요(11/3). 질문에서 반차라고만 했으면 half 없이 와서 양식이 오전·오후를 고르게 해요. */
      days: { date: string; kind: 'full' | 'half'; half?: 'am' | 'pm' }[];
      remaining: number;
      /** 이번 연차 기간 마지막 날. 이 뒤의 날은 다음 기간 연차에서 빠져요. */
      periodEnd: string;
      /**
       * 다음 연차 기간 첫날. 이 날부터 고른 날은 이번 기간 연차에서 빼지 않아요.
       * 11/6 사용자 결정: 숫자는 이번 기간 것만 보여서 다음 기간 남은 연차는 없어요(leaveNextPeriodText 한 문장).
       */
      next: { periodStart: string };
      /**
       * 본인 근무 달력이 기본(월~금·공휴일 쉼)과 다를 때만 와요(11/6 주말 근무자·공휴일 운영 값). 양식이 쉬는 날 검사에 써요.
       * weekdays는 일하는 요일(0 일요일 … 6 토요일)이에요. 회사 휴일은 서버가 막아요.
       */
      calendar?: { weekdays: number[]; publicHolidaysOff: boolean };
      /** 날짜 없이 양만 말했을 때("이틀 쓰고 싶어") 고를 일수 안내 */
      planned?: number;
      /** 양식을 열 때 고른 종류. 없으면 연차예요. 공가 카드에서 열면 'official'(11/1), 병가 카드에서 열면 'sick'(11/3)이에요. */
      leaveType?: 'annual' | 'official' | 'sick';
      /**
       * 병가 양식용(11/3, 본인 것만): 올해 병가 쓴 날·한도(0이면 없음 → null)와 진단서 안내 기준 일수(이 일수를 넘으면 안내).
       * 서버가 근태 기록으로 계산하고 저장하지 않아요(ADR-18).
       */
      sick?: { year: number; used: number; limit: number | null; noteOverDays: number };
    }
  /** 회의 참석자 고르기 양식을 열어요(ADR-17). 보내기는 확인 시트를 거쳐요. */
  | { type: 'invite'; text: string; reservationId: string; roomName: string; when: string };

/** 문의를 받는 곳: 분장표 행(없으면 대표 창구) */
export interface InquiryTarget {
  rowId: string | null;
  team: string;
  task: string;
}
/** 받는 곳을 누가 골랐는지: 모델(ai)·분장표 규칙(rule)·못 찾아 대표 창구(none) */
export type InquiryRouteBy = 'ai' | 'rule' | 'none';

/** 앱 안 페이지. 기능마다 페이지가 따로 있어요(10/26 화면 구조 변경, ADR-02 개정). */
// ai-eval: 관리자(운영자)만 보는 AI 정답률 화면(11/5 시험, R7 예외). 마이 페이지 아래에 있어요.
// cafe: 사내 카페 주문(S7, 11/6 ADR-29, 출시 기본 끔). 바리스타의 카페 판(S8)은 바리스타 홈이라 따로 페이지가 없어요.
// cafe-settle: 카페 정산(S9, 총무만, 11/6 2묶음). 마이 페이지 > 내 역할 아래에 있어요.
export const APP_DESTINATIONS = [
  'home',
  'navi',
  'rooms',
  'notices',
  'board',
  'mine',
  'ops',
  'chart',
  'it-help',
  'onboarding',
  'ai-eval',
  'cafe',
  'cafe-settle',
] as const;
export type AppDestination = (typeof APP_DESTINATIONS)[number];

/** "틀렸어요" 시트에 필요한 것. 안내·제안 카드에만 붙어요(화면설계 카드 문법). */
interface WrongInfo {
  predictedKind: Kind;
  predictedRowId?: string;
  /** 다른 후보 행(최대 3개). 담당 카드에서만 와요. */
  candidates: { id: string; label: string }[];
}

// 모든 결과는 같은 다섯 칸으로 그려요(화면설계 "카드 문법").
export interface Card {
  /** 화면 key·되돌아올 때 쓰는 ID. 사람을 가리키는 값을 넣지 않아요. */
  id: string;
  /** 1 머리: 종류 + 상태 라벨 */
  kind: ModuleKind;
  label: CardLabel;
  /** 모듈이 따로 그리는 카드(예: 'pantry-preview'). 없으면 공통 CardView가 그려요. */
  variant?: string;
  /** 2 본문: 핵심 한 줄 + 종류마다 정해진 칸 2~4개 */
  headline: string;
  fields: { name: string; value: string }[];
  /** 3 근거: 어디서 왔는지. aiSummarized는 AI가 고르거나 뽑은 카드에만 붙여요. */
  evidence: { text: string; href?: string; aiSummarized: boolean };
  /** 4 행동: 주 버튼 하나 + 보조 버튼 */
  actions: { primary?: CardAction; secondary: CardAction[] };
  wrong?: WrongInfo;
  /** 회의실 현황 카드(variant 'rooms-overview')의 회의실 한 줄 목록. fields에도 같은 내용이 글로 있어요(따로 그리지 못하는 화면용). */
  overview?: RoomOverview;
  /** 5 꼬리: 무엇이 바뀌고 무엇이 남는지 한 줄 */
  tail: string;
}
