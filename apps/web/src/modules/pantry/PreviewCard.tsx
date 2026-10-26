import { type Card, type CardAction, checkItemName, PANTRY_ITEM_NAME_MAX, PANTRY_TEXT, PREVIEW_LIMIT_FIELD, previewSentence } from '@one-line-desk/shared';
import { useMemo, useState } from 'react';
import { CardView, type CardViewProps } from '../../components/CardView';

// 같이 채워요 카드 그리기(화면설계 카드 문법).
// - 'pantry-preview' 공개 미리보기: 이 카드 자체가 확인이에요(R2). 이름을 고치면 공통 검사가 다시 돌아요.
// - 'pantry-same' 같은 품목 카드: [여기에 +1] 또는 [새 요청으로] → 그 자리에서 공개 미리보기로 바뀌어요.
// - 'pantry-blocked' 게시 막힘: [이름 고치기] → 그 자리에서 공개 미리보기로 바뀌어요.

type PostAction = Extract<CardAction, { type: 'post' }>;

const postOf = (actions: (CardAction | undefined)[]): PostAction | undefined => actions.find((a): a is PostAction => a?.type === 'post');

/** 공개 미리보기 본체. 기본 선택이 없고, [올리지 않기]는 서버를 부르지 않아요. */
function PostPreview({ action, card, limitFull, onAction }: { action: PostAction; card: Card; limitFull: boolean; onAction: CardViewProps['onAction'] }) {
  // 고친 이름은 이 컴포넌트 상태(페이지 메모리)에만 있어요.
  const [name, setName] = useState(action.itemName);
  const [state, setState] = useState<'idle' | 'busy' | 'dismissed'>('idle');
  const trimmed = name.trim();
  const check = useMemo(() => checkItemName(trimmed), [trimmed]);
  const tooLong = trimmed.length > PANTRY_ITEM_NAME_MAX;
  const blocked = !trimmed || !check.ok || tooLong || limitFull;

  if (state === 'dismissed') {
    return (
      <article className='result-card' aria-label='탕비실 안내'>
        <p className='hint'>올리지 않았어요. 아무것도 남지 않아요.</p>
      </article>
    );
  }

  async function post() {
    if (blocked || state === 'busy') return;
    setState('busy');
    try {
      // 판에 올라가는 글자 = 위 문장에 보이는 글자(앞뒤 빈칸을 뺀 이름)예요.
      await onAction({ ...action, text: '올리기', itemName: trimmed }, card);
    } finally {
      setState('idle');
    }
  }

  return (
    <article className='result-card label-제안' aria-label='탕비실 제안'>
      <header className='card-head'>
        <span className='kind'>탕비실</span>
        <span className='label'>제안</span>
      </header>
      <div className='card-body'>
        <div className='checked-input'>
          <div className='scope'>올라갈 품목 이름 · 고칠 수 있어요</div>
          <div className='row'>
            <input
              type='text'
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label='올라갈 품목 이름'
              autoComplete='off'
              autoCorrect='off'
              spellCheck={false}
              maxLength={60}
              disabled={state === 'busy'}
            />
          </div>
          {trimmed && check.message && (
            <p className='lock-line' role='alert'>
              {check.message}
            </p>
          )}
          {tooLong && <p className='lock-line'>품목 이름은 {PANTRY_ITEM_NAME_MAX}자까지예요</p>}
        </div>
        {trimmed && <p className='headline'>{previewSentence(trimmed)}</p>}
        {limitFull && (
          <p className='lock-line' role='alert'>
            {PANTRY_TEXT.postLimit}
          </p>
        )}
      </div>
      <p className='evidence'>
        {/* "AI 정리"는 서버가 실제 모델로 뽑거나 판단했다고 알려 준 카드에만 붙여요(이름 규칙·가짜 공급자면 없음). */}
        {card.evidence.aiSummarized && <span className='ai-badge'>AI 정리</span>}내가 쓴 문장에서 뽑음
      </p>
      <div className='card-actions'>
        {/* 두 버튼은 무게가 같고 기본 선택이 없어요. */}
        <button type='button' className='secondary' disabled={blocked || state === 'busy'} onClick={() => void post()}>
          {state === 'busy' ? '올리는 중' : '올리기'}
        </button>
        <button type='button' className='secondary' disabled={state === 'busy'} onClick={() => setState('dismissed')}>
          올리지 않기
        </button>
      </div>
      <p className='tail'>{PANTRY_TEXT.previewTail}</p>
    </article>
  );
}

export function PreviewCardView({ card, onAction }: CardViewProps) {
  const action = postOf([card.actions.primary]);
  if (!action) return <CardView card={{ ...card, variant: undefined }} onAction={onAction} />;
  return <PostPreview action={action} card={card} limitFull={card.fields.some((f) => f.name === PREVIEW_LIMIT_FIELD)} onAction={onAction} />;
}

/** 같은 품목 카드와 막힘 카드: [새 요청으로]·[이름 고치기]를 누르면 그 자리에서 공개 미리보기가 돼요. */
function SwapToPreview({ card, onAction }: CardViewProps) {
  const [editing, setEditing] = useState(false);
  const action = postOf(card.actions.secondary);
  if (editing && action) return <PostPreview action={action} card={card} limitFull={false} onAction={onAction} />;
  return <CardView card={{ ...card, variant: undefined }} onAction={(a, c) => (a.type === 'post' ? setEditing(true) : onAction(a, c))} />;
}

export const SameItemCardView = SwapToPreview;
export const BlockedCardView = SwapToPreview;
