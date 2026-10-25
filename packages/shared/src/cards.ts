import type { Kind } from './kinds';

// 카드 머리 라벨은 넷이고, 글자로 보여 줘요. 색만으로 가르지 않아요(R7).
export const CARD_LABELS = ['제안', '확정', '안내', '막힘'] as const;
export type CardLabel = (typeof CARD_LABELS)[number];

// 모든 결과는 같은 다섯 칸으로 그려요(화면설계 "카드 문법").
export interface Card {
  /** 1 머리: 종류 + 상태 라벨 */
  kind: Kind | 'link';
  label: CardLabel;
  /** 2 본문: 핵심 한 줄 + 종류마다 정해진 칸 2~4개 */
  headline: string;
  fields: { name: string; value: string }[];
  /** 3 근거: 어디서 왔는지. aiSummarized는 AI가 고르거나 뽑은 카드에만 붙여요. */
  evidence: { text: string; href?: string; aiSummarized: boolean };
  /** 4 행동: 주 버튼 하나 + 보조 버튼, "틀렸어요"는 안내·제안 카드에만 */
  actions: { primary?: CardAction; secondary: CardAction[]; wrongButton: boolean };
  /** 5 꼬리: 무엇이 바뀌고 무엇이 남는지 한 줄 */
  tail: string;
}

export interface CardAction {
  text: string;
  /** 쓰기 카드에는 서버가 서명한 제안 토큰만 붙어요(R2). */
  proposalToken?: string;
  href?: string;
}

// 막힘은 확인 순간 재검사에서만 써요(R5).
export const BLOCKED_REASONS = ['다른 예약', '올릴 수 없는 글자', '기능 꺼짐'] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];
