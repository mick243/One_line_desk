import { addDays, AWAY_KIND_LABEL, AWAY_KINDS, AWAY_MAX_DAYS, type AwayKind, type AwayListResponse, kstDate } from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { newRequestId } from '../../net';

// 자리비움 알리기(11/3 사용자 결정). 내 외근·출장·재택·자리비움을 정하면 같은 팀 사람이 홈 채팅 "같은 팀 일정"에서 봐요.
// 종류·날·시간만 골라요. 사유·장소 같은 글 칸은 없어요. 정하기·지우기는 고정 버튼이고 본인 것만 돼요.
// 같은 팀 일정이나 담당 찾기가 꺼져 있으면 서버가 enabled: false를 줘서 이 칸을 숨겨요.

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const dayLabel = (date: string) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일(${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]})`;
/** ISO 시각 → 한국 시간 "11월 3일(화) 14:00" */
export function awayWhen(iso: string): string {
  const at = Date.parse(iso) + 9 * 60 * 60 * 1000;
  const kst = new Date(at).toISOString();
  return `${dayLabel(kst.slice(0, 10))} ${kst.slice(11, 16)}`;
}
const toIso = (date: string, time: string) => `${date}T${time}:00+09:00`;

export function MyAway() {
  const [data, setData] = useState<AwayListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = kstDate(Date.now());
  const [kind, setKind] = useState<AwayKind>('outside');
  const [date, setDate] = useState(today);
  const [start, setStart] = useState('14:00');
  const [end, setEnd] = useState('18:00');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    apiRequest<AwayListResponse>('GET', '/api/navi/away')
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(e instanceof ApiFailure ? e.message : '자리비움을 불러오지 못했어요'));
    return () => {
      alive = false;
    };
  }, []);

  if (!data?.enabled) return error ? <p className='lock-line'>{error}</p> : null;

  async function send(run: () => Promise<AwayListResponse>) {
    setBusy(true);
    try {
      setData(await run());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금 처리하지 못했어요');
    } finally {
      setBusy(false);
    }
  }

  const days = Array.from({ length: AWAY_MAX_DAYS }, (_, i) => addDays(today, i));
  return (
    <section className='card away' aria-label='자리비움 알리기'>
      <h2>자리비움 알리기</h2>
      <p className='hint'>같은 팀 사람에게만 종류와 시간이 보여요. 사유는 적지 않아요. 7일 뒤 지워져요.</p>
      <div className='away-form'>
        <label>
          종류
          <select value={kind} onChange={(e) => setKind(e.target.value as AwayKind)}>
            {AWAY_KINDS.map((k) => (
              <option key={k} value={k}>
                {AWAY_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          날
          <select value={date} onChange={(e) => setDate(e.target.value)}>
            {days.map((d) => (
              <option key={d} value={d}>
                {dayLabel(d)}
              </option>
            ))}
          </select>
        </label>
        <label>
          시작
          <input type='time' value={start} step={900} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          끝
          <input type='time' value={end} step={900} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <button
          type='button'
          disabled={busy}
          onClick={() =>
            void send(() =>
              apiRequest<AwayListResponse>('POST', '/api/navi/away', { kind, start: toIso(date, start), end: toIso(date, end), requestId: newRequestId() }),
            )
          }
        >
          알리기
        </button>
      </div>
      {error && <p className='lock-line'>{error}</p>}
      {data.items.length === 0 ? (
        <p className='empty'>알린 자리비움이 없어요.</p>
      ) : (
        <ul className='home-items' aria-label='내 자리비움'>
          {data.items.map((a) => (
            <li key={a.id}>
              <div className='home-item-text'>
                <strong>{AWAY_KIND_LABEL[a.kind]}</strong>
                <span className='hint'>
                  {awayWhen(a.start)} ~ {awayWhen(a.end)}
                </span>
              </div>
              <button
                type='button'
                className='secondary small'
                disabled={busy}
                onClick={() => void send(() => apiRequest<AwayListResponse>('POST', '/api/navi/away/clear', { id: a.id, requestId: newRequestId() }))}
              >
                지우기
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
