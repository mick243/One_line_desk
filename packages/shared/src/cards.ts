import type { RoomOverview } from './api/rooms';
import type { Kind, ModuleKind } from './kinds';

// 카드 머리 라벨은 넷이고, 글자로 보여 줘요. 색만으로 가르지 않아요(R7).
export const CARD_LABELS = ['제안', '확정', '안내', '막힘'] as const;
export type CardLabel = (typeof CARD_LABELS)[number];

// 막힘은 확인 순간 재검사에서만 써요(R5).
export const BLOCKED_REASONS = ['다른 예약', '올릴 수 없는 글자', '기능 꺼짐'] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/**
 * 카드 행동. 쓰기는 사람이 한 번 확인해야만 실행돼요(R2).
 * - propose: 주 버튼 → 서버가 plan을 만들고 확인 시트를 돌려줘요(회의실 예약 등)
 * - post: 공개 미리보기의 [올리기]. 이 카드 자체가 확인이에요(게시)
 * - fixed: 고정 버튼 쓰기(+1·표 거두기 등). 모듈 경로를 바로 불러요
 * - link: 바깥 링크(원문·그룹웨어·창구)
 * - reask: 같은 문장을 다른 기능 페이지로 옮겨 다시 찾아요("종류가 달라요", 담당 찾기에서 찾기)
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
  | { type: 'reask'; text: string; kind: Kind }
  | { type: 'navigate'; text: string; to: AppDestination }
  /** 담당 팀에 문의 보내기 양식을 열어요(ADR-16). 양식은 페이지가 띄우고, 보내기는 확인 시트를 거쳐요. */
  | { type: 'inquire'; text: string; rowId: string | null; team: string; task: string }
  /** 회의 참석자 고르기 양식을 열어요(ADR-17). 보내기는 확인 시트를 거쳐요. */
  | { type: 'invite'; text: string; reservationId: string; roomName: string; when: string };

/** 앱 안 페이지. 기능마다 페이지가 따로 있어요(10/26 화면 구조 변경, ADR-02 개정). */
export type AppDestination = 'home' | 'navi' | 'rooms' | 'notices' | 'board' | 'mine' | 'ops' | 'chart';

/** "틀렸어요" 시트에 필요한 것. 안내·제안 카드에만 붙어요(화면설계 카드 문법). */
export interface WrongInfo {
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
