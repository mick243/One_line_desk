import type { Card } from '../cards';
import type { Kind } from '../kinds';

/** POST /api/ask 본문. kind가 있으면 분류를 건너뛰고 그 종류로 불러요(칩 바꾸기). */
export interface AskRequest {
  text: string;
  kind?: Kind;
}

/** 확신이 낮으면 cards가 비고 chips(최대 3개)로 되물어요. "다른 거예요"는 담당 안내예요(ADR-02). */
export interface AskResponse {
  kind: Kind;
  confidence: 'high' | 'low';
  chips: Kind[];
  cards: Card[];
}

/** 확인 시트(ADR-03). 버튼은 planId만 보내요. */
export interface PlanSheet {
  title: string;
  lines: string[];
  confirmLabel: string;
  /** 시트 아래 한 줄(무엇이 남는지, 주의할 점) */
  note?: string;
}

export type PlanCreateResponse =
  | { status: 'sheet'; planId: string; sheet: PlanSheet; expiresAt: string }
  /** 제안이 만료돼 같은 조건으로 다시 찾았어요 */
  | { status: 'expired'; message: string; cards: Card[] };

export type PlanConfirmResponse =
  { status: 'done'; card: Card } | { status: 'blocked'; card: Card; alternatives: Card[] } | { status: 'expired'; message: string; cards: Card[] };

export interface ApiError {
  error: string;
  message: string;
}
