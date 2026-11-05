// 홈 AI 채팅 "나에게 해당하는 일"(11/3 사용자 결정, ADR-27, 개선 회의 D8 해제).
// - 묻는 글은 공통 입력 검사·가림 줄을 지난 뒤 POST 본문으로만 보내요. 대화는 이 창 메모리에만 있어요(R13).
// - 홈 칸은 예약·신청을 하지 않아요. 다른 일이면 옮기기 카드를 누를 때 같은 문장을 그 페이지 칸에 채우기만 해요(바로 보내지 않아요).
// - 11/4 사용자 결정: "오늘·이번 주 내 일"·"내 요청" 카드는 없애고(채팅과 겹쳐서), 그 내용은 예시 칩 "내가 보낸 요청"·"나한테 온 요청"으로 물어요.
// - 11/3 사용자 요청: 예시 칩은 PC에서도 휠·끌기로 옆으로 넘겨요(ScrollChips). 대화는 입력 칸과 구분되는 "대화" 칸 안에
//   오래된 것부터 쌓고, 길어지면 칸 높이는 그대로 두고 칸 안에서 스크롤해요. 새 질문이 오면 그 질문이 칸 위에 오게 넘겨요.
// - 11/5 사용자 결정: 마이 페이지의 내 예약·내 요청·나에게 온 요청·자리비움 알리기를 홈으로 옮겼어요. 가장 최근 답에서 항목 버튼이
//   그 칸을 답 아래에 펼치고, 자리비움 문장이면 미리 채운 양식을 펼쳐요. 마이 페이지 안내 버튼은 정해진 문장으로 바로 찾아요(읽기만).
// - 11/5 사용자 결정(개선 2·3·4): 담당 찾기·공지·빈 회의실 답은 홈 답에 그 카드 그대로 보여 줘요. 담당 카드의 [○○에 문의하기]·
//   [휴가 신청하기]는 여기서 양식을 열어요(보내기는 그 양식의 확인). 새 예약은 회의실 탭에서만 해요(후보 버튼이 회의실 탭으로 옮겨요).
//   처음 온 사람도 눌러 볼 일("해 볼 수 있는 일") 칩을 같이 두고, 내 일이 없다는 답 아래에도 보여 줘요.
import {
  type AppDestination,
  type Card,
  type CardAction,
  checkInput,
  HOME_ASK_NOTE,
  type HomeOpen,
  type ModuleKind,
  type ModuleSwitch,
} from '@one-line-desk/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useActions } from '../components/ActionHost';
import { CardView } from '../components/CardView';
import { CheckedInput } from '../components/CheckedInput';
import { ScrollChips } from '../components/ScrollChips';
import { useSlow } from '../components/useSlow';
import { OFFLINE_MESSAGE, SLOW_MESSAGE } from '../net';
import { webModules } from '../modules/registry';
import { pageOfKind } from './features';
import { HomeAnswer, type HomePanel, type HomeTurn, pushTurn } from './HomeAnswer';
import { inquireFirst } from './inquire-first';

const MINE_EXAMPLES = ['내가 보낸 요청 어떻게 됐어?', '나한테 온 요청 있어?', '내 휴가 어떻게 됐어?'];
/** 처음 온 사람도 눌러 볼 수 있는 일(11/5, 빈 홈 채우기). 홈에서 답이 바로 나와요. 꺼진 기능은 빼요. */
const TRY_EXAMPLES: { text: string; module: ModuleKind }[] = [
  { text: '법인카드 잃어버리면 어디에 말해요?', module: 'navi' },
  { text: '지금 빈 회의실 있어?', module: 'rooms' },
  { text: '연말정산 공지 찾아 줘', module: 'notices' },
  { text: '신입인데 첫 주에 뭐 해야 해?', module: 'navi' },
];
/** 같은 팀 일정이 켜져 있을 때만 더해요(11/3). 자리비움 알리기도 그때만 열려요(11/5 홈으로 옮김). */
const TEAM_EXAMPLES = ['오늘 우리 팀 누가 없어?', '내일 오후 외근이에요'];

/** 답 아래에 펼칠 칸: 마이 페이지에 있던 그 모듈 부품을 그대로 써요(11/5). */
function panel(p: HomePanel) {
  const { MyReservations, MyLoans, InvitedMeetings, JointRequests, MyInquiries, InquiryInbox, MyRequests } = webModules;
  switch (p) {
    case 'reservations':
      return <MyReservations />;
    case 'loans':
      return <MyLoans />;
    case 'invites':
      return (
        <>
          <JointRequests />
          <InvitedMeetings />
        </>
      );
    case 'inquiries':
      return <MyInquiries />;
    case 'inbox':
      return <InquiryInbox />;
    case 'pantry':
      return <MyRequests />;
  }
}

type Open = (page: AppDestination, text?: string, auto?: boolean) => void;

