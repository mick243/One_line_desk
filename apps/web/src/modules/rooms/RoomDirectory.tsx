import type { RoomListItem, RoomListResponse } from '@one-line-desk/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { useActions } from '../../components/ActionHost';
import type { ScreenProps } from '../types';
import { RoomDetail } from './RoomDetail';
import { dateLabel, dayChips, statusText } from './roomText';

// 회의실 둘러보기(10/26): 방 카드(그림·정원·지금 상태·장비) 목록. 카드를 누르면 방 자세히가 열려요.
// 내 층 방을 먼저 보여 줘요. 읽기만 하고, 예약은 방 자세히의 확인 시트에서 해요.

const PEOPLE = [0, 4, 6, 10];

export function RoomDirectory({ me }: ScreenProps) {
  const actions = useActions();
  const [date, setDate] = useState<string | null>(null);
  const [data, setData] = useState<RoomListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [floor, setFloor] = useState<string>('전체');
  const [people, setPeople] = useState(0);
  const [freeOnly, setFreeOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // 오늘은 서버가 정해 줘요(첫 응답의 date).
  const [today, setToday] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<RoomListResponse>('GET', date ? `/api/rooms/list?date=${date}` : '/api/rooms/list');
      setData(res);
      setToday((t) => t ?? res.date);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '회의실을 불러오지 못했어요');
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load, actions.version]);

  const rooms = useMemo(() => {
    if (!data) return [];
    const isToday = data.date === today;
    return data.rooms
      .filter((r) => floor === '전체' || r.floor === floor)
      .filter((r) => r.capacity >= people)
      .filter((r) => !(freeOnly && isToday) || r.status.kind === 'free-now')
      .sort((a, b) => Number(b.floor === me.floor) - Number(a.floor === me.floor));
  }, [data, floor, people, freeOnly, today, me.floor]);

  if (error) return <p className='lock-line'>{error}</p>;
  if (!data || !today) return <div className='skeleton' aria-label='회의실 불러오는 중' />;
  if (data.linkOnly) {
    return (
      <section className='card'>
        <h2>모든 회의실</h2>
        <p className='hint'>지금은 회의실을 그룹웨어에서 봐요.</p>
        <a className='secondary' href={data.link} target='_blank' rel='noopener noreferrer'>
          그룹웨어에서 보기
        </a>
      </section>
    );
  }

  const floors = ['전체', ...new Set(data.rooms.map((r) => r.floor))];
  const shownDate = data.date;

  return (
    <section className='room-directory' aria-label='모든 회의실'>
      <header className='screen-head'>
        <h2>모든 회의실 · {dateLabel(shownDate)}</h2>
      </header>
      <div className='chips scroll' role='group' aria-label='날짜'>
        {dayChips(today).map((c) => (
          <button key={c.date} type='button' className={c.date === shownDate ? 'chip selected' : 'chip'} onClick={() => setDate(c.date)}>
            {c.label}
          </button>
        ))}
      </div>
      <div className='chips scroll' role='group' aria-label='층'>
        {floors.map((f) => (
          <button key={f} type='button' className={f === floor ? 'chip selected' : 'chip'} onClick={() => setFloor(f)}>
            {f === me.floor ? `${f}(내 층)` : f}
          </button>
        ))}
      </div>
      <div className='chips scroll' role='group' aria-label='인원'>
        {PEOPLE.map((p) => (
          <button key={p} type='button' className={p === people ? 'chip selected' : 'chip'} onClick={() => setPeople(p)}>
            {p ? `${p}명 이상` : '인원 전체'}
          </button>
        ))}
        {shownDate === today && (
          <button type='button' className={freeOnly ? 'chip selected' : 'chip'} aria-pressed={freeOnly} onClick={() => setFreeOnly((v) => !v)}>
            지금 빈 방만
          </button>
        )}
      </div>

      {rooms.length === 0 && <p className='empty'>조건에 맞는 방이 없어요. 층이나 인원을 바꿔 보세요.</p>}
      <ul className='room-grid'>
        {rooms.map((r) => (
          <li key={r.id}>
            <RoomCard room={r} onOpen={() => setOpen(r.id)} />
          </li>
        ))}
      </ul>
      <p className='hint'>현황 {data.checkedAt.slice(11, 16)} 기준 · 그림은 시연용이에요</p>

      {open && <RoomDetail roomId={open} today={today} initialDate={shownDate} onClose={() => setOpen(null)} />}
    </section>
  );
}

function RoomCard({ room, onOpen }: { room: RoomListItem; onOpen: () => void }) {
  return (
    <button
      type='button'
      className='room-card'
      onClick={onOpen}
      aria-label={`${room.name}, ${room.floor}, 정원 ${room.capacity}명, ${statusText(room.status)}. 자세히 보기`}
    >
      {room.photoUrl ? <img src={room.photoUrl} alt='' loading='lazy' /> : <div className='room-photo-empty'>사진 없음</div>}
      <span className='room-card-body'>
        <strong>{room.name}</strong>
        <span className='room-meta'>
          {room.floor} · 정원 {room.capacity}명
        </span>
        <span className={`room-status ${room.status.kind}`}>{statusText(room.status)}</span>
        {room.equipment.length > 0 && <span className='room-equip'>{room.equipment.join(' · ')}</span>}
      </span>
    </button>
  );
}
