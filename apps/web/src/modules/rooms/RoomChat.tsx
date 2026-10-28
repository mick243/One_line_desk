import type { Card, MyLoansResponse, RoomChatResponse } from '@one-line-desk/shared';
import { useEffect, useRef, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { useActions } from '../../components/ActionHost';
import { CardView } from '../../components/CardView';
import { CheckedInput } from '../../components/CheckedInput';

// 회의실 채팅(10/28, ADR-19). "내일 3시 6명 잡아 줘"처럼 시키면 바로 예약·대여하고, 물어보면 카드로만 보여 줘요.
// 대화는 이 페이지 메모리에만 있어요. 저장소·주소에는 두지 않아요(R13). 수동 예약(빈 방 찾기·모든 회의실)은 그대로예요.

const EXAMPLES = ['내일 3시 6명 회의실 잡아 줘', '내일 3시 회의에 빔프로젝터 빌려 줘', '지금 빈 방 있어?', '3C 장비 뭐 있어?', '내 예약 보여 줘'];
/** 화면에 남기는 말풍선 수. 넘으면 오래된 것부터 지워요. */
const KEEP = 20;

interface Message {
  id: number;
  who: 'me' | 'desk';
  text: string;
  cards: Card[];
  aiParsed?: boolean;
  failed?: boolean;
}

export function RoomChat({ auto }: { auto: boolean }) {
  const actions = useActions();
  const [text, setText] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [waiting, setWaiting] = useState(false);
  const next = useRef(0);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length, waiting]);

  const push = (m: Omit<Message, 'id'>) => setMessages((list) => [...list, { ...m, id: ++next.current }].slice(-KEEP));

  async function send(masked: string) {
    push({ who: 'me', text: masked, cards: [] });
    setText('');
    setWaiting(true);
    try {
      // 보낼 때마다 새 요청 ID예요. 같은 요청이 두 번 가도 서버가 한 번만 실행해요.
      const res = await apiRequest<RoomChatResponse>('POST', '/api/rooms/chat', { text: masked, requestId: crypto.randomUUID() });
      push({ who: 'desk', text: res.reply, cards: res.cards, aiParsed: res.aiParsed });
      if (res.changed) actions.refresh();
    } catch (e) {
      push({ who: 'desk', text: e instanceof ApiFailure ? e.message : '지금 답하지 못했어요. 잠시 뒤에 다시 보내 주세요', cards: [], failed: true });
    } finally {
      setWaiting(false);
    }
  }

  return (
    <section className='card room-chat' aria-label='회의실 채팅'>
      <div className='room-chat-head'>
        <h2>회의실 채팅</h2>
        {messages.length > 0 && (
          <button type='button' className='neutral small' onClick={() => setMessages([])}>
            대화 지우기
          </button>
        )}
      </div>
      <p className='hint'>
        {auto
          ? '"잡아 줘·빌려 줘"처럼 시키면 바로 예약·대여해요. 물어보면 카드로만 보여 줘요. 취소는 늘 한 번 더 확인해요.'
          : '지금은 채팅 자동 실행이 꺼져 있어요. 채팅은 카드로 보여 주고, 예약·대여는 카드에서 한 번 더 확인해요.'}
      </p>

      {messages.length > 0 && (
        <div className='chat-thread' aria-live='polite' aria-busy={waiting}>
          {messages.map((m) => (
            <div key={m.id} className={`chat-turn ${m.who}`}>
              <p className={m.failed ? 'chat-bubble lock-line' : 'chat-bubble'}>
                {m.text}
                {m.aiParsed && <span className='chat-ai'>AI 해석</span>}
              </p>
              {m.cards.map((card) => (
                <CardView
                  key={card.id}
                  card={card}
                  onResults={(cards) => setMessages((list) => list.map((x) => (x.id === m.id ? { ...x, cards } : x)))}
                  onAction={(action) => actions.run(action, card)}
                />
              ))}
            </div>
          ))}
          {waiting && <div className='skeleton' aria-label='답을 만드는 중' />}
          <div ref={end} />
        </div>
      )}

      <CheckedInput
        scope='나만 보여요'
        label='회의실 채팅'
        placeholder='예) 내일 3시 6명 회의실 잡아 줘'
        submitLabel='보내기'
        value={text}
        onValueChange={setText}
        onSubmit={(masked) => send(masked)}
      />
      <div className='chips scroll' aria-label='채팅 예시'>
        {EXAMPLES.map((ex) => (
          <button key={ex} type='button' className='chip' onClick={() => setText(ex)}>
            {ex}
          </button>
        ))}
      </div>
    </section>
  );
}

/** 회의실 페이지 "내 대여" 칸. 대여가 없거나 회의실 쓰기가 꺼지면 숨겨요. [대여 취소]·[반납]은 확인 시트를 거쳐요. */
export function MyLoans() {
  const { run, version } = useActions();
  const [data, setData] = useState<MyLoansResponse | null>(null);

  useEffect(() => {
    let alive = true;
    apiRequest<MyLoansResponse>('GET', '/api/rooms/my-loans')
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [version]);

  if (!data?.enabled || data.items.length === 0) return null;
  return (
    <section className='card' aria-label='내 대여'>
      <h2>내 대여</h2>
      <ul className='plain my-reservations'>
        {data.items.map((l) => (
          <li key={l.id} className='invited'>
            <div>
              <p>
                <strong>{l.kind}</strong> · {l.itemName}
              </p>
              <p className='hint'>
                {l.when}
                {l.roomName ? ` · ${l.roomName} 회의` : ''} · 가져갈 곳 {l.home}
              </p>
            </div>
            <button type='button' className='neutral small' onClick={() => void run(l.endAction)}>
              {l.endAction.text}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
