import {
  type JointPickRequest,
  type JointRequestsResponse,
  type PeopleSearchResponse,
  type PersonHit,
  TEAM_DELEGATE_MAX,
  type TeamDelegatesResponse,
} from '@one-line-desk/shared';
import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../api';
import { useActions, useListVersion } from '../../components/ActionHost';
import { newRequestId } from '../../net';

// 여러 팀 회의(11/4 사용자 결정, ADR-28). 마이 페이지 두 칸이에요.
// - "회의 참석자 골라 주세요": 우리 팀 팀장·회의 담당자에게만 보여요. 같은 팀 사람을 골라 [보내기] → 확인 → 고른 사람에게 초대가 가요.
// - "팀 회의 담당자": 팀장에게만 보여요. 팀장 대신 참석자를 고를 같은 팀 사람을 순서대로 2명까지 정해요.

/** 참석자 고르기 요청 목록. 없으면 칸을 숨겨요. */
export function JointRequests() {
  const { version, background } = useListVersion();
  const [items, setItems] = useState<JointPickRequest[]>([]);

  useEffect(() => {
    let alive = true;
    apiRequest<JointRequestsResponse>('GET', '/api/rooms/joint/requests', undefined, { background: background() })
      .then((d) => alive && setItems(d.items))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [version]);

  if (!items.length) return null;
  return (
    <section className='card' aria-label='회의 참석자 골라 주세요'>
      <h2>회의 참석자 골라 주세요</h2>
      <p className='hint'>우리 팀에서 갈 사람을 골라요. 먼저 고른 팀장·담당자의 선택으로 초대가 가요.</p>
      {items.map((r) => (
        <PickOne key={r.id} request={r} />
      ))}
    </section>
  );
}

function PickOne({ request }: { request: JointPickRequest }) {
  const { run } = useActions();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const requestId = useMemo(() => newRequestId(), []);
  const names = request.members.filter((m) => chosen.has(m.ref)).map((m) => m.name);

  function send() {
    void run({
      type: 'fixed',
      text: '보내기',
      method: 'POST',
      path: `/api/rooms/joint/requests/${request.id}/pick`,
      body: { people: [...chosen], requestId },
      confirm: {
        title: names.length ? `${names.length}명에게 초대를 보낼까요?` : '우리 팀은 안 간다고 보낼까요?',
        lines: [
          `${request.room} · ${request.when}`,
          names.length ? names.join(', ') : '우리 팀에서는 아무도 가지 않아요',
          `고른 사람에게 ${request.requester}님이 부른 회의로 초대가 가요`,
        ],
        confirmLabel: '보내기',
      },
    });
  }

  return (
    <div className='joint-request'>
      <p>
        <strong>{request.room}</strong> · {request.when}
      </p>
      <p className='hint'>
        {request.requester}님이 불렀어요 · 짐작한 우리 팀 인원 {request.estimate}명
      </p>
      <ul className='plain joint-members' aria-label={`${request.department} 사람`}>
        {request.members.map((m) => (
          <li key={m.ref}>
            <label>
              <input
                type='checkbox'
                checked={chosen.has(m.ref)}
                onChange={(e) =>
                  setChosen((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(m.ref);
                    else next.delete(m.ref);
                    return next;
                  })
                }
              />{' '}
              {m.name}
            </label>
          </li>
        ))}
      </ul>
      <button type='button' className='primary small' onClick={send}>
        {chosen.size ? `${chosen.size}명 보내기` : '우리 팀은 안 가요'}
      </button>
    </div>
  );
}

/** 팀 회의 담당자(팀장만). */
export function TeamDelegates() {
  const { run } = useActions();
  const { version } = useListVersion();
  const [data, setData] = useState<TeamDelegatesResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PersonHit[]>([]);
  const [chosen, setChosen] = useState<PersonHit[]>([]);

  useEffect(() => {
    let alive = true;
    apiRequest<TeamDelegatesResponse>('GET', '/api/rooms/joint/delegates')
      .then((d) => {
        if (!alive) return;
        setData(d);
        setEditing(false);
      })
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [version]);

  // 같은 팀 사람만 고를 수 있어서 검색 결과도 우리 부서만 보여요(서버가 다시 확인해요).
  useEffect(() => {
    const q = query.trim();
    if (!q || !data) {
      setHits([]);
      return;
    }
    let alive = true;
    const id = window.setTimeout(() => {
      apiRequest<PeopleSearchResponse>('POST', '/api/people/search', { query: q })
        .then((res) => alive && setHits(res.items.filter((p) => p.department === data.department)))
        .catch(() => alive && setHits([]));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [query, data]);

  if (!data?.isLead) return null;
  const picked = new Set(chosen.map((p) => p.ref));

  function save() {
    void run({
      type: 'fixed',
      text: '저장',
      method: 'POST',
      path: '/api/rooms/joint/delegates',
      body: { people: chosen.map((p) => p.ref), requestId: newRequestId() },
      confirm: {
        title: chosen.length ? '회의 담당자를 이렇게 정할까요?' : '회의 담당자를 모두 지울까요?',
        lines: chosen.length ? chosen.map((p, i) => `${i + 1}. ${p.name}`) : ['여러 팀 회의 참석자는 팀장만 골라요'],
        confirmLabel: '저장',
      },
    });
  }

  return (
    <section className='card' aria-label='팀 회의 담당자'>
      <h2>팀 회의 담당자</h2>
      <p className='hint'>여러 팀 회의 참석자 고르기가 팀장과 담당자에게 같이 가요. 먼저 고른 사람의 선택이 초대가 돼요.</p>
      {!editing && (
        <>
          {data.delegates.length ? (
            <ol className='joint-delegates'>
              {data.delegates.map((d) => (
                <li key={d.position}>{d.name}</li>
              ))}
            </ol>
          ) : (
            <p className='empty'>아직 정한 담당자가 없어요. 팀장만 골라요.</p>
          )}
          <button
            type='button'
            className='secondary small'
            onClick={() => {
              setChosen([]);
              setQuery('');
              setEditing(true);
            }}
          >
            담당자 정하기
          </button>
        </>
      )}
      {editing && (
        <>
          <label className='inquiry-field'>
            <span className='inquiry-label'>
              {data.department} 사람 찾기
              <small>
                {chosen.length} / {TEAM_DELEGATE_MAX}명
              </small>
            </span>
            <input
              className='text-input'
              value={query}
              maxLength={30}
              placeholder='예) 이름 일부'
              autoComplete='off'
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {hits.length > 0 && (
            <ul className='people-list'>
              {hits.map((p) => (
                <li key={p.ref}>
                  <span className='choice-text'>
                    <strong>{p.name}</strong>
                    <span>{p.department}</span>
                  </span>
                  <button
                    type='button'
                    className='secondary small'
                    disabled={picked.has(p.ref) || chosen.length >= TEAM_DELEGATE_MAX}
                    onClick={() => setChosen((list) => [...list, p])}
                  >
                    {picked.has(p.ref) ? '골랐어요' : '추가'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {chosen.length > 0 && (
            <div className='chips' aria-label='고른 담당자'>
              {chosen.map((p, i) => (
                <button key={p.ref} type='button' className='chip selected' onClick={() => setChosen((list) => list.filter((x) => x.ref !== p.ref))}>
                  {i + 1}. {p.name} ✕
                </button>
              ))}
            </div>
          )}
          <div className='actions'>
            <button type='button' className='primary small' onClick={save}>
              저장
            </button>
            <button type='button' className='neutral small' onClick={() => setEditing(false)}>
              그만두기
            </button>
          </div>
        </>
      )}
    </section>
  );
}
