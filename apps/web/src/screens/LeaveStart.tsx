import type { CardAction, LeaveStartResponse } from '@one-line-desk/shared';
import { useState } from 'react';
import { ApiFailure, apiRequest } from '../api';
import { webModules } from '../modules/registry';

// 휴가 신청 바로 가기(11/5, 처음 쓰는 직원 점검: "휴가 신청 버튼이 앞에 보였으면 했어요").
// 누르면 서버가 본인 휴가 신청 양식(날 없이)을 주고, 여기서 양식을 열어요. 보내기는 양식의 확인 시트예요(ADR-24).
// 남은 연차는 누를 때 서버가 계산하고 저장하지 않아요(ADR-18).

const NOT_READY = '지금은 이 앱에서 휴가를 신청할 수 없어요. 그룹웨어에서 신청해 주세요';

export function LeaveStart({ variant = 'button' }: { variant?: 'button' | 'card' }) {
  const { LeaveRequestSheet } = webModules;
  const [action, setAction] = useState<Extract<CardAction, { type: 'leave-request' }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiRequest<LeaveStartResponse>('GET', '/api/navi/leave/start');
      if (res.action) setAction(res.action);
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
          <p className='hint'>연차·반차·공가·병가를 인사팀에 보내요. 남은 연차는 열 때 계산하고 저장하지 않아요.</p>
          {button}
        </section>
      ) : (
        button
      )}
      {message && <p className='lock-line'>{message}</p>}
      {action && <LeaveRequestSheet action={action} onClose={() => setAction(null)} />}
    </>
  );
}
