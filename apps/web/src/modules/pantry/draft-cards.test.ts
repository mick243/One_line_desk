import type { Card } from '@one-line-desk/shared';
import { describe, expect, it } from 'vitest';
import { dropDraftCard } from './draft-cards';

// 후보 2: 요청 쓰기 칸 한 줄에서 나눈 품목 미리보기 카드. 하나를 올려도 나머지는 남아요.

const card = (id: string): Card => ({
  id,
  kind: 'pantry',
  label: '제안',
  variant: 'pantry-preview',
  headline: '',
  fields: [],
  evidence: { text: '내가 쓴 문장에서 뽑음', aiSummarized: false },
  actions: { secondary: [] },
  tail: '',
});

describe('[후보 2] 초안 카드 치우기', () => {
  it('누른 카드만 치우고 나머지 미리보기는 그대로 남아요', () => {
    const list = [card('pantry-preview-item1'), card('pantry-preview-item2'), card('pantry-same-7-item3')];
    expect(dropDraftCard(list, 'pantry-preview-item1')?.map((c) => c.id)).toEqual(['pantry-preview-item2', 'pantry-same-7-item3']);
  });

  it('마지막 카드를 치우면 null이라 결과 시트가 닫혀요', () => {
    expect(dropDraftCard([card('pantry-preview')], 'pantry-preview')).toBeNull();
    expect(dropDraftCard(null, 'pantry-preview')).toBeNull();
  });
});
