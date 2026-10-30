// 기능 페이지(담당 찾기·회의실·공지). 페이지마다 자기 입력 칸이 있고, 결과는 시트 대신 페이지 안에 보여요.
import { type Card, type CardAction, checkInput, type Kind } from '@one-line-desk/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { replaceCard, useActions } from '../components/ActionHost';
import { CardView } from '../components/CardView';
import { CheckedInput } from '../components/CheckedInput';
import { useSlow } from '../components/useSlow';
import { webModules } from '../modules/registry';
import { OFFLINE_MESSAGE, SLOW_MESSAGE } from '../net';
import type { Feature } from './features';

// 보낸 문장은 이 페이지 메모리에만 있어요. 저장소·주소에는 두지 않아요(R13).
export function FeaturePage({
  feature,
  initialText = '',
  autoRun = false,
  onMove,
  input,
  children,
}: {
  feature: Feature;
  initialText?: string;
  /** 다른 기능에서 옮겨 온 문장이면 열리자마자 찾아요. */
  autoRun?: boolean;
  /** "종류가 달라요"·"담당 찾기에서 찾기": 같은 문장을 다른 기능 페이지로 옮겨요. */
  onMove: (kind: Kind, text: string) => void;
  /** 기능이 자기 입력 칸을 쓰면(회의실 통합 입력 칸, 10/28) 공통 입력·결과 대신 이걸 그려요. 옮겨 온 문장도 넘겨요. */
  input?: (p: { initialText: string; autoRun: boolean; onMove: (kind: Kind, text: string) => void }) => ReactNode;
  children?: ReactNode;
}) {
  const actions = useActions();
  const [text, setText] = useState(initialText);
  const [sent, setSent] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [lines, setLines] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  // 보내지 못한 문장. [다시 보내기]가 같은 문장을 한 번 더 보내요(10/29 개선 회의 A3). 입력 칸 글은 그대로예요.
  const [retry, setRetry] = useState<string | null>(null);
  const slow = useSlow(loading);
  const [wrongCard, setWrongCard] = useState<Card | null>(null);
  const [inquiry, setInquiry] = useState<Extract<CardAction, { type: 'inquire' }> | null>(null);
  const [leaveRequest, setLeaveRequest] = useState<Extract<CardAction, { type: 'leave-request' }> | null>(null);
  const { WrongSheet, InquirySheet, LeaveRequestSheet } = webModules;

  async function ask(masked: string) {
    setSent(masked);
    setCards(null);
    setLines(null);
    setRetry(null);
    setLoading(true);
    try {
      const result = await api.ask(masked, feature.module);
      if (result.status === 'ok') setCards(result.response.cards);
      else if (result.status === 'locked') setLines(result.locks.map((l) => l.message));
      else {
        setLines([result.message]);
        setRetry(masked);
      }
    } catch {
      setLines([OFFLINE_MESSAGE]);
      setRetry(masked);
    } finally {
      setLoading(false);
    }
  }

  // 옮겨 온 문장은 이미 공통 검사를 지난 글이지만, 한 번 더 보고 걸리면 보내지 않아요(ADR-11).
  // 개발 모드(StrictMode)는 효과를 두 번 돌려서 한 번만 보내게 막아요.
  const autoSent = useRef(false);
  useEffect(() => {
    if (input || !autoRun || !initialText || autoSent.current) return;
    autoSent.current = true;
    const checked = checkInput(initialText);
    if (checked.locks.length === 0) void ask(checked.text);
    // 처음 열릴 때 한 번만 돌아요(페이지는 옮겨 올 때마다 새로 그려져요).
  }, []);

  const pageHead = (
    <header className='page-head'>
      <p className='eyebrow'>{feature.title}</p>
      <h1>{feature.question}</h1>
      <p className='lead'>{feature.summary}</p>
    </header>
  );

  if (input) {
    return (
      <div className='feature-page'>
        {pageHead}
        {input({ initialText, autoRun, onMove })}
        {children}
      </div>
    );
  }

  return (
    <div className='feature-page'>
      {pageHead}

      <CheckedInput
        scope='나만 보여요'
        label={feature.question}
        placeholder={feature.placeholder}
        submitLabel={feature.submit}
        value={text}
        onValueChange={setText}
        onSubmit={(masked) => ask(masked)}
      />
      {feature.examples?.length ? (
        <>
          <p className='example-label'>이렇게 써 보세요</p>
          <div className='chips scroll' aria-label='예시 문장'>
            {feature.examples.map((ex) => (
              <button key={ex} type='button' className='chip' onClick={() => setText(ex)}>
                {ex}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <section className='results' aria-live='polite' aria-busy={loading}>
        {loading && <div className='skeleton' aria-label='찾는 중' />}
        {loading && slow && <p className='hint'>{SLOW_MESSAGE}</p>}
        {lines?.map((l) => (
          <p key={l} className='lock-line'>
            {l}
          </p>
        ))}
        {retry && !loading && (
          <button type='button' className='secondary small' onClick={() => void ask(retry)}>
            다시 보내기
          </button>
        )}
        {cards?.map((card) => (
          <CardView
            key={card.id}
            card={card}
            onWrong={setWrongCard}
            onResults={setCards}
            onAction={(action) => {
              if (action.type === 'reask') return onMove(action.kind, sent ?? text);
              if (action.type === 'inquire') return setInquiry(action);
              if (action.type === 'leave-request') return setLeaveRequest(action);
              // 끝난 카드는 결과 카드로 바꿔요(예약한 후보 → 확정 카드). 다시 눌러 헷갈리지 않게 해요(QA D-B01).
              return actions.run(action, card, (next) => setCards((list) => (list ? replaceCard(list, card.id, next) : next)));
            }}
          />
        ))}
      </section>

      {children}

      {inquiry && <InquirySheet action={inquiry} initialQuestion={sent ?? text} onClose={() => setInquiry(null)} />}
      {leaveRequest && <LeaveRequestSheet action={leaveRequest} onClose={() => setLeaveRequest(null)} />}

      {wrongCard && (
        <WrongSheet
          card={wrongCard}
          onReask={(kind) => {
            setWrongCard(null);
            onMove(kind, sent ?? text);
          }}
          onReplace={(next) => {
            setCards((list) => list?.map((c) => (c.id === wrongCard.id ? next : c)) ?? [next]);
            setWrongCard(null);
          }}
          onClose={() => setWrongCard(null)}
        />
      )}
    </div>
  );
}
