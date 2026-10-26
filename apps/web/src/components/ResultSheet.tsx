import { type AskResponse, type Card, KIND_LABEL, type Kind } from '@one-line-desk/shared';
import { useState } from 'react';
import { webModules } from '../modules/registry';
import { useActions } from './ActionHost';
import { CardView } from './CardView';
import { Sheet } from './Sheet';

// S2 결과 시트. 머리의 종류 칩 = 되묻기(확신이 낮을 때 칩 최대 3개 + "다른 거예요").
export function ResultSheet({
  response,
  loading,
  onReask,
  onClose,
}: {
  response: AskResponse | null;
  loading: boolean;
  onReask: (kind: Kind) => void;
  onClose: () => void;
}) {
  const actions = useActions();
  const [wrongCard, setWrongCard] = useState<Card | null>(null);
  // "틀렸어요 → 다른 담당이에요"로 바꾼 카드. 원래 카드 ID → 고른 행 카드
  const [replaced, setReplaced] = useState<Record<string, Card>>({});
  const { WrongSheet } = webModules;

  if (wrongCard) {
    return (
      <WrongSheet
        card={wrongCard}
        onReask={(k) => {
          setWrongCard(null);
          onReask(k);
        }}
        onReplace={(next) => {
          setReplaced((prev) => ({ ...prev, [wrongCard.id]: next }));
          setWrongCard(null);
        }}
        onClose={() => setWrongCard(null)}
      />
    );
  }

  return (
    <Sheet title={loading ? '알아듣는 중' : '결과'} onClose={onClose}>
      {loading && <div className='skeleton' aria-hidden='true' />}
      {!loading && response && (
        <>
          <div className='kind-chips' role='group' aria-label='종류'>
            {response.confidence === 'low' ? (
              <>
                <p className='hint'>어떤 일인지 골라 주세요</p>
                {response.chips.map((k) => (
                  <button key={k} type='button' className='chip' onClick={() => onReask(k)}>
                    {KIND_LABEL[k]}
                  </button>
                ))}
                <button type='button' className='chip' onClick={() => onReask('navi')}>
                  다른 거예요
                </button>
              </>
            ) : (
              <span className='chip selected'>{KIND_LABEL[response.kind]}</span>
            )}
          </div>
          {response.cards
            .map((original) => replaced[original.id] ?? original)
            .map((card) => (
              <CardView
                key={card.id}
                card={card}
                onWrong={setWrongCard}
                onAction={(action) => (action.type === 'reask' ? onReask(action.kind) : actions.run(action, card))}
              />
            ))}
        </>
      )}
    </Sheet>
  );
}
