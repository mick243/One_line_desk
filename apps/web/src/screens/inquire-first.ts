import type { Card, CardAction } from '@one-line-desk/shared';

// 문의하기 페이지(11/3 사용자 결정, ADR-26 개정): 담당 카드의 [○○에 문의하기]를 카드의 주 버튼으로 올려요.
// 원래 주 버튼(창구 링크 [창구 열기]·[메일 보내기]·[총무 창구 열기])은 보조 버튼 맨 앞으로 내려요. 버튼이 사라지지는 않아요.
// 서버 카드는 그대로예요. 화면에서 그리는 자리만 바꿔요(홈 채팅·MCP 링크는 이 페이지를 거치지 않아요).
// 올리지 않는 때:
// - 동점 카드("어느 업무인지 골라 주세요"): 먼저 업무 칩을 골라야 해서 대표 창구 문의를 주 버튼으로 두지 않아요.
// - 주 버튼이 링크가 아닌 카드(옮기기·신청 같은 다른 일): 그 일을 가리지 않아요.

type Inquire = Extract<CardAction, { type: 'inquire' }>;

export function inquireFirst(card: Card): Card {
  const { primary, secondary } = card.actions;
  const inquire = secondary.find((a): a is Inquire => a.type === 'inquire');
  if (!inquire) return card;
  if (secondary.some((a) => a.type === 'fixed')) return card;
  if (primary && primary.type !== 'link') return card;
  const rest = secondary.filter((a) => a !== inquire);
  return { ...card, actions: { ...card.actions, primary: inquire, secondary: primary ? [primary, ...rest] : rest } };
}
