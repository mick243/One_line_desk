import { type Card, type CafeLine, CAFE_LIMITS, CAFE_STATUS_LABEL, CAFE_TEXT, kstTime, wonText } from '@one-line-desk/shared';
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

// ── 홈 채팅(3묶음, PRD F4-1·F4-13) ─────────────────────

const OPEN_CAFE = { type: 'navigate' as const, text: '카페에서 고르기', to: 'cafe' as const };

/**
 * 홈 채팅 주문 문장으로 만든 주문 후보(F4-1). [확인하고 주문하기]를 누르면 기존 확인 시트가 떠요(자동 실행 없음, 돈이 걸려서).
 * 금액은 서버가 메뉴 직원가 × 수량으로 셈한 값이에요(AI는 보지 않았어요). "AI 정리"는 모델이 실제로 문장을 나눴을 때만 붙여요.
 */
export function chatOrderCard(o: { items: OrderItem[]; totalWon: number; slot: number; proposalToken: string; byModel: boolean; notes: string[] }): Card {
  return makeCard({
    id: 'cafe-chat-order',
    kind: 'cafeteria',
    label: '제안',
    headline: `${linesOf(o.items).map(lineText).join(' · ')} · 픽업 ${slotLabel(o.slot)}`,
    fields: [
      { name: '메뉴', value: linesOf(o.items).map(lineText).join(' · ') },
      { name: '합계', value: wonText(o.totalWon) },
      { name: '픽업', value: slotLabel(o.slot) },
      ...o.notes.map((value) => ({ name: '알아 둘 것', value })),
    ],
    evidence: {
      text: o.byModel
        ? 'AI가 주문 문장을 메뉴로 나눴어요. 값은 서버가 메뉴 직원가로 계산했어요'
        : '쓴 낱말로 메뉴를 골랐어요. 값은 서버가 메뉴 직원가로 계산했어요',
      aiSummarized: o.byModel,
    },
    primary: { type: 'propose', text: '확인하고 주문하기', proposalToken: o.proposalToken },
    secondary: [OPEN_CAFE],
    tail: `누르면 확인 시트가 떠요. ${CAFE_TEXT.chatInput}`,
  });
}

/** 홈 채팅 주문을 받을 수 없을 때(영업 안 함·미납·한도·품절·칸 꽉 참·메뉴를 못 알아들음). 주문 버튼 없이 카페 페이지로만 가요. */
export function chatInfoCard(reason: string, headline: string, fields: Card['fields'] = []): Card {
  return makeCard({
    id: `cafe-chat-${reason}`,
    kind: 'cafeteria',
    label: '안내',
    headline,
    fields,
    evidence: { text: '주문 문장을 읽고 지금 카페 상태를 확인했어요', aiSummarized: false },
    primary: OPEN_CAFE,
    tail: `주문은 들어가지 않았어요. ${CAFE_TEXT.chatInput}`,
  });
}

/** "이번 달 커피값 얼마야?"(F4-13): 본인 숫자만 서버가 계산한 카드예요. AI에는 질문 글만 갔어요. */
export function spendCard(s: {
  monthWon: number;
  limitWon: number;
  leftWon: number;
  unpaid: { monthLabel: string; totalWon: number; dueLabel: string; code: string; overdue: boolean }[];
}): Card {
  return makeCard({
    id: 'cafe-spend',
    kind: 'cafeteria',
    label: '안내',
    headline: `이번 달 카페 값은 지금까지 ${wonText(s.monthWon)}이에요`,
    fields: [
      { name: '이번 달 지금까지', value: wonText(s.monthWon) },
      { name: '남은 한도', value: `${wonText(s.leftWon)}(이번 달 한도 ${wonText(s.limitWon)})` },
      ...s.unpaid.map((b) => ({
        name: `${b.monthLabel} 청구서`,
        value: `${wonText(b.totalWon)} · ${b.dueLabel}까지${b.overdue ? '(기한 지남)' : ''} · 입금 코드 ${b.code}`,
      })),
    ],
    evidence: { text: '내 주문 기록과 청구서로 서버가 계산했어요', aiSummarized: false },
    primary: { type: 'navigate', text: '카페에서 내 청구 보기', to: 'cafe' },
    tail: CAFE_TEXT.spendTail,
  });
}
