import {
  checkInput,
  type DemoInboxResponse,
  INVITE_REASON_MAX,
  INVITE_RESPONSE_LABEL,
  type InviteColleaguesResponse,
  type InvitedMeeting,
  type InvitedMeetingsResponse,
  maskLine,
} from '@one-line-desk/shared';
import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../api';
import { useActions, useListVersion } from '../../components/ActionHost';
import { newRequestId } from '../../net';

// 나를 부른 회의(10/26, ADR-17). 초대받은 사람만 회의실·시간·부른 사람을 봐요. [참석할게요]·[못 가요]·캘린더 파일.
// 11/4: [못 가요]는 사유를 꼭 적고, 같은 팀 다른 사람에게 대신 가 달라고 부탁할 수 있어요. 사유는 부른 사람(과 부탁받은 사람)에게만 보여요.

export function InvitedMeetings() {
  const { run } = useActions();
  const { version, background } = useListVersion();
  const [data, setData] = useState<InvitedMeetingsResponse | null>(null);

  useEffect(() => {
    let alive = true;
    apiRequest<InvitedMeetingsResponse>('GET', '/api/rooms/invites', undefined, { background: background() })
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
              {m.delegatedBy && (
                <p className='hint'>
                  {m.delegatedBy.name}님이 대신 가 달라고 했어요: {m.delegatedBy.reason}
                </p>
              )}
              <span className={`inquiry-state ${m.response === 'accepted' ? 'done' : m.response === 'declined' ? '' : 'seen'}`}>
                {INVITE_RESPONSE_LABEL[m.response]}
              </span>
              {m.declineReason && <p className='hint'>내가 적은 사유: {m.declineReason}</p>}
            </div>
            <div className='row-actions'>
              {m.actions.map((a) => (
                <button key={a.text} type='button' className='secondary small' onClick={() => void run(a)}>
                  {a.text}
                </button>
              ))}
              {m.canDecline && <DeclineButton meeting={m} />}
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

/** [못 가요]: 사유(꼭) + 같은 팀 사람에게 대신 부탁(고르면). [보내기] → 확인 → 보내요. */
function DeclineButton({ meeting }: { meeting: InvitedMeeting }) {
  const { run } = useActions();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [delegating, setDelegating] = useState(false);
  const [colleagues, setColleagues] = useState<InviteColleaguesResponse['items'] | null>(null);
  const [delegate, setDelegate] = useState('');
  const requestId = useMemo(() => newRequestId(), []);
  const checked = useMemo(() => checkInput(reason), [reason]);
  const line = maskLine(checked);

  useEffect(() => {
    if (!delegating || colleagues) return;
    let alive = true;
    apiRequest<InviteColleaguesResponse>('GET', `/api/rooms/invites/${meeting.reservationId}/colleagues`)
      .then((d) => alive && setColleagues(d.items))
      .catch(() => alive && setColleagues([]));
    return () => {
      alive = false;
    };
  }, [delegating, colleagues, meeting.reservationId]);

  if (!open)
    return (
      <button type='button' className='neutral small' onClick={() => setOpen(true)}>
        못 가요
      </button>
    );

  const who = colleagues?.find((c) => c.ref === delegate)?.name;
  const ready = reason.trim().length > 0 && checked.locks.length === 0 && (!delegating || Boolean(delegate));

  function send() {
    if (!ready) return;
    void run({
      type: 'fixed',
      text: who ? '대신 부탁하기' : '못 간다고 보내기',
      method: 'POST',
      path: `/api/rooms/invites/${meeting.reservationId}/decline`,
      body: { reason: reason.trim(), ...(delegating && delegate ? { delegate } : {}), requestId },
      confirm: {
        title: who ? `${who}님에게 대신 가 달라고 부탁할까요?` : '못 간다고 보낼까요?',
        lines: [
          `${meeting.roomName} · ${meeting.when}`,
          `사유: ${reason.trim()}`,
          who ? `사유는 ${meeting.inviter.name}님과 ${who}님에게만 보여요` : `사유는 ${meeting.inviter.name}님에게만 보여요`,
          // 11/5: 부탁받은 사람에게는 앱 알림과 Slack DM(연결돼 있을 때)이 가요. Slack 글에 사유는 넣지 않아요.
          ...(who ? [`${who}님에게 앱 알림이 가고, Slack이 연결돼 있으면 DM도 가요(사유는 넣지 않아요)`] : []),
        ],
        confirmLabel: '보내기',
      },
    });
  }

  return (
    <div className='decline-form'>
      <label className='inquiry-field'>
        <span className='inquiry-label'>
          <span>
            못 가는 사유<em className='required'> 꼭 적어 주세요</em>
          </span>
          <small>
            {reason.length} / {INVITE_REASON_MAX}
          </small>
        </span>
        <textarea
          value={reason}
          maxLength={INVITE_REASON_MAX}
          rows={2}
          placeholder='예) 같은 시간에 고객 미팅이 있어요'
          autoComplete='off'
          onChange={(e) => setReason(e.target.value)}
        />
        {checked.locks.map((l) => (
          <span key={l.kind} className='lock-line'>
            {l.message}
          </span>
        ))}
        {line && <span className='hint'>{line}</span>}
      </label>
      <label className='decline-delegate'>
        <input type='checkbox' checked={delegating} onChange={(e) => setDelegating(e.target.checked)} /> 우리 팀 다른 사람에게 대신 부탁하기
      </label>
      {delegating && (
        <label className='inquiry-field'>
          <span className='inquiry-label'>대신 갈 사람</span>
          <select className='text-input' value={delegate} onChange={(e) => setDelegate(e.target.value)} aria-label='대신 갈 사람'>
            <option value=''>{colleagues === null ? '불러오는 중' : colleagues.length ? '골라 주세요' : '부탁할 수 있는 사람이 없어요'}</option>
            {(colleagues ?? []).map((c) => (
              <option key={c.ref} value={c.ref}>
                {c.name}
              </option>
            ))}
          </select>
          {meeting.delegatedBy && <span className='hint'>나에게 부탁한 {meeting.delegatedBy.name}님에게는 다시 부탁할 수 없어요</span>}
        </label>
      )}
      <div className='actions'>
        <button type='button' className='primary small' disabled={!ready} onClick={send}>
          {delegating ? '대신 부탁하기' : '못 간다고 보내기'}
        </button>
        <button type='button' className='neutral small' onClick={() => setOpen(false)}>
          그만두기
        </button>
      </div>
    </div>
  );
}

/** 시연 받은편지함: 모의 그룹웨어 캘린더·모의 Slack이 나에게 보낸 것. 실제 어댑터면 숨겨요. */
export function DemoInbox() {
  const { version, background } = useListVersion();
  const [data, setData] = useState<DemoInboxResponse | null>(null);

  useEffect(() => {
    let alive = true;
    apiRequest<DemoInboxResponse>('GET', '/api/demo/inbox', undefined, { background: background() })
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
