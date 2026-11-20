import type { Card } from '@one-line-desk/shared';
import { describe, expect, it } from 'vitest';
import { replaceCard } from './ActionHost';

// 결과 카드를 대화·페이지 목록에 끼우는 규칙(11/11 QA E2).

const card = (id: string, headline: string, more: Partial<Card> = {}): Card => ({
  id,
  kind: 'rooms',
  label: '확정',
  headline,
  fields: [],
  evidence: { text: '', aiSummarized: false },
  actions: { secondary: [] },
  tail: '',
  ...more,
});

describe('replaceCard', () => {
  it('누른 카드 자리에 결과 카드를 넣어요', () => {
    const list = [card('a', '앞'), card('b', '누른 카드'), card('c', '뒤')];
    expect(replaceCard(list, 'b', [card('b2', '결과')]).map((c) => c.headline)).toEqual(['앞', '결과', '뒤']);
  });

  it('[QA E2] [바꾸기] 결과 카드와 id가 같은 확정 카드는 그 자리에서 새 회의실 카드로 바뀌고, 누른 [바꾸기] 카드는 빠져요', () => {
    const list = [card('rooms-reservation-9', '회의실 3A'), card('rooms-other-9', '다른 빈 회의실로 바꿀 수 있어요')];
    const out = replaceCard(list, 'rooms-other-9', [card('rooms-reservation-9', '회의실 3C')]);
    expect(out.map((c) => [c.id, c.headline])).toEqual([['rooms-reservation-9', '회의실 3C']]);
  });

  it('[QA E2] 취소 결과 카드가 replaces로 가리킨 [바꾸기] 카드는 지워요', () => {
    const list = [card('rooms-reservation-9', '예약했어요'), card('rooms-other-9', '다른 빈 회의실로 바꿀 수 있어요'), card('x', '다른 카드')];
    const cancelled = card('rooms-reservation-9', '예약을 취소했어요', { replaces: ['rooms-other-9'] });
    expect(replaceCard(list, 'rooms-reservation-9', [cancelled]).map((c) => c.headline)).toEqual(['예약을 취소했어요', '다른 카드']);
  });

  it('같은 카드를 두 번 넣지 않아요', () => {
    const list = [card('a', '앞'), card('b', '누른 카드')];
    const out = replaceCard(list, 'b', [card('a', '새 앞'), card('c', '새 카드')]);
    expect(out.map((c) => [c.id, c.headline])).toEqual([
      ['a', '새 앞'],
      ['c', '새 카드'],
    ]);
  });
});
