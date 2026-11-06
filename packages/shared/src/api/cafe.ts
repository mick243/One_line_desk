import type { Card } from '../cards';
import { formatWon } from './pantry-order';

// 사내 카페 주문(F4, ADR-29, 11/6 1묶음: 주문 → 카페 판 → 건네기, 2묶음: 청구·입금 확인·한도·미납 막기·총무 정산). 출시 기본 끔이에요.
// 금액은 서버가 메뉴 직원가 × 수량으로 계산해요. 카페 판(바리스타)에는 이름·가명 ID·금액이 없어요.
// 사람별 청구액은 본인 화면이 원칙이고, 총무(facilities)만 정산 화면(S9)에서 이름·청구액·입금 코드·납부 상태를 봐요(등급 2 예외, 접속기록).
// [못 받았어요]·판 전용 세션·AI 채팅 주문은 3묶음이에요.

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
  /** S7 미납 막힘(8일부터, ADR-29) */
  unpaid: '지난달 카페 값을 아직 내지 않아서 새 주문을 받을 수 없어요',
  /** S7 내 청구 머리(등급 2 예외 범위) */
  myBill: '내 카페 값은 나만 보여요. 총무는 입금을 확인할 때만 봐요',
  /** 운영 설정에 회사 계좌 안내 글이 없을 때 */
  accountFallback: '계좌는 총무에게 물어봐 주세요',
  /** S9 머리(총무 청구액 보기 예외·접속기록) */
  settleHead: '이 화면을 열면 접속기록에 남아요. 청구액은 입금을 확인하는 데만 써요',
  /** S9 매출 합계 내려받기 안내. [입금 확인] 7일 뒤 주문 상세를 지워서, 1일~7일엔 지난달 주문이 모두 남아 있어요. */
  salesNote: '청구서가 나온 뒤 7일 안에 내려받아 회계에 넘겨 주세요',
  /** 알림 제목: 종류만이고 금액·메뉴·입금 코드는 넣지 않아요(ADR-16). 본인에게만 가요. */
  notifyBill: '카페 청구서가 나왔어요',
  notifyOverdue: '카페 값 납부 기한이 지났어요',
  notifyPaid: '카페 값 입금을 확인했어요',
  /** 총무(역할 facilities)에게: 누가 얼마를 바라는지는 넣지 않아요. */
  notifyLimitRequest: '카페 한도 요청이 왔어요',
  notifyLimitApproved: '카페 한도를 늘렸어요',
  notifyLimitRejected: '카페 한도 요청이 반려됐어요',
} as const;

/** S7 한도 막힘 "이번 달 한도(500,000원)를 넘어서 주문할 수 없어요. 필요하면 한도를 늘려 달라고 할 수 있어요" */
export function cafeLimitText(limitWon: number): string {
  return `이번 달 한도(${wonText(limitWon)})를 넘어서 주문할 수 없어요. 필요하면 한도를 늘려 달라고 할 수 있어요`;
}

