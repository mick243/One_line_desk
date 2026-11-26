import { ABSENCE_PART_LABEL, AWAY_KIND_LABEL, TEAM_TODAY_TEXT, type TeamTodayPeopleResponse, type TeamTodayResponse } from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { ApiFailure, apiRequest } from '../api';

// 오늘 우리 팀 한 줄(11/25 회의 결정). 홈을 열 때 수만 받아 접힌 한 줄로 보여 줘요.
// 이름은 [누구인지 보기]를 눌러야 받아요(그때 서버가 접속기록을 남겨요). 회의는 보여 주지 않아요.
// 받은 이름은 이 화면 메모리에만 있고, 접으면 버려요.

type Person = TeamTodayPeopleResponse['entries'][number];

/** "휴가 2명 · 자리비움 1명" 같은 수 줄. 둘 다 0이면 "오늘 빠지는 사람이 없어요"예요. */
export function teamTodayLine(t: Pick<TeamTodayResponse, 'leave' | 'away'>): string {
  const parts = [t.leave > 0 ? `휴가 ${t.leave}명` : '', t.away > 0 ? `자리비움 ${t.away}명` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : TEAM_TODAY_TEXT.none;
}

export const personText = (e: Person): string =>
  e.what === 'leave' ? `${ABSENCE_PART_LABEL[e.part]} 휴가` : e.allDay ? `종일 ${AWAY_KIND_LABEL[e.away]}` : `${e.start}–${e.end} ${AWAY_KIND_LABEL[e.away]}`;

export function TeamTodayView({
  today,
  people,
  busy,
  error,
  onOpen,
  onClose,
}: {
  today: TeamTodayResponse;
  people: Person[] | null;
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onClose: () => void;
}) {
  const anyone = today.leave + today.away > 0;
  return (
    <section className='card team-today' aria-label={TEAM_TODAY_TEXT.title}>
      <div className='team-today-head'>
        <p>
          <strong>{TEAM_TODAY_TEXT.title}</strong> <span className='hint'>{today.team}</span> · {teamTodayLine(today)}
        </p>
        {anyone && (
          <button type='button' className='neutral small' disabled={busy} onClick={people ? onClose : onOpen} aria-expanded={people !== null}>
            {people ? TEAM_TODAY_TEXT.close : busy ? '불러오는 중' : TEAM_TODAY_TEXT.open}
          </button>
        )}
      </div>
      {!today.leaveConnected && <p className='hint'>{TEAM_TODAY_TEXT.notConnected}</p>}
      {error && (
        <p className='lock-line' role='alert'>
          {error}
        </p>
      )}
      {people && (
        <ul className='plain team-today-people'>
          {people.length === 0 && <li className='hint'>{TEAM_TODAY_TEXT.none}</li>}
          {people.map((e, i) => (
            <li key={`${e.name}-${e.what}-${i}`}>
              {e.name.split(' ').at(-1)} · {personText(e)}
            </li>
          ))}
        </ul>
      )}
      <p className='hint'>{TEAM_TODAY_TEXT.tail}</p>
    </section>
  );
}

/** 홈에 붙는 한 줄. 스위치가 꺼져 있거나 불러오지 못하면 아무것도 그리지 않아요. */
export function TeamToday() {
  const [today, setToday] = useState<TeamTodayResponse | null>(null);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiRequest<TeamTodayResponse>('GET', '/api/home/team-today')
      .then((t) => {
        if (alive) setToday(t);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!today?.enabled) return null;

  async function open() {
    setBusy(true);
    setError(null);
    try {
      setPeople((await apiRequest<TeamTodayPeopleResponse>('GET', '/api/home/team-today/people')).entries);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금은 팀 현황을 불러오지 못했어요');
    } finally {
      setBusy(false);
    }
  }

  return <TeamTodayView today={today} people={people} busy={busy} error={error} onOpen={() => void open()} onClose={() => setPeople(null)} />;
}
