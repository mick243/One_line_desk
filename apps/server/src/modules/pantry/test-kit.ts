import type { Card, CardAction } from '@one-line-desk/shared';
import type { DeskUser } from '../../core/user';

// 같이 채워요 시험 도우미. 모의 직원 목록은 고치지 않고, 같은 층 여러 사람이 필요하면 가짜 DeskUser를 만들어요(가상 가명 ID).

export function fakeUser(n: number | string, opts: { floor?: string; facilities?: boolean } = {}): DeskUser {
  return {
    sessionId: `s-${n}`,
    pseudonymId: `p_test_${n}`,
    idpSubject: `test|${n}`,
    displayName: `가상 사람 ${n}`,
    department: '시험팀',
    floor: opts.floor ?? '3층',
    roles: opts.facilities ? ['employee', 'facilities'] : ['employee'],
  };
}

export type PostAction = Extract<CardAction, { type: 'post' }>;

/** 초안 카드에서 게시 행동을 꺼내요: 공개 미리보기의 [올리기] 또는 같은 품목 카드의 [새 요청으로]. */
export function postActionOf(cards: Card[]): PostAction {
  for (const card of cards) {
    const all = [card.actions.primary, ...card.actions.secondary];
    const post = all.find((a): a is PostAction => a?.type === 'post');
    if (post) return post;
  }
  throw new Error('게시 행동이 없는 카드예요');
}

/** 결정적 무작위(시험을 다시 돌려도 같은 순서) */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
