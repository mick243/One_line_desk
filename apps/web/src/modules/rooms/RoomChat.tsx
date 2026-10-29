import { type Card, checkInput, type Kind, type MyLoansResponse, type RoomChatPreview, type RoomChatResponse, roomChatPreview } from '@one-line-desk/shared';
import { useEffect, useRef, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { replaceCard, useActions } from '../../components/ActionHost';
import { CardView } from '../../components/CardView';
import { CheckedInput } from '../../components/CheckedInput';
import { Icon } from '../../components/Icon';
import { ScrollChips } from '../../components/ScrollChips';
import { newRequestId } from '../../net';

// 회의실 입력 칸(10/28 통합 개편, ADR-19). 빈 회의실 찾기와 회의실 채팅을 한 칸으로 합쳤어요.
// - 묻는 말("내일 3시 6명", "빈 회의실 있어?")은 찾기만 하고, 시키는 말("잡아 줘·빌려 줘")은 조건이 다 있으면 바로 예약·대여해요.
// - 보내기 전에 같은 규칙(공유 패키지 roomChatPreview)으로 "바로 예약돼요 / 찾기만 해요"를 미리 보여 주고, 버튼 이름도 바꿔요.
// - 다른 페이지에서 옮겨 온 문장은 사람이 보내기를 누르지 않았으니 자동 실행하지 않아요(noAuto).
// - 대화는 위아래 구분선 안의 대화창에 순서대로 쌓이고, 길어지면 창 안에서 스크롤돼요. 새 답이 오면 그 문장이 창 위에 오게 넘겨요.
//   대화는 이 페이지 메모리에만 있어요(R13). 수동 예약(모든 회의실)은 그대로예요.

/** 칩 줄에 보이는 문장 수(예시·최근 쓴 문장 모두). 넘치면 옆으로 넘겨요. */
const CHIP_MAX = 5;
/** 시키면 바로 실행되는 상태에서 찾기와 예약의 차이를 보여 주는 예시예요. */
const AUTO_EXAMPLES = ['내일 3시 6명', '내일 3시 6명 잡아 줘', '내일 3시 회의에 빔프로젝터 빌려 줘', '지금 빈 회의실 있어?', '내 예약 보여 줘'];
/** 자동 실행이 꺼졌을 때(카드에서 확인하고 예약) */
const CONFIRM_EXAMPLES = ['내일 3시 6명', '다음 주 화요일 10시부터 2시간 4명', '지금 빈 회의실 있어?', '노트북 남았어?', '내 예약 보여 줘'];
/** 회의실 쓰기가 꺼졌을 때는 보기만 되는 예시예요(QA D-C03). */
const READ_ONLY_EXAMPLES = ['지금 빈 회의실 있어?', '오늘 회의실 현황', '3C 장비 뭐 있어?', '노트북 남았어?'];
/** 화면에 남기는 대화 수. 넘으면 오래된 것부터 지워요. */
const KEEP = 20;

interface Turn {
  id: number;
  text: string;
  reply?: string;
  cards: Card[];
  aiParsed?: boolean;
  failed?: boolean;
}

type Mode = 'auto' | 'confirm' | 'read-only';

/** 입력 칸 아래 한 줄과 버튼 이름. 지금 스위치와 친 문장으로 정해요. */
function guide(mode: Mode, text: string): { line: string; tone: 'quiet' | 'warn'; submit: string } {
  if (mode === 'read-only') return { line: '지금은 예약·대여를 그룹웨어에서 해요. 빈 회의실·장비 현황은 여기서 볼 수 있어요.', tone: 'quiet', submit: '찾기' };
  if (mode === 'confirm') return { line: '지금은 확인 후 예약해요. 카드의 [이 회의실로 예약]으로 한 번 더 확인해요.', tone: 'quiet', submit: '찾기' };
  if (!text.trim()) return { line: '"잡아 줘·빌려 줘"처럼 시키면 바로 예약·대여해요. 물어보면 찾기만 해요.', tone: 'quiet', submit: '보내기' };
  const preview: RoomChatPreview = roomChatPreview(text);
  if (preview === 'may-run-reserve')
    return { line: '시키는 말이에요 · 날짜·시각·인원이 다 있으면 바로 예약돼요. 끝나면 [취소]로 되돌릴 수 있어요.', tone: 'warn', submit: '예약하기' };
  if (preview === 'may-run-rent')
    return { line: '시키는 말이에요 · 언제 쓸지 정해져 있으면 바로 빌려요. 끝나면 [대여 취소]로 되돌릴 수 있어요.', tone: 'warn', submit: '빌리기' };
  if (preview === 'cancel') return { line: '취소·반납은 카드의 버튼으로 한 번 더 확인하고 해요.', tone: 'quiet', submit: '보내기' };
  return { line: '묻는 말이라 찾기만 해요. 예약은 카드에서 한 번 더 확인해요.', tone: 'quiet', submit: '찾기' };
}

/**
 * auto: 채팅 자동 실행이 켜졌는지. write: 회의실 쓰기가 켜졌는지(꺼지면 예약·대여는 그룹웨어에서 해요).
 * initialText·autoRun: 다른 페이지에서 옮겨 온 문장. autoRun이면 열리자마자 찾되 자동 실행은 하지 않아요.
 * onMove: 회의실 일이 아니면 같은 문장을 다른 기능 페이지로 옮겨요.
 * recent·onSent·onRemoveRecent: 최근 쓴 문장. 앱이 이 창 메모리에만 두고, 로그아웃·새로 고침이면 지워져요(R13). 칩의 [×]로 하나씩 지워요.
 */
export function RoomChat({
  auto,
  write,
  initialText = '',
  autoRun = false,
  onMove,
  recent = [],
  onSent,
  onRemoveRecent,
}: {
  auto: boolean;
  write: boolean;
  initialText?: string;
  autoRun?: boolean;
  onMove?: (kind: Kind, text: string) => void;
  recent?: string[];
  onSent?: (text: string) => void;
  onRemoveRecent?: (text: string) => void;
}) {
  const actions = useActions();
  const mode: Mode = !write ? 'read-only' : auto ? 'auto' : 'confirm';
  const [text, setText] = useState(autoRun ? '' : initialText);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [waiting, setWaiting] = useState(false);
  const next = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef<HTMLDivElement>(null);
  const g = guide(mode, text);

  async function send(masked: string, opts: { noAuto?: boolean } = {}) {
    const id = ++next.current;
    setTurns((list) => [...list, { id, text: masked, cards: [] }].slice(-KEEP));
    onSent?.(masked);
    setText('');
    setWaiting(true);
    const done = (patch: Partial<Turn>) => setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    try {
      // 보낼 때마다 새 요청 ID예요. 같은 요청이 두 번 가도 서버가 한 번만 실행해요.
      const res = await apiRequest<RoomChatResponse>('POST', '/api/rooms/chat', {
        text: masked,
        requestId: newRequestId(),
        ...(opts.noAuto ? { noAuto: true } : {}),
      });
      done({ reply: res.reply, cards: res.cards, aiParsed: res.aiParsed });
      if (res.changed) actions.refresh();
    } catch (e) {
      done({ reply: e instanceof ApiFailure ? e.message : '지금 답하지 못했어요. 잠시 뒤에 다시 보내 주세요', failed: true });
    } finally {
      setWaiting(false);
    }
  }

  // 옮겨 온 문장은 한 번만, 자동 실행 없이 보내요. 걸리는 글자가 있으면 보내지 않고 칸에만 둬요(ADR-11).
  // 개발 모드(StrictMode)는 효과를 두 번 돌려서 한 번만 보내게 막아요.
  const handedOff = useRef(false);
  useEffect(() => {
    if (!autoRun || !initialText || handedOff.current) return;
    handedOff.current = true;
    const checked = checkInput(initialText);
    if (checked.locks.length === 0) void send(checked.text, { noAuto: true });
    else setText(initialText);
    // 처음 열릴 때 한 번만 돌아요(페이지는 옮겨 올 때마다 새로 그려져요).
  }, []);

  const latest = turns.at(-1);
  const answered = latest?.reply !== undefined;

  // 새 문장을 보냈을 때와 그 답이 왔을 때, 그 문장이 대화창 위에 오게 넘겨요. 페이지 스크롤은 건드리지 않아요.
  useEffect(() => {
    const log = logRef.current;
    const el = latestRef.current;
    if (log && el) log.scrollTop = el.offsetTop;
  }, [latest?.id, answered]);

  // 지운 칩 옆 칩의 [×]로 초점을 옮겨요. 키보드로 이어서 지울 수 있게 해요.
  function removeRecent(button: HTMLButtonElement, ex: string) {
    const chip = button.parentElement;
    const neighbor = (chip?.nextElementSibling ?? chip?.previousElementSibling)?.querySelector<HTMLButtonElement>('.chip-remove');
    onRemoveRecent?.(ex);
    requestAnimationFrame(() => neighbor?.focus());
  }

  function renderTurn(t: Turn) {
    return (
      <div key={t.id} ref={t.id === latest?.id ? latestRef : undefined} className='room-turn'>
        <p className='chat-bubble mine'>{t.text}</p>
        {t.reply !== undefined && (
          <p className={t.failed ? 'chat-bubble lock-line' : 'chat-bubble'}>
            {t.reply}
            {t.aiParsed && <span className='chat-ai'>AI 해석</span>}
          </p>
        )}
        {t.cards.map((card) => (
          <CardView
            key={card.id}
            card={card}
            onResults={(cards) => setTurns((list) => list.map((x) => (x.id === t.id ? { ...x, cards } : x)))}
            onAction={(action) => {
              // 회의실 일이 아니면(도움말 카드) 같은 문장을 담당 찾기로 옮겨요.
              if (action.type === 'reask') return onMove?.(action.kind, t.text);
              // 끝난 카드는 결과 카드로 바꿔요(예약 → 확정, 취소 → 취소됨). 지난 버튼이 남지 않게 해요(QA D-B01).
              return actions.run(action, card, (cards) =>
                setTurns((list) => list.map((x) => (x.id === t.id ? { ...x, cards: replaceCard(x.cards, card.id, cards) } : x))),
              );
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <section className='room-ask' aria-label='회의실 입력'>
      <CheckedInput
        scope='나만 보여요'
        label='회의실, 무엇을 할까요?'
        placeholder={mode === 'read-only' ? '예) 지금 빈 회의실 있어?' : mode === 'auto' ? '예) 내일 3시 6명 · 내일 3시 6명 잡아 줘' : '예) 내일 3시 6명'}
        submitLabel={g.submit}
        value={text}
        onValueChange={setText}
        onSubmit={(masked) => send(masked)}
      />
      <p className={`mode-line ${g.tone}`} role='status'>
        {g.line}
      </p>
      {/* 최근 쓴 문장이 있으면 그걸, 아직 없으면(처음 쓸 때) 예시 문장을 보여 줘요. 누르면 칸에 채우기만 하고 보내지 않아요. */}
      {recent.length > 0 ? (
        <>
          <p className='example-label'>최근 쓴 문장 · 이 창에서만 기억해요</p>
          <ScrollChips label='최근 쓴 문장'>
            {recent.slice(0, CHIP_MAX).map((ex) => (
              <span key={ex} className='chip removable'>
                <button type='button' className='chip-fill' onClick={() => setText(ex)}>
                  {ex}
                </button>
                {onRemoveRecent && (
                  <button type='button' className='chip-remove' aria-label={`"${ex}" 지우기`} onClick={(e) => removeRecent(e.currentTarget, ex)}>
                    <Icon name='close' size={16} />
                  </button>
                )}
              </span>
            ))}
          </ScrollChips>
        </>
      ) : (
        <>
          <p className='example-label'>이렇게 써 보세요</p>
          <ScrollChips label='예시 문장'>
            {(mode === 'auto' ? AUTO_EXAMPLES : mode === 'confirm' ? CONFIRM_EXAMPLES : READ_ONLY_EXAMPLES).slice(0, CHIP_MAX).map((ex) => (
              <button key={ex} type='button' className='chip' onClick={() => setText(ex)}>
                {ex}
              </button>
            ))}
          </ScrollChips>
        </>
      )}

      {/* 대화가 있을 때만 위아래 구분선과 대화창이 생겨요. 대화를 지우면 구분선도 같이 사라져요. */}
      {latest && (
        <section className='room-results' aria-label='대화'>
          <div className='room-chat-head'>
            <p className='example-label'>대화</p>
            <button type='button' className='link' onClick={() => setTurns([])}>
              대화 지우기
            </button>
          </div>
          {/* 키보드로도 창 안을 스크롤할 수 있게 초점을 받아요. */}
          <div ref={logRef} className='room-log' role='log' aria-label='대화 내용' aria-busy={waiting} tabIndex={0}>
            {turns.map(renderTurn)}
            {waiting && !answered && <div className='skeleton' aria-label='답을 만드는 중' />}
          </div>
        </section>
      )}
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
