import type { Card } from '../cards';
import { formatWon } from './pantry-order';

// 사내 카페 주문(F4, ADR-29, 11/6 1묶음: 주문 → 카페 판 → 건네기). 출시 기본 끔이에요.
// 금액은 서버가 메뉴 직원가 × 수량으로 계산해요. 카페 판(바리스타)에는 이름·가명 ID·금액이 없어요.
// 청구·입금·한도·미납·총무 정산·판 전용 세션·AI 채팅 주문은 다음 묶음이에요.

export const CAFE_ORDER_STATUSES = ['waiting', 'making', 'ready', 'picked', 'cancelled'] as const;
export type CafeOrderStatus = (typeof CAFE_ORDER_STATUSES)[number];

/** 화면에 보이는 상태 이름(PRD F4-4: 접수 대기 → 만드는 중 → 나왔어요 → 가져감) */
export const CAFE_STATUS_LABEL: Record<CafeOrderStatus, string> = {
  waiting: '접수 대기',
  making: '만드는 중',
  ready: '나왔어요',
  picked: '가져감',
  cancelled: '취소함',
};

/** 카페 판에서 바리스타가 누르는 다음 상태(고정 버튼). 건너뛰거나 되돌리지 않아요. */
export const CAFE_NEXT_STATUS: Partial<Record<CafeOrderStatus, { to: CafeOrderStatus; button: string }>> = {
  waiting: { to: 'making', button: '받기' },
  making: { to: 'ready', button: '다 됐어요' },
  ready: { to: 'picked', button: '가져갔어요' },
};

/** 카페 판이 보여 주는 상태(오늘 아직 건네지 않은 주문) */
export type CafeBoardStatus = 'waiting' | 'making' | 'ready';

/** 정해진 수(서버·화면이 같이 써요) */
export const CAFE_LIMITS = {
  /** 한 주문의 메뉴 줄 */
  maxLines: 5,
  /** 한 줄의 잔 수 */
  maxQty: 5,
  /** 픽업 칸 길이(분) */
  slotMinutes: 10,
  /** 고를 수 있는 픽업 칸 수(지금 다음 칸부터) */
  slotCount: 12,
  /** 카페 판이 이만큼 서버에 안 보이면 주문 받기를 멈춰요(ADR-29) */
  boardSeenMs: 2 * 60_000,
  /** 카페 판 새로 읽기 간격 */
  boardPollMs: 3_000,
} as const;

/** 화면 문구(docs/화면설계.md "보안이 보이는 문구" S7·S8 줄) */
export const CAFE_TEXT = {
  open: '지금 주문할 수 있어요',
  closed: '지금은 카페가 주문을 받지 않아요',
  sheetTail: '이번 달 카페 값은 다음 달 1일에 청구돼요. 7일 안에 회사 계좌로 보내 주세요',
  boardHead: '이 화면에는 주문한 사람 이름이 나오지 않아요. 픽업 번호로 건네 주세요',
  /** 음료가 나왔을 때 주문한 사람에게 가는 알림 글. 메뉴·금액을 넣지 않아요(ADR-16). */
  notify: '주문한 음료가 나왔어요',
} as const;

/** 원 단위 금액 글 "2,500원" */
export function wonText(won: number): string {
  return `${formatWon(won)}원`;
}

/** 메뉴 한 줄(직원 화면). 옵션은 메뉴가 정한 이름만이고 값은 바뀌지 않아요. */
export interface CafeMenuItem {
  id: string;
  name: string;
  priceWon: number;
  options: string[];
  soldOut: boolean;
}

/** 고를 수 있는 10분 픽업 칸. start는 한국 시각 ISO(+09:00)예요. */
export interface CafeSlot {
  start: string;
  /** "14:10" */
  label: string;
  /** 남은 잔 수(0이면 꽉 참) */
  left: number;
  full: boolean;
}

/** 주문의 메뉴 한 줄(이름·옵션·잔 수). 금액은 없어요. */
export interface CafeLine {
  name: string;
  options: string[];
  qty: number;
}

/** 오늘 내 주문 한 줄(본인 화면) */
export interface CafeMyOrder {
  id: string;
  pickupNo: number;
  lines: CafeLine[];
  pickupLabel: string;
  status: CafeOrderStatus;
  totalWon: number;
  /** 카페가 받기 전(접수 대기)에만 취소할 수 있어요. */
  cancellable: boolean;
}

/** GET /api/cafe. 링크만이면 카페 안내 링크 카드예요. */
export type CafeResponse =
  | { status: 'link'; card: Card }
  | {
      status: 'on';
      /** 바리스타가 영업 중이고 카페 판이 2분 안에 서버에 보였는지 */
      open: boolean;
      menu: CafeMenuItem[];
      slots: CafeSlot[];
      /** 오늘 내 주문 */
      orders: CafeMyOrder[];
      /** 이번 달(한국 날짜) 지금까지 내 주문 합계. 취소한 주문은 빼요. 서버가 주문 행으로 셌어요. */
      monthTotalWon: number;
    };

/** 주문 한 줄 고르기. 금액 칸은 없어요(서버가 계산해요). */
export interface CafeOrderLineInput {
  menuId: string;
  qty: number;
  options: string[];
}

/** POST /api/cafe/order/propose */
export interface CafeProposeRequest {
  lines: CafeOrderLineInput[];
  /** 고른 픽업 칸 시작(한국 시각 ISO, GET /api/cafe의 slots[].start) */
  pickupSlot: string;
}

/** 제안 토큰만 돌려줘요. 화면은 기존 확인 시트 흐름(POST /api/plans → [주문하기])을 그대로 써요. */
export interface CafeProposeResponse {
  proposalToken: string;
}

/** 카페 판 주문 한 줄. 이름·가명 ID·금액은 없어요(ADR-29). */
export interface CafeBoardOrder {
  id: string;
  pickupNo: number;
  lines: CafeLine[];
  pickupLabel: string;
  status: CafeBoardStatus;
  /** 주문이 들어온 시각 "14:03" */
  orderedAt: string;
}

/** GET /api/cafe/board(바리스타만, 3초마다). */
export interface CafeBoardResponse {
  /** [영업 시작]을 눌렀는지 */
  open: boolean;
  orders: CafeBoardOrder[];
  /** 품절 바꾸기용 메뉴(이름·품절만, 가격 없음) */
  menu: { id: string; name: string; soldOut: boolean }[];
}

/** POST /api/cafe/orders/:id/status */
export interface CafeStatusRequest {
  to: 'making' | 'ready' | 'picked';
}

/** PUT /api/cafe/menu/:id/sold-out */
export interface CafeSoldOutRequest {
  soldOut: boolean;
}