/** 정해진 수(청구·한도). 운영 값(한도·기한)은 운영 설정에 있어요. */
export const CAFE_BILLING_LIMITS = {
  /** 한도 요청·늘린 한도·운영 값 한도의 범위(원) */
  minLimitWon: 10_000,
  maxLimitWon: 5_000_000,
  /** 회사 계좌 안내 글 길이 */
  accountMaxLength: 80,
  /** 메뉴 직원가 위 끝(원) */
  maxPriceWon: 100_000,
  /** 메뉴 이름·옵션 이름 길이, 옵션 수 */
  menuNameMax: 40,
  optionNameMax: 20,
  maxOptions: 10,
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
      /** 내 청구(본인만): 이번 달 한도·남은 한도·지난 청구서·회사 계좌 안내·내 한도 요청 */
      billing: CafeMyBilling;
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

// ── 청구·입금 확인·한도(2묶음) ─────────────────────────

/**
 * 청구서 상태. 앱은 돈을 받거나 보내지 않아요: 직원이 회사 계좌로 이체하면 총무가 [입금 확인]을 눌러요.
 * unpaid = 기한 안, overdue = 기한이 지났는데 아직 입금 확인 전(새 주문 막힘), paid = 입금 확인.
 */
export type CafeBillStatus = 'unpaid' | 'overdue' | 'paid';

export const CAFE_BILL_STATUS_LABEL: Record<CafeBillStatus, string> = {
  unpaid: '입금 전',
  overdue: '기한 지남',
  paid: '입금 확인',
};

/** 청구서의 주문 한 건(본인 화면) */
export interface CafeBillOrder {
  /** "10월 3일(금)" */
  dayLabel: string;
  lines: CafeLine[];
  totalWon: number;
}

/** 내 청구서 한 장(본인 화면만) */
export interface CafeBill {
  id: string;
  /** 주문한 달 'YYYY-MM' */
  month: string;
  /** "10월" */
  monthLabel: string;
  totalWon: number;
  count: number;
  /** 입금자명에 넣을 짧은 코드 */
  code: string;
  /** 납부 기한 "11월 7일(금)"(이날까지) */
  dueLabel: string;
  status: CafeBillStatus;
  orders: CafeBillOrder[];
}

export type CafeLimitRequestStatus = 'pending' | 'approved' | 'rejected';

/** GET /api/cafe의 "내 청구"(본인만). 숫자는 모두 서버가 주문 행에서 셌어요. */
export interface CafeMyBilling {
  /** 이번 달 한도(운영 값과 이번 달 늘린 한도 중 큰 값) */
  limitWon: number;
  /** 이번 달 남은 한도(한도 - 이번 달 지금까지, 0 아래로는 안 가요) */
  leftWon: number;
  /** 기한이 지난 미납 청구서가 있어 새 주문이 막혔는지 */
  blocked: boolean;
  /** 지난 청구서(미납은 갚을 때까지, 입금 확인은 7일 동안 보여요). 최근 달부터예요. */
  bills: CafeBill[];
  /** 회사 계좌 안내 글(운영 설정). 비어 있으면 "계좌는 총무에게 물어봐 주세요" */
  account: string;
  /** 납부 기한(청구일부터 며칠, 운영 값) */
  dueDays: number;
  /** 이번 달 내 한도 요청(가장 최근 것). 없으면 null */
  request: { amountWon: number; status: CafeLimitRequestStatus } | null;
}

/** POST /api/cafe/limit/request: 그 달 한도로 바라는 금액만(사유 글 없음). 지금 한도보다 커야 해요. */
export interface CafeLimitRequestBody {
  amountWon: number;
}

/** 총무 정산 화면(S9)의 청구서 한 줄. 이름은 디렉터리에서 그때 붙였어요(저장하지 않아요). */
export interface CafeSettleBill {
  id: string;
  name: string;
  totalWon: number;
  count: number;
  code: string;
  dueLabel: string;
  status: CafeBillStatus;
  /** 입금 확인한 때 "11월 3일(월) 10:20" */
  paidLabel: string | null;
}

/** 총무 정산 화면(S9)의 한도 요청 한 줄 */
export interface CafeSettleLimitRequest {
  id: string;
  name: string;
  /** 요청한 달 "11월" */
  monthLabel: string;
  /** 바라는 그 달 한도 */
  amountWon: number;
  /** 지금 그 사람의 그 달 한도 */
  limitWon: number;
  status: CafeLimitRequestStatus;
  /** 보낸 때 "11월 3일(월) 10:20" */
  createdLabel: string;
  /** 지난달 요청이면 늘려 줄 수 없어요(늘린 한도는 그 달에만). */
  current: boolean;
}

/** 총무 메뉴·직원가 관리 한 줄(쓰지 않는 메뉴도 보여요) */
export interface CafeAdminMenuItem extends CafeMenuItem {
  active: boolean;
}

/** GET /api/cafe/settle?month=YYYY-MM(총무만, 카페가 켜져 있을 때만). 열 때마다 접속기록에 남아요. */
export interface CafeSettleResponse {
  /** 고른 달(주문한 달) 'YYYY-MM'. 기본은 지난달(이번 달 1일에 나온 청구서)이에요. */
  month: string;
  monthLabel: string;
  /** 고를 수 있는 달(최근 것부터) */
  months: { month: string; label: string }[];
  bills: CafeSettleBill[];
  /** 고른 달 합계: 청구액 합계와 입금 확인한 금액 */
  summary: { count: number; totalWon: number; paidWon: number; overdue: number };
  requests: CafeSettleLimitRequest[];
  menu: CafeAdminMenuItem[];
  /** [지난달 매출 합계 내려받기]가 받을 달 'YYYY-MM' */
  salesMonth: string;
  salesMonthLabel: string;
}

/** POST /api/cafe/menu(더하기)·PUT /api/cafe/menu/:id(바꾸기). 이름·옵션은 공통 입력 검사를 지나야 해요. */
export interface CafeMenuInput {
  name: string;
  priceWon: number;
  options: string[];
  /** 바꾸기에서만: 파는 메뉴인지. 끄면 메뉴에서 빠지고, 이미 연 확인 시트도 실행 때 막혀요. */
  active?: boolean;
}
