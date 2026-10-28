import { type DemoInboxResponse, INVITE_RESPONSE_LABEL, type InvitedMeetingsResponse } from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { apiRequest } from '../../api';
import { useActions } from '../../components/ActionHost';

// 나를 부른 회의(10/26, ADR-17). 초대받은 사람만 회의실·시간·부른 사람을 봐요. [참석할게요]·[못 가요]·캘린더 파일.

export function InvitedMeetings() {
  const { run, version } = useActions();
  const [data, setData] = useState<InvitedMeetingsResponse | null>(null);

  useEffect(() => {
    let alive = true;
    apiRequest<InvitedMeetingsResponse>('GET', '/api/rooms/invites')
      .then((d) => alive && setData(d))
      .catch(() => alive && setData({ enabled: false, items: [] }));
    return () => {
      alive = false;
    };
  }, [version]);

  if (!data?.enabled || data.items.length === 0) return null;
  return (
    <section className='card' aria-label='나를 부른 회의'>
      <h2>나를 부른 회의</h2>
      <ul className='plain my-reservations'>
        {data.items.map((m) => (
          <li key={m.reservationId} className='invited'>
            <div>
              <p>
                <strong>{m.roomName}</strong> · {m.floor}
              </p>
              <p className='hint'>
                {m.when} · {m.inviter.name}({m.inviter.department})님이 불렀어요
              </p>
              <span className={`inquiry-state ${m.response === 'accepted' ? 'done' : m.response === 'declined' ? '' : 'seen'}`}>
                {INVITE_RESPONSE_LABEL[m.response]}
              </span>
            </div>
            <div className='row-actions'>
              {m.actions.map((a) => (
                <button key={a.text} type='button' className='secondary small' onClick={() => void run(a)}>
                  {a.text}
                </button>
              ))}
              <a className='neutral small' href={m.icsPath} download>
                캘린더 파일
              </a>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 시연 받은편지함: 모의 그룹웨어 캘린더·모의 Slack이 나에게 보낸 것. 실제 어댑터면 숨겨요. */
export function DemoInbox() {
  const { version } = useActions();
  const [data, setData] = useState<DemoInboxResponse | null>(null);

  useEffect(() => {
    let alive = true;
    apiRequest<DemoInboxResponse>('GET', '/api/demo/inbox')
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [version]);

  if (!data?.enabled) return null;
  return (
    <section className='card' aria-label='시연 받은편지함'>
      <h2>시연 받은편지함</h2>
      <p className='hint'>실제 그룹웨어·Slack 대신, 이 앱이 나에게 보낸 것을 여기서 보여 줘요(모의).</p>
      <h3>그룹웨어 캘린더(모의)</h3>
      {data.calendar.length === 0 ? (
        <p className='empty'>받은 일정이 없어요.</p>
      ) : (
        <ul className='plain notification-list'>
          {data.calendar.map((e) => (
            <li key={e.uid}>
              <p>
                <strong>{e.title}</strong> {e.cancelled && <span className='inquiry-state'>취소됨</span>}
              </p>
              <p className='hint'>
                {e.when} · {e.location}
              </p>
            </li>
          ))}
        </ul>
      )}
      <h3>Slack DM(모의)</h3>
      {data.messages.length === 0 ? (
        <p className='empty'>받은 DM이 없어요.</p>
      ) : (
        <ul className='plain notification-list'>
          {data.messages.map((m) => (
            <li key={m.id}>
              <p>{m.text}</p>
              <p className='hint'>{m.sentAt}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
