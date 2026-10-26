import { type Card, PANTRY_TEXT, PREVIEW_LIMIT_FIELD, previewSentence, sameItemHeadline } from '@one-line-desk/shared';
import { makeCard } from '../../core/cards';

// 같이 채워요 카드(화면설계 카드 문법). 웹은 variant로 따로 그려요: 공개 미리보기 · 같은 품목 · 게시 막힘.
// 카드 ID에 사람을 가리키는 값은 넣지 않아요.
// "AI 정리"(aiSummarized)는 실제 모델이 뽑거나 판단했을 때만 참이에요. 이름 규칙·가짜 공급자·게이트웨이 거절이면 거짓이에요.

export const VARIANT = {
  preview: 'pantry-preview',
  same: 'pantry-same',
  blocked: 'pantry-blocked',
} as const;

/** 공개 미리보기(R2). 이 카드 자체가 확인이에요. [올리지 않기]는 서버를 부르지 않아요. */
export function previewCard(input: { name: string; proposalToken: string; limitFull: boolean; aiSummarized: boolean }): Card {
  return makeCard({
    id: 'pantry-preview',
    kind: 'pantry',
    label: '제안',
    variant: VARIANT.preview,
    headline: previewSentence(input.name),
    fields: [{ name: '올라갈 이름', value: input.name }, ...(input.limitFull ? [{ name: PREVIEW_LIMIT_FIELD, value: PANTRY_TEXT.postLimit }] : [])],
    evidence: { text: '내가 쓴 문장에서 뽑음', aiSummarized: input.aiSummarized },
    primary: { type: 'post', text: '올리기', proposalToken: input.proposalToken, itemName: input.name },
    tail: PANTRY_TEXT.previewTail,
  });
}

export interface SameTarget {
  bundleId: number;
  name: string;
  votes: number;
  myVote: boolean;
}

/**
 * 같은 품목 카드(+1). [새 요청으로]는 그 자리에서 공개 미리보기로 바뀌어요(웹 'pantry-same').
 * justPosted면 게시 순간 재검사에서 "방금 같은 품목이 올라왔어요"예요(이름 규칙이라 "AI 정리"가 없어요).
 */
export function sameItemCard(input: {
  target: SameTarget;
  newRequest: { proposalToken: string; itemName: string };
  justPosted?: boolean;
  aiSummarized: boolean;
}): Card {
  const { target } = input;
  return makeCard({
    id: `pantry-same-${target.bundleId}`,
    kind: 'pantry',
    label: '제안',
    variant: VARIANT.same,
    headline: input.justPosted ? PANTRY_TEXT.justPosted : sameItemHeadline(target.name),
    fields: [
      ...(input.justPosted ? [{ name: '같아 보이는 품목', value: target.name }] : []),
      { name: '지금 표 수', value: `${target.votes}표` },
      ...(target.myVote ? [{ name: '내 표', value: '이미 줬어요' }] : []),
    ],
    evidence: { text: '판의 기존 품목', aiSummarized: input.aiSummarized },
    primary: target.myVote
      ? { type: 'navigate', text: '판에서 보기', to: 'board' }
      : { type: 'fixed', text: '여기에 +1', method: 'POST', path: '/api/pantry/votes', body: { bundleId: target.bundleId } },
    secondary: [{ type: 'post', text: '새 요청으로', proposalToken: input.newRequest.proposalToken, itemName: input.newRequest.itemName }],
    tail: '새 글은 올라가지 않아요',
  });
}

/**
 * 게시 직전 재검사에서 막혔을 때(R5 "올릴 수 없는 글자"). [이름 고치기]는 새 제안 토큰으로 미리보기를 다시 열어요.
 * 막힌 이름은 카드·행동·토큰 어디에도 넣지 않아요(이 카드는 plan 결과·영수증에 저장돼요, R13).
 */
export function blockedNameCard(input: { message: string; proposalToken: string }): Card {
  return makeCard({
    id: 'pantry-blocked',
    kind: 'pantry',
    label: '막힘',
    variant: VARIANT.blocked,
    headline: input.message,
    evidence: { text: '올리기 직전에 다시 확인했어요', aiSummarized: false },
    secondary: [{ type: 'post', text: '이름 고치기', proposalToken: input.proposalToken, itemName: '' }],
    tail: '아무것도 바뀌지 않았어요',
  });
}

/** 게시 확정 카드. 되돌리는 길은 [표 거두기]예요. */
export function postedCard(input: { cardId: number; name: string; floor: string }): Card {
  return makeCard({
    id: `pantry-posted-${input.cardId}`,
    kind: 'pantry',
    label: '확정',
    headline: '우리 층 판에 올렸어요',
    fields: [
      { name: '품목 이름', value: input.name },
      { name: '표', value: '1표(내 표가 같이 들어갔어요)' },
    ],
    evidence: { text: `${input.floor} 같이 채워요 판`, aiSummarized: false },
    primary: { type: 'navigate', text: '판에서 보기', to: 'board' },
    secondary: [{ type: 'fixed', text: '표 거두기', method: 'DELETE', path: `/api/pantry/votes/${input.cardId}` }],
    tail: '품목 이름과 내 표 1개가 남아요. 내 이름은 안 보여요',
  });
}

/** 판에 담당 질문을 쓰면(F3-4). 단독 모드에서는 묻기 탭이 없어서 옮기기 버튼이 없어요. */
export function moveToAskCard(standalone: boolean, aiSummarized: boolean): Card {
  return makeCard({
    id: 'pantry-move-to-ask',
    kind: 'pantry',
    label: '안내',
    headline: standalone ? PANTRY_TEXT.standaloneOnly : PANTRY_TEXT.moveToAsk,
    evidence: { text: '판에는 탕비실 품목만 올라가요', aiSummarized },
    ...(standalone ? {} : { primary: { type: 'navigate' as const, text: '묻기로 옮기기', to: 'ask' as const } }),
    tail: '저장되는 것이 없어요',
  });
}

/** 품목 이름을 못 뽑았을 때 */
export function noNameCard(fromAsk: boolean, aiSummarized: boolean): Card {
  return makeCard({
    id: 'pantry-no-name',
    kind: 'pantry',
    label: '안내',
    headline: '어떤 품목인지 알아듣지 못했어요',
    fields: [{ name: '이렇게 써 보세요', value: '품목 이름만 짧게(예: 제로콜라)' }],
    evidence: { text: '내가 쓴 문장', aiSummarized },
    ...(fromAsk ? { primary: { type: 'navigate' as const, text: '같이 채워요로 가기', to: 'board' as const } } : {}),
    tail: '저장되는 것이 없어요',
  });
}
