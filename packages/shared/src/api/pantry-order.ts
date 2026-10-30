import { RECORD_KEEP_DAYS } from '../retention';
import type { OrderReasonCode } from './pantry';

// 주문안 요청·응답 타입(ADR-08, R1·R16). 줄에는 묶음 표 수만 있고 투표자는 없어요.
// 이유 코드(ORDER_REASON_CODES·OrderReasonCode)는 api/pantry.ts에 있어요.

/** draft = 고치는 중, confirmed = 확정(주기 닫힘), replaced = 새 주문안을 만들어 밀려남 */
export type OrderPlanStatus = 'draft' | 'confirmed' | 'replaced';

/** 확정을 잠그는 경고(locks)와 경고만 띄우는 층 경고 */
export type OrderWarningKind = 'budget-below-min-sum' | 'over-budget' | 'floor-request-short' | 'floor-short';

/** 화면설계 S4 주문안 문구(R1·R16). 서버 경고와 화면이 같이 써요. */
export const ORDER_MESSAGES = {
  empty: '예산을 넣으면 주문안을 짜요.',
  budgetBelowMinSum: '예산이 층 최소 몫 합보다 작아요. 예산이나 최소 몫을 고쳐 주세요.',
  overBudget: '예산을 넘었어요',
  floorRequestShort: '요청이 모자라 최소 몫을 못 채웠어요',
  floorShort: '최소 몫을 못 채웠어요',
  editedLabel: '총무가 고침',
  // 나머지 요청은 다음 주기에도 남지만, 올린 지 7일이 되면 보관 잡이 내려요(ADR-21). 실제 동작대로 적어요(10/29 개선 회의 C1).
  confirmSheet: `주문에 들어간 품목의 표가 닫혀요. 나머지는 다음 주기에도 남지만, 올린 지 ${RECORD_KEEP_DAYS}일이 되면 내려가요. 실제 주문은 내보낸 파일로 기존 절차대로 해 주세요.`,
} as const;

export interface OrderWarning {
  kind: OrderWarningKind;
  /** 층 경고일 때만 있어요 */
  floor?: string;
  message: string;
  /** true면 [확정]이 잠겨요 */
  locks: boolean;
}

export interface OrderFloorSummary {
  floor: string;
  /** 층 최소 몫(원). 주문안을 만들 때의 설정값이에요. */
  minShare: number;
  /** 그 층 카탈로그 요청 금액 합(묶음마다 한 묶음 단위) */
  requested: number;
  /** 층 목표 = min(최소 몫, 요청 금액) */
  target: number;
  /** 주문안에 담은 금액 */
  total: number;
  /** 담은 금액이 최소 몫 이상인지 */
  met: boolean;
}

export interface OrderLine {
  /** 줄 ID(L1, L2 …) */
  lineId: string;
  floor: string;
  itemName: string;
  catalogItemId: string | null;
  /** 묶음 표 수(서로 다른 사람 수). 누가 줬는지는 없어요. */
  votes: number;
  unitPrice: number | null;
  packUnit: number | null;
  /** 개수. 기본은 한 묶음 단위(pack_unit개)예요. 넣지 않은 줄도 넣었다면의 개수를 보여 줘요. */
  quantity: number;
  /** 단가 × 개수 */
  amount: number;
  /** 주문에 들어가는 줄인지. 합계는 이 줄만 더해요. */
  included: boolean;
  reason: OrderReasonCode;
  /** 그 층 안에서 표 대비 값 순위(1부터) */
  rank: number;
  explanation: string;
  /** ai = 숫자 검사를 지난 AI 문장, template = 틀 문장 */
  explanationSource: 'ai' | 'template';
  /** "총무가 고침" 라벨 */
  edited: boolean;
}

export interface OrderPlanView {
  planId: string;
  status: OrderPlanStatus;
  budget: number;
  total: number;
  floors: OrderFloorSummary[];
  lines: OrderLine[];
  warnings: OrderWarning[];
  locked: boolean;
  /** false면 설명 문장을 아직 채우는 중이에요(틀 문장이 들어 있어요) */
  explained: boolean;
  createdAt: string;
  confirmedAt: string | null;
}

/** POST /api/pantry/order/plans. 층별 최소 몫은 층 설정(pantry_floor_settings)에서 읽어요. */
export interface OrderPlanCreateRequest {
  budget: number;
}

/** PUT /api/pantry/order/plans/:planId/lines/:lineId. 개수는 묶음 단위의 배수예요. */
export interface OrderLineChangeRequest {
  quantity: number;
}

/** GET /api/pantry/order/plans/current: 고치는 중인 주문안, 없으면 마지막으로 확정한 주문안 */
export interface OrderCurrentResponse {
  plan: OrderPlanView | null;
}

export interface OrderCycleChange {
  floor: string;
  /** 닫은 주기 번호. 열린 주기가 없었으면 null이에요. */
  closedCycleNo: number | null;
  openedCycleNo: number;
}

/** POST /api/pantry/order/plans/:planId/confirm */
export interface OrderConfirmResponse {
  plan: OrderPlanView;
  /** 주문됨이 된 묶음 수 */
  orderedBundles: number;
  /** 다음 주기로 넘어간 열린 묶음 수 */
  carriedOverBundles: number;
  cycles: OrderCycleChange[];
}

/** 내보내기 파일 칸. 투표자 칸은 없어요. */
export const ORDER_CSV_HEADER = ['층', '품목', '카탈로그 ID', '수량', '금액'] as const;

/** 21600 → "21,600". 서버 틀 문장과 화면이 같은 모양을 써요. */
export function formatWon(n: number): string {
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
