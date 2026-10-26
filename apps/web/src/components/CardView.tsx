import type { Card, CardAction } from '@one-line-desk/shared';
import { useState } from 'react';
import { KIND_TITLE } from '../labels';
import { cardRenderers } from '../modules/registry';

export interface CardViewProps {
  card: Card;
  onAction: (action: CardAction, card: Card) => Promise<void> | void;
  onWrong?: (card: Card) => void;
}

// 모든 결과를 같은 다섯 칸으로 그려요(화면설계 카드 문법). 모듈이 따로 그리는 카드는 variant로 맡겨요.
export function CardView(props: CardViewProps) {
  const Custom = props.card.variant ? cardRenderers[props.card.variant] : undefined;
  if (Custom) return <Custom {...props} />;
  return <DefaultCard {...props} />;
}

function DefaultCard({ card, onAction, onWrong }: CardViewProps) {
  const [busy, setBusy] = useState<string | null>(null);

  // 버튼은 누르면 바로 잠기고 "○○하는 중"으로 바뀌어요. 두 번 눌러도 한 번만 실행돼요.
  async function press(action: CardAction) {
    if (busy) return;
    setBusy(action.text);
    try {
      await onAction(action, card);
    } finally {
      setBusy(null);
    }
  }

  const primary = card.actions.primary;
  return (
    <article className={`result-card label-${card.label}`} aria-label={`${KIND_TITLE[card.kind]} ${card.label}`}>
      <header className='card-head'>
        <span className='kind'>{KIND_TITLE[card.kind]}</span>
        <span className='label'>{card.label}</span>
      </header>
      <div className='card-body'>
        <p className='headline'>{card.headline}</p>
        {card.fields.length > 0 && (
          <dl>
            {card.fields.map((f) => (
              <div key={f.name} className='field'>
                <dt>{f.name}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <p className='evidence'>
        {card.evidence.aiSummarized && <span className='ai-badge'>AI 정리</span>}
        {card.evidence.href ? (
          <a href={card.evidence.href} target='_blank' rel='noreferrer noopener'>
            {card.evidence.text}
          </a>
        ) : (
          card.evidence.text
        )}
      </p>
      <div className='card-actions'>
        {primary && (
          <button type='button' className='primary' disabled={busy !== null} onClick={() => void press(primary)}>
            {busy === primary.text ? `${primary.text.replace(/하기$/, '')}하는 중` : primary.text}
          </button>
        )}
        {card.actions.secondary.map((a) => (
          <button key={a.text} type='button' className='secondary' disabled={busy !== null} onClick={() => void press(a)}>
            {a.text}
          </button>
        ))}
        {card.wrong && onWrong && (
          <button type='button' className='link' onClick={() => onWrong(card)}>
            틀렸어요
          </button>
        )}
      </div>
      <p className='tail'>{card.tail}</p>
    </article>
  );
}
