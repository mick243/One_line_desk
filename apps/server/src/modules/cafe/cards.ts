import { type Card, type CafeLine, CAFE_LIMITS, CAFE_STATUS_LABEL, kstTime, wonText } from '@one-line-desk/shared';
import { makeCard } from '../../core/cards';
import type { OrderItem } from './repo';

// 카페 카드(화면설계 카드 문법). 주문한 본인에게만 가요. 카페 판에는 카드가 없고 이름·금액도 없어요.

const SLOT_MS = CAFE_LIMITS.slotMinutes * 60_000;

/** "14:10–14:20" */
export function slotLabel(start: number): string {
  return `${kstTime(start)}–${kstTime(start + SLOT_MS)}`;
}

/** 메뉴 한 줄 글 "아메리카노(아이스·연하게) × 2" */
export function lineText(l: Pick<CafeLine, 'name' | 'options' | 'qty'>): string {
  return `${l.name}${l.options.length ? `(${l.options.join('·')})` : ''} × ${l.qty}`;
}

export const linesOf = (items: OrderItem[]): CafeLine[] => items.map((i) => ({ name: i.name, options: i.options, qty: i.qty }));

const EVIDENCE = { text: '메뉴 직원가 × 수량으로 서버가 계산했어요', aiSummarized: false };

/** 주문이 들어갔어요(확인 시트 [주문하기] 결과). */
export function orderedCard(o: { id: string; pickupNo: number; items: OrderItem[]; totalWon: number; slot: number }): Card {
  return makeCard({
    id: `cafe-order-${o.id}`,
    kind: 'cafeteria',
    label: '확정',
    headline: `주문했어요 · 픽업 번호 ${o.pickupNo}`,
    fields: [
      { name: '메뉴', value: linesOf(o.items).map(lineText).join(' · ') },
      { name: '합계', value: wonText(o.totalWon) },
      { name: '픽업', value: slotLabel(o.slot) },
      { name: '상태', value: CAFE_STATUS_LABEL.waiting },
    ],
    evidence: EVIDENCE,
    tail: '카페가 받기 전(접수 대기)까지만 취소할 수 있어요. 음료가 나오면 알림이 가요',
  });
}

/** 주문을 취소했어요(고정 버튼 결과). */
export function cancelledCard(o: { id: string; pickupNo: number; items: OrderItem[]; slot: number }): Card {
  return makeCard({
    id: `cafe-order-${o.id}`,
    kind: 'cafeteria',
    label: '확정',
    headline: `주문을 취소했어요 · 픽업 번호 ${o.pickupNo}`,
    fields: [
      { name: '메뉴', value: linesOf(o.items).map(lineText).join(' · ') },
      { name: '픽업', value: slotLabel(o.slot) },
    ],
    evidence: { text: '내 주문', aiSummarized: false },
    tail: '이번 달 합계에서 빠져요. 취소한 주문은 7일 뒤 지워져요',
  });
}

/** 확인 순간 다시 검사해서 막혔어요. 주문은 들어가지 않아요(R5). */
export function blockedCard(reason: string, headline: string, fields: Card['fields'] = []): Card {
  return makeCard({
    id: `cafe-blocked-${reason}`,
    kind: 'cafeteria',
    label: '막힘',
    headline,
    fields,
    evidence: { text: '[주문하기]를 누른 순간 다시 확인했어요', aiSummarized: false },
    tail: '주문은 들어가지 않았어요. 카페 페이지에서 다시 골라 주세요',
  });
}

/** 제안이 만료됐어요. 다시 찾을 조건이 없어서 다시 고르라고만 알려요. */
export function expiredCard(): Card {
  return makeCard({
    id: 'cafe-expired',
    kind: 'cafeteria',
    label: '안내',
    headline: '시간이 지나 주문을 다시 골라 주세요',
    evidence: { text: '확인 시트는 잠깐만 열려 있어요', aiSummarized: false },
    tail: '주문은 들어가지 않았어요',
  });
}

/** "링크만"(R4): 카페 안내 링크 카드 */
export function cafeLinkCard(href: string): Card {
  return makeCard({
    id: 'link-cafeteria',
    kind: 'cafeteria',
    label: '안내',
    headline: '지금은 카페 주문을 앱에서 받지 않아요',
    evidence: { text: '운영 설정의 카페 안내 링크', href, aiSummarized: false },
    primary: { type: 'link', text: '카페 안내 열기', href },
    tail: '저장되는 것이 없어요',
  });
}
