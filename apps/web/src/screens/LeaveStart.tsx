import { type Card, type CardAction, LEAVE_IN_APP_DEV_TEXT, type LeaveStartResponse } from '@one-line-desk/shared';
import { useState } from 'react';
import { ApiFailure, apiRequest } from '../api';
import { useActions } from '../components/ActionHost';
import { CardView } from '../components/CardView';
import { webModules } from '../modules/registry';

// 휴가 신청 바로 가기(11/5, 처음 쓰는 직원 점검: "휴가 신청 버튼이 앞에 보였으면 했어요").
// 누르면 서버가 본인 휴가 신청 양식(날 없이)을 주고, 여기서 양식을 열어요. 보내기는 양식의 확인 시트예요(ADR-24).
// 남은 연차는 누를 때 서버가 계산하고 저장하지 않아요(ADR-18).
// 11/6 A안(그룹웨어로 넘기기, 운영 기본): 서버가 양식 대신 신청 전 카드(남은 연차·[그룹웨어에서 신청하기])를 주면 그 카드를 펼쳐요.
// 신청·결재는 회사 그룹웨어가 해요. inApp은 공개 설정의 leaveInApp이에요(안내 글만 바꿔요, 무엇을 줄지는 서버가 정해요).

const NOT_READY = '지금은 이 앱에서 휴가를 신청할 수 없어요. 그룹웨어에서 신청해 주세요';

export function LeaveStart({ variant = 'button', inApp = true }: { variant?: 'button' | 'card'; inApp?: boolean }) {
  const { LeaveRequestSheet } = webModules;
  const actions = useActions();
  const [action, setAction] = useState<Extract<CardAction, { type: 'leave-request' }> | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiRequest<LeaveStartResponse>('GET', '/api/navi/leave/start');
      if (res.card) setCard(res.card);
      else if (res.action) setAction(res.action);
      else setMessage(NOT_READY);
    } catch (e) {
      setMessage(e instanceof ApiFailure ? e.message : NOT_READY);
    } finally {
      setBusy(false);
    }
  }

  const button = (
    <button type='button' className={variant === 'card' ? 'primary' : 'secondary'} disabled={busy} onClick={() => void open()}>
      {busy ? '여는 중' : '휴가 신청하기'}
    </button>
  );
  return (
    <>
      {variant === 'card' ? (
        <section className='card leave-start' aria-label='휴가 신청'>
          <h2>휴가 신청</h2>
          <p className='hint'>
            {inApp
              ? `연차·반차·공가·병가를 인사팀에 보내요. 남은 연차는 열 때 계산하고 저장하지 않아요. ${LEAVE_IN_APP_DEV_TEXT}.`
              : '신청·결재는 그룹웨어에서 해요. 누르면 남은 연차와 신청할 곳을 보여 줘요. 남은 연차는 저장하지 않아요.'}
          </p>
          {button}
        </section>
      ) : (
        button
      )}
      {message && <p className='lock-line'>{message}</p>}
      {card && <CardView card={card} onAction={(a, c) => actions.run(a, c, (next) => setCard(next[0] ?? null))} />}
      {action && <LeaveRequestSheet action={action} onClose={() => setAction(null)} />}
    </>
  );
}