export function HomeAsk({
  onOpen,
  teamSchedule = false,
  modules,
  initialText = '',
  autoRun = false,
}: {
  onOpen: Open;
  teamSchedule?: boolean;
  /** 켜진 기능(해 볼 수 있는 일 칩을 거르는 데 써요) */
  modules?: Record<ModuleKind, ModuleSwitch>;
  /** 마이 페이지 안내 버튼이 넘긴 정해진 문장(11/5). autoRun이면 바로 찾아요(읽기만). */
  initialText?: string;
  autoRun?: boolean;
}) {
  const actions = useActions();
  const [text, setText] = useState(autoRun ? '' : initialText);
  const { InquirySheet, LeaveRequestSheet } = webModules;
  const [inquiry, setInquiry] = useState<{ action: Extract<CardAction, { type: 'inquire' }>; question: string } | null>(null);
  const [leaveRequest, setLeaveRequest] = useState<Extract<CardAction, { type: 'leave-request' }> | null>(null);
  const tries = TRY_EXAMPLES.filter((t) => !modules || modules[t.module] !== 'off').map((t) => t.text);
  const examples = ['이번 주 내 일정 뭐 있어?', ...tries, ...MINE_EXAMPLES, ...(teamSchedule ? TEAM_EXAMPLES : [])];
  const [turns, setTurns] = useState<HomeTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const slow = useSlow(loading);
  const seq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef<HTMLDivElement>(null);
  // 보관은 새것부터(pushTurn), 그리기는 오래된 것부터예요.
  const shown = [...turns].reverse();
  const latestId = turns[0]?.id;

  // 새 질문의 답이 오면 그 질문이 대화 칸 위에 오게 넘겨요. 답이 길어도 질문부터 읽어요. 페이지 스크롤은 건드리지 않아요.
  useEffect(() => {
    const log = logRef.current;
    const el = latestRef.current;
    if (log && el) log.scrollTop = el.offsetTop - log.offsetTop;
  }, [latestId]);
  // 찾는 중 표시는 칸 맨 아래에 나와서, 찾기 시작하면 맨 아래로 넘겨요.
  useEffect(() => {
    const log = logRef.current;
    if (loading && log) log.scrollTop = log.scrollHeight;
  }, [loading]);

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

  // 마이 페이지에서 넘어온 문장은 정해진 문장이지만 공통 검사를 한 번 더 지나고 보내요(ADR-11). 처음 열릴 때 한 번만이에요.
  const autoSent = useRef(false);
  useEffect(() => {
    if (!autoRun || !initialText || autoSent.current) return;
    autoSent.current = true;
    const checked = checkInput(initialText);
    if (checked.locks.length === 0) void ask(checked.text);
  }, []);

  /**
   * 옮기기 카드: 같은 문장을 그 페이지 칸에 채워요. 바로 보내지 않아서 그 페이지에서 사람이 다시 눌러야 해요(D8 noAuto).
   * 담당 카드의 문의·휴가 신청은 여기서 양식을 열고(보내기는 양식의 확인), 그 밖의 버튼은 공통 처리(ActionHost)로 가요.
   */
  function onCardAction(action: CardAction, card: Card, turnText: string) {
    if (action.type === 'reask') return onOpen(pageOfKind(action.kind), turnText, false);
    if (action.type === 'navigate') return onOpen(action.to);
    if (action.type === 'inquire') return setInquiry({ action, question: turnText });
    if (action.type === 'leave-request') return setLeaveRequest(action);
    return actions.run(action, card);
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
        <ScrollChips label='예시 문장'>
          {examples.map((ex) => (
            <button key={ex} type='button' className='chip' onClick={() => setText(ex)}>
              {ex}
            </button>
          ))}
        </ScrollChips>
      </section>

      {(loading || turns.length > 0) && (
        <section className='home-chat' aria-label='대화'>
          <h2 className='home-chat-title'>대화</h2>
          <div ref={logRef} className='home-turns' role='log' aria-label='대화 내용' aria-live='polite' aria-busy={loading} tabIndex={0}>
            {shown.map((turn) => (
              <div key={turn.id} ref={turn.id === latestId ? latestRef : undefined} className='room-turn'>
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
                      <CardView key={card.id} card={inquireFirst(card)} onAction={(action, shown) => onCardAction(action, shown, turn.text)} />
                    ))}
                    // 펼치는 칸·자리비움 양식은 가장 최근 답에만 붙여요(같은 칸이 여러 번 열리지 않게).
                    panelFor={turn.id === latestId ? panel : undefined}
                    // 내 일이 없다는 답이면 처음 온 사람도 해 볼 수 있는 일을 보여 줘요(누르면 칸에 채우기만 해요).
                    emptyHint={
                      turn.id === latestId && tries.length > 0 ? (
                        <div className='home-try'>
                          <p className='hint'>이런 것도 물어볼 수 있어요</p>
                          <div className='home-try-chips'>
                            {tries.slice(0, 3).map((t) => (
                              <button key={t} type='button' className='chip' onClick={() => setText(t)}>
                                {t}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : undefined
                    }
                    away={
                      turn.id === latestId && turn.answer.cards.some((c) => c.id === 'home-move-away') ? (
                        <webModules.MyAway initial={turn.answer.away} />
                      ) : undefined
                    }
                  />
                )}
              </div>
            ))}
            {loading && <div className='skeleton' aria-label='찾는 중' />}
            {loading && slow && <p className='hint'>{SLOW_MESSAGE}</p>}
          </div>
        </section>
      )}

      {inquiry && <InquirySheet action={inquiry.action} initialQuestion={inquiry.question} onClose={() => setInquiry(null)} />}
      {leaveRequest && <LeaveRequestSheet action={leaveRequest} onClose={() => setLeaveRequest(null)} />}
    </>
  );
}
