import { type CardAction, INVITE_MAX, type PeopleSearchResponse, type PersonHit } from '@one-line-desk/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiRequest } from '../../api';
import { useActions } from '../../components/ActionHost';
import { Sheet } from '../../components/Sheet';
import { newRequestId } from '../../net';

// 회의 참석자 고르기(10/26, ADR-17). 직원 이름·부서로 찾아 고르고, 알릴 길(앱 알림은 늘 · 그룹웨어 캘린더 · Slack DM)을 정해요.
// [알리기] → 확인 시트 → 보내요. 고른 사람만 회의실·시간·내 이름을 봐요. LLM은 쓰지 않아요.

type Invite = Extract<CardAction, { type: 'invite' }>;

export function InviteSheet({ action, onClose }: { action: Invite; onClose: () => void }) {
  const actions = useActions();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PersonHit[]>([]);
  const [chosen, setChosen] = useState<PersonHit[]>([]);
  const [channels, setChannels] = useState<{ calendar: string | null; slack: string | null }>({ calendar: null, slack: null });
  const [calendar, setCalendar] = useState(true);
  const [slack, setSlack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 같은 양식에서 두 번 눌러도 한 번만 보내요(서버 멱등 키).
  const requestId = useMemo(() => newRequestId(), []);

  useEffect(() => {
    void api.publicConfig().then((c) => setChannels(c.inviteChannels));
  }, []);

  // 글자를 멈추고 잠깐 뒤에 찾아요. 검색어는 주소가 아니라 본문으로 보내요.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    const id = window.setTimeout(() => {
      apiRequest<PeopleSearchResponse>('POST', '/api/people/search', { query: q })
        .then((res) => {
          setHits(res.items);
          setError(null);
        })
        .catch(() => setError('지금 직원을 찾지 못했어요'));
    }, 250);
    return () => window.clearTimeout(id);
  }, [query]);

  // 보내기가 끝나면(내 쓰기 횟수가 오르면) 양식을 닫아요. 새 알림이 와도 고른 사람은 그대로예요.
  const startWrites = useRef(actions.writes);
  useEffect(() => {
    if (actions.writes !== startWrites.current) onClose();
  }, [actions.writes, onClose]);

  const picked = new Set(chosen.map((p) => p.ref));
  const full = chosen.length >= INVITE_MAX;

  function send() {
    if (!chosen.length) return;
    const lines = [
      `${action.roomName} · ${action.when}`,
      `${chosen.map((p) => p.name).join(', ')}`,
      '고른 사람만 회의실·시간·내 이름을 봐요. 다른 직원에게는 "예약됨"만 보여요',
      ...(calendar && channels.calendar ? [`${channels.calendar}로 초대가 가요`] : []),
      ...(slack && channels.slack ? [`${channels.slack} DM이 가요. 글은 Slack 보관 설정을 따라요`] : []),
    ];
    void actions.run({
      type: 'fixed',
      text: '알리기',
      method: 'POST',
      path: `/api/rooms/reservations/${action.reservationId}/invites`,
      body: { people: chosen.map((p) => p.ref), calendar: calendar && Boolean(channels.calendar), slack: slack && Boolean(channels.slack), requestId },
      confirm: { title: `${chosen.length}명에게 알릴까요?`, lines, confirmLabel: '알리기', note: '앱 안 알림은 늘 가요' },
    });
  }

  return (
    <Sheet title='참석자 초대' onClose={onClose}>
      <p className='inquiry-scope'>
        {action.roomName} · {action.when}
      </p>
      <label className='inquiry-field'>
        <span className='inquiry-label'>
          이름이나 부서로 찾기
          <small>
            {chosen.length} / {INVITE_MAX}명
          </small>
        </span>
        <input
          className='text-input'
          value={query}
          maxLength={30}
          placeholder='예) 서준, 개발팀'
          autoComplete='off'
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error && <p className='lock-line'>{error}</p>}
      {hits.length > 0 && (
        <ul className='people-list'>
          {hits.map((p) => (
            <li key={p.ref}>
              <span className='avatar small' aria-hidden='true'>
                {p.name.split(' ').at(-1)?.charAt(0)}
              </span>
              <span className='choice-text'>
                <strong>{p.name}</strong>
                <span>
                  {p.department} · {p.floor}
                </span>
              </span>
              <button type='button' className='secondary small' disabled={picked.has(p.ref) || full} onClick={() => setChosen((list) => [...list, p])}>
                {picked.has(p.ref) ? '골랐어요' : '추가'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.trim() && hits.length === 0 && !error && <p className='empty'>맞는 직원이 없어요. 이름 일부나 부서로 찾아보세요.</p>}

      {chosen.length > 0 && (
        <div className='chips' aria-label='고른 사람'>
          {chosen.map((p) => (
            <button key={p.ref} type='button' className='chip selected' onClick={() => setChosen((list) => list.filter((x) => x.ref !== p.ref))}>
              {p.name} ✕
            </button>
          ))}
        </div>
      )}

      <fieldset className='channel-list'>
        <legend>알릴 길</legend>
        <label>
          <input type='checkbox' checked disabled /> 앱 안 알림(늘 가요)
        </label>
        <label className={channels.calendar ? '' : 'off'}>
          <input
            type='checkbox'
            checked={calendar && Boolean(channels.calendar)}
            disabled={!channels.calendar}
            onChange={(e) => setCalendar(e.target.checked)}
          />{' '}
          {channels.calendar ?? '그룹웨어 캘린더'} 초대
        </label>
        <label className={channels.slack ? '' : 'off'}>
          <input type='checkbox' checked={slack && Boolean(channels.slack)} disabled={!channels.slack} onChange={(e) => setSlack(e.target.checked)} />{' '}
          {channels.slack ?? 'Slack'} DM
        </label>
      </fieldset>
      <p className='hint'>캘린더 파일(.ics)은 보낸 뒤 결과 카드나 내 예약에서 받을 수 있어요.</p>

      <button type='button' className='primary' disabled={!chosen.length} onClick={send}>
        {chosen.length ? `${chosen.length}명에게 알리기` : '참석자를 골라 주세요'}
      </button>
    </Sheet>
  );
}
