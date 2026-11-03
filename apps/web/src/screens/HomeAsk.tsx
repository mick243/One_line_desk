// 홈 AI 채팅 "나에게 해당하는 일"(11/3 사용자 결정, ADR-27, 개선 회의 D8 해제).
// - 묻는 글은 공통 입력 검사·가림 줄을 지난 뒤 POST 본문으로만 보내요. 대화는 이 창 메모리에만 있어요(R13).
// - 홈 칸은 예약·신청을 하지 않아요. 다른 일이면 옮기기 카드를 누를 때 같은 문장을 그 페이지 칸에 채우기만 해요(바로 보내지 않아요).
// - "오늘·이번 주 내 일"은 홈을 열 때 한 번 불러요(폴링 아님).
import { type AppDestination, type CardAction, HOME_ASK_NOTE, type HomeOpen, type HomeTodayResponse } from '@one-line-desk/shared';
import { useEffect, useRef, useState } from 'react';
import { api, ApiFailure } from '../api';
import { useActions } from '../components/ActionHost';
import { CardView } from '../components/CardView';
import { CheckedInput } from '../components/CheckedInput';
import { useSlow } from '../components/useSlow';
import { OFFLINE_MESSAGE, SLOW_MESSAGE } from '../net';
import { pageOfKind } from './features';
import { HomeAnswer, HomeItemList, type HomeTurn, pushTurn } from './HomeAnswer';

const EXAMPLES = ['이번 주 내 일정 뭐 있어?', '내 휴가 어떻게 됐어?', '오늘 나한테 온 거 있어?'];

type Open = (page: AppDestination, text?: string, auto?: boolean) => void;

export function HomeAsk({ onOpen }: { onOpen: Open }) {
  const actions = useActions();
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<HomeTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const slow = useSlow(loading);
  const seq = useRef(0);

  const openItem = (open: HomeOpen) => onOpen(open.to, open.handoff, open.auto ?? false);

  async function ask(masked: string) {
    setLoading(true);
    const id = (seq.current += 1);
    try {
      const result = await api.homeAsk(masked);
      if (result.status === 'ok') {
        setTurns((list) => pushTurn(list, { id, text: masked, answer: result.response }));
        setText('');
      } else if (result.status === 'locked') setTurns((list) => pushTurn(list, { id, text: masked, lines: result.locks.map((l) => l.message) }));
      else setTurns((list) => pushTurn(list, { id, text: masked, lines: [result.message], retry: true }));
    } catch {
      setTurns((list) => pushTurn(list, { id, text: masked, lines: [OFFLINE_MESSAGE], retry: true }));
    } finally {
      setLoading(false);
    }
  }

  /** 옮기기 카드: 같은 문장을 그 페이지 칸에 채워요. 바로 보내지 않아서 그 페이지에서 사람이 다시 눌러야 해요(D8 noAuto). */
  function onCardAction(action: CardAction, turnText: string) {
    if (action.type === 'reask') return onOpen(pageOfKind(action.kind), turnText, false);
    if (action.type === 'navigate') return onOpen(action.to);
    if (action.type === 'link') return actions.run(action);
    return undefined;
  }

  return (
    <>
      <section className='home-ask' aria-label='나에게 해당하는 일 찾기'>
        <CheckedInput
          scope='나만 보여요'
          label='나에게 해당하는 일 찾기'
          placeholder='예) 이번 주 내 일정 뭐 있어?'
          submitLabel='찾기'
          value={text}
          onValueChange={setText}
          onSubmit={(masked) => ask(masked)}
        />
        <p className='hint home-ask-note'>{HOME_ASK_NOTE}</p>
        <div className='chips scroll' aria-label='예시 문장'>
          {EXAMPLES.map((ex) => (
            <button key={ex} type='button' className='chip' onClick={() => setText(ex)}>
              {ex}
            </button>
          ))}
        </div>
      </section>

      {(loading || turns.length > 0) && (
        <section className='results home-turns' aria-live='polite' aria-busy={loading}>
          {loading && <div className='skeleton' aria-label='찾는 중' />}
          {loading && slow && <p className='hint'>{SLOW_MESSAGE}</p>}
          {turns.map((turn) => (
            <div key={turn.id} className='room-turn'>
              <p className='chat-bubble mine'>{turn.text}</p>
              {turn.lines?.map((l) => (
                <p key={l} className='lock-line'>
                  {l}
                </p>
              ))}
              {turn.retry && !loading && (
                <button type='button' className='secondary small' onClick={() => void ask(turn.text)}>
                  다시 보내기
                </button>
              )}
              {turn.answer && (
                <HomeAnswer
                  answer={turn.answer}
                  onOpen={openItem}
                  cards={turn.answer.cards.map((card) => (
                    <CardView key={card.id} card={card} onAction={(action) => onCardAction(action, turn.text)} />
                  ))}
                />
              )}
            </div>
          ))}
        </section>
      )}

      <TodayCard onOpen={openItem} />
    </>
  );
}

/** "오늘·이번 주 내 일". 열 때 한 번 불러요. 불러오지 못하면 조용히 숨겨요(홈 메뉴는 그대로예요). */
function TodayCard({ onOpen }: { onOpen: (open: HomeOpen) => void }) {
  const [data, setData] = useState<HomeTodayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .homeToday()
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(e instanceof ApiFailure ? e.message : null));
    return () => {
      alive = false;
    };
  }, []);
  if (error) return <p className='lock-line'>{error}</p>;
  if (!data || !data.enabled) return null;
  return (
    <section className='card home-today' aria-label='오늘·이번 주 내 일'>
      <h2>오늘·이번 주 내 일</h2>
      {data.items.length === 0 ? (
        <p className='empty'>이번 주에 나에게 해당하는 일이 없어요.</p>
      ) : (
        <HomeItemList items={data.items} onOpen={onOpen} label='오늘·이번 주 내 일' />
      )}
    </section>
  );
}
