import {
  type Card,
  checkInput,
  type Kind,
  type MyLoansResponse,
  type RoomChatPreview,
  type RoomChatResponse,
  roomChatPreview,
  type RoomShowQuery,
} from '@one-line-desk/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { replaceCard, useActions } from '../../components/ActionHost';
import { CardView } from '../../components/CardView';
import { CheckedInput } from '../../components/CheckedInput';
import { Icon } from '../../components/Icon';
import { ScrollChips } from '../../components/ScrollChips';
import { RoomChatContext } from './RoomOverviewCard';
import { useSlow } from '../../components/useSlow';
import { newRequestId, SLOW_MESSAGE } from '../../net';

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
  /** [다시 보내기]도 같은 번호로 보내요. 앞 요청이 늦게라도 실행됐으면 서버가 그 결과를 돌려줘요(10/29 개선 회의 A3). */
  requestId: string;
  noAuto?: boolean;
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
  onShowRooms,
  canEditFacilities = false,
}: {
  auto: boolean;
  write: boolean;
  initialText?: string;
  autoRun?: boolean;
  onMove?: (kind: Kind, text: string) => void;
  recent?: string[];
  onSent?: (text: string) => void;
  onRemoveRecent?: (text: string) => void;
  /**
   * 현황 카드의 [그림으로 모든 회의실 보기]가 아래 회의실 카드를 그 조건으로 펼쳐요(10/30 QA·디자인 회의).
   * 새 문장을 보내거나 대화를 지우거나 페이지를 떠나면 null로 접어요.
   */
  onShowRooms?: (show: RoomShowQuery | null) => void;
  /** 현황 줄을 눌러 연 회의실 자세히에서 설비 상태를 바꿀 수 있는지(총무) */
  canEditFacilities?: boolean;
}) {
  const actions = useActions();
  const mode: Mode = !write ? 'read-only' : auto ? 'auto' : 'confirm';
  const [text, setText] = useState(autoRun ? '' : initialText);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [waiting, setWaiting] = useState(false);
  const slow = useSlow(waiting);
  const next = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const g = guide(mode, text);

  async function send(masked: string, opts: { noAuto?: boolean } = {}) {
    const id = ++next.current;
    // 보낼 때마다 새 요청 ID예요. 같은 요청이 두 번 가도 서버가 한 번만 실행해요.
    const turn: Turn = { id, text: masked, requestId: newRequestId(), noAuto: opts.noAuto, cards: [] };
    setTurns((list) => [...list, turn].slice(-KEEP));
    onSent?.(masked);
    // 새로 물으면 앞서 펼친 그림 카드를 접어요. 지난 조건의 목록이 새 답과 섞여 보이지 않게 해요.
    onShowRooms?.(null);
    setText('');
    await ask(turn);
  }

  async function ask(turn: Turn) {
    setWaiting(true);
    const done = (patch: Partial<Turn>) => setTurns((list) => list.map((t) => (t.id === turn.id ? { ...t, ...patch } : t)));
    try {
      const res = await apiRequest<RoomChatResponse>('POST', '/api/rooms/chat', {
        text: turn.text,
        requestId: turn.requestId,
        ...(turn.noAuto ? { noAuto: true } : {}),
      });
      done({ reply: res.reply, cards: res.cards, aiParsed: res.aiParsed, failed: false });
      if (res.changed) actions.refresh();
    } catch (e) {
      // 보내지 못한 문장은 대화 줄에 남고 [다시 보내기]가 같은 요청 번호로 보내요. 입력 칸에 돌려놓지 않아요:
      // 칸에서 다시 보내면 새 번호라서, 늦게 실행된 앞 요청과 겹쳐 두 번 예약될 수 있어요.
      done({ reply: e instanceof ApiFailure ? e.message : '지금 답하지 못했어요. 잠시 뒤에 다시 보내 주세요', failed: true });
    } finally {
      setWaiting(false);
    }
  }

  // [다시 보내기]: 같은 대화 줄에서 같은 요청 번호로 한 번 더 보내요.
  function resend(turn: Turn) {
    setTurns((list) => list.map((t) => (t.id === turn.id ? { ...t, reply: undefined, failed: false, cards: [] } : t)));
    void ask(turn);
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

  // 대화가 시작되면(10/30 사용자 요청) 페이지 머리를 숨기고, 입력 칸은 아래 탭 바로 위에 떠서 늘 보여요(.room-composer.floating).
  // 대화창은 위 막대부터 떠 있는 입력 칸 위까지 길게 차지해서 입력 칸이 대화를 가리지 않아요. 아래로 내리면 입력 칸은 회의실 목록 위에 떠요.
  // 처음 한 번 대화창을 맨 위로 넘기고, 옮겨 간 입력 칸에 초점을 돌려줘요. 답을 읽던 자리에서 바로 이어 써요.
  const chatting = latest !== undefined;
  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!chatting || !panel) return;
    panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    composerRef.current?.querySelector('input')?.focus({ preventScroll: true });
  }, [chatting]);
  // 떠 있는 입력 칸 높이(가림·잠김 안내가 붙으면 늘어요)를 재서 대화창 높이와 페이지 아래 여백에 써요(--composer-h).
  useEffect(() => {
    const bar = composerRef.current;
    if (!chatting || !bar) return;
    const root = document.documentElement.style;
    const observer = new ResizeObserver(() => root.setProperty('--composer-h', `${Math.ceil(bar.getBoundingClientRect().height)}px`));
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.removeProperty('--composer-h');
    };
  }, [chatting]);
  // 페이지를 떠나면 펼친 회의실 카드를 접어요. 다시 오면 대화가 비어 있어서요.
  useEffect(() => () => onShowRooms?.(null), []);

  function clearChat() {
    setTurns([]);
    onShowRooms?.(null);
  }

  // 현황 카드의 [그림으로 모든 회의실 보기]·회의실 자세히가 쓰는 값(RoomOverviewCard)
  const chatContext = useMemo(() => ({ showRooms: (show: RoomShowQuery) => onShowRooms?.(show), canEditFacilities }), [onShowRooms, canEditFacilities]);

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
        {t.failed && !waiting && (
          <button type='button' className='secondary small' onClick={() => resend(t)}>
            다시 보내기
          </button>
        )}
        {t.reply === undefined && <div className='skeleton' aria-label='답을 만드는 중' />}
        {t.reply === undefined && slow && <p className='hint'>{SLOW_MESSAGE}</p>}
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

  const input = (
    <CheckedInput
      scope='나만 보여요'
      label='회의실, 무엇을 할까요?'
      placeholder={mode === 'read-only' ? '예) 지금 빈 회의실 있어?' : mode === 'auto' ? '예) 내일 3시 6명 · 내일 3시 6명 잡아 줘' : '예) 내일 3시 6명'}
      submitLabel={g.submit}
      value={text}
      onValueChange={setText}
      onSubmit={(masked) => send(masked)}
    />
  );
  const modeLine = (
    <p className={`mode-line ${g.tone}`} role='status'>
      {g.line}
    </p>
  );
  // 최근 쓴 문장이 있으면 그걸, 아직 없으면(처음 쓸 때) 예시 문장을 보여 줘요. 누르면 칸에 채우기만 하고 보내지 않아요.
  const chips =
    recent.length > 0 ? (
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
    );

  // 대화 전: 입력 칸 → 지금 동작 한 줄 → 문장 칩.
  if (!chatting) {
    return (
      <section className='room-ask' aria-label='회의실 입력'>
        {input}
        {modeLine}
        {chips}
      </section>
    );
  }

  // 대화 중: 대화창(대화만, 길게)과 아래 탭 위에 떠 있는 입력 칸(지금 동작 한 줄 → 입력 칸)이에요. 문장 칩은 대화창을 넓히려고 숨기고,
  // 대화를 지우면 입력 칸이 맨 위로 돌아오면서 다시 보여요. 대화가 길면 대화 줄만 창 안에서 스크롤돼요.
  return (
    <section className='room-ask' aria-label='회의실 입력'>
      <section ref={panelRef} className='room-results chatting' aria-label='대화'>
        <div className='room-chat-head'>
          <p className='example-label'>대화</p>
          <button type='button' className='link' onClick={clearChat}>
            대화 지우기
          </button>
        </div>
        {/* 키보드로도 창 안을 스크롤할 수 있게 초점을 받아요. */}
        <div ref={logRef} className='room-log' role='log' aria-label='대화 내용' aria-busy={waiting} tabIndex={0}>
          <RoomChatContext.Provider value={chatContext}>{turns.map(renderTurn)}</RoomChatContext.Provider>
        </div>
      </section>
      <div ref={composerRef} className='room-composer floating'>
        {modeLine}
        {input}
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
