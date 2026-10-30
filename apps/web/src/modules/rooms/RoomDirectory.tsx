import type { RoomListItem, RoomListResponse, RoomShowQuery } from '@one-line-desk/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { useActions } from '../../components/ActionHost';
import type { ScreenProps } from '../types';
import { RoomDetail } from './RoomDetail';
import { dateLabel, statusText } from './roomText';

// 회의실 둘러보기(10/26, 10/28 필터 정리): 회의실 카드(그림·정원·상태·장비)를 층별로 묶어 보여 줘요.
// 내 층 묶음이 먼저예요. 카드를 누르면 회의실 자세히가 열리고, 다른 날 일정과 예약은 회의실 자세히에서 해요(확인 시트).
// 거르기는 켜고 끄는 칩 한 줄이에요: [지금 빈 회의실] [6명 이상] [10명 이상]. 아무것도 안 고르면 모든 회의실이에요.
// 10/28 필터 평가(디자이너·프론트·PM·QA): 날짜 줄은 회의실 자세히와 겹쳐 빼고, 층 칩은 층별 묶음으로, "4명 이상"은
// 가장 작은 회의실이 4명이라 거르는 게 없어 뺐어요. 휴대폰 폭에서 칩이 화면 밖으로 숨지 않게 줄바꿈해요.
// 10/30 QA·디자인 회의: 회의실은 대화로 다뤄서, 이 칸은 대화 현황 카드의 [그림으로 모든 회의실 보기]를 눌렀을 때(show)만 그려요.
// 물은 날짜·조건(빈 회의실·층·회의실 하나)으로 걸러요. 펼칠 때마다 다시 불러서 대화 카드와 기준 시각이 같고, 펼친 자리로 넘겨 줘요.
// 빈 회의실은 오늘이면 지금 빈 곳, 다른 날이면 그날 예약 없는 곳이에요(대화 현황과 같아요).

/** 인원 칩. 하나만 켜지고, 켠 칩을 다시 누르면 꺼져요. */
const PEOPLE = [6, 10] as const;

/** 층 묶음 순서: 내 층 먼저, 그다음 층 번호 순 */
function floorOrder(myFloor: string) {
  return (a: string, b: string) => Number(b === myFloor) - Number(a === myFloor) || parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b);
}

export function RoomDirectory({ me, show = null }: ScreenProps & { show?: RoomShowQuery | null }) {
  const actions = useActions();
  const [data, setData] = useState<RoomListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [people, setPeople] = useState<number | null>(null);
  const [freeOnly, setFreeOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // 대화가 고른 층·회의실. [조건 지우기]로 풀어요.
  const [only, setOnly] = useState<{ floor?: string; roomId?: string }>({});
  const sectionRef = useRef<HTMLElement>(null);
  const scrolledFor = useRef<RoomShowQuery | null>(null);

  // [그림으로 보기]를 누를 때마다 그 조건으로 다시 걸러요.
  useEffect(() => {
    setFreeOnly(show?.onlyFree ?? false);
    setPeople(null);
    setOnly({ floor: show?.floor, roomId: show?.roomId });
  }, [show]);

  const date = show?.date;
  const load = useCallback(async () => {
    if (!date) return;
    try {
      setData(await apiRequest<RoomListResponse>('GET', `/api/rooms/list?date=${encodeURIComponent(date)}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '회의실을 불러오지 못했어요');
    }
  }, [date]);

  // 접혀 있으면 부르지 않아요. 펼칠 때(show가 바뀔 때)마다 새로 불러서 지금 기준으로 맞춰요.
  useEffect(() => {
    if (!show) {
      setData(null);
      return;
    }
    void load();
  }, [show, load, actions.version]);

  const today = data ? data.checkedAt.slice(0, 10) : '';
  const isToday = data !== null && data.date === today;

  const groups = useMemo(() => {
    if (!data) return [];
    const free = (r: RoomListItem) => (isToday ? r.status.kind === 'free-now' : r.status.kind === 'day' && r.status.bookings === 0);
    const shown = data.rooms.filter(
      (r) =>
        (people === null || r.capacity >= people) &&
        (!freeOnly || free(r)) &&
        (!only.floor || r.floor === only.floor) &&
        (!only.roomId || r.id === only.roomId),
    );
    const floors = [...new Set(shown.map((r) => r.floor))].sort(floorOrder(me.floor));
    return floors.map((floor) => ({ floor, rooms: shown.filter((r) => r.floor === floor) }));
  }, [data, isToday, people, freeOnly, only, me.floor]);

  // 펼친 목록이 들어오면 한 번 그 자리로 넘겨요. 대화창 아래라 눌러도 펼친 줄 모를 수 있어서요.
  useEffect(() => {
    if (!show || !data || data.date !== show.date || scrolledFor.current === show) return;
    scrolledFor.current = show;
    sectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [show, data]);

  if (!show) return null;
  if (error) return <p className='lock-line'>{error}</p>;
  if (!data) return <div className='skeleton' aria-label='회의실 불러오는 중' />;
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

  const count = groups.reduce((n, g) => n + g.rooms.length, 0);
  const filtered = freeOnly || people !== null || Boolean(only.floor || only.roomId);
  const clear = () => {
    setFreeOnly(false);
    setPeople(null);
    setOnly({});
  };

  return (
    <section ref={sectionRef} className='room-directory' aria-label='모든 회의실'>
      <header className='screen-head'>
        <h2>
          모든 회의실 · {isToday ? '오늘 ' : ''}
          {dateLabel(data.date)}
        </h2>
      </header>
      <div className='chips' role='group' aria-label='거르기'>
        <button type='button' className='chip toggle' aria-pressed={freeOnly} onClick={() => setFreeOnly((v) => !v)}>
          {isToday ? '지금 빈 회의실' : '예약 없는 회의실'}
        </button>
        {PEOPLE.map((p) => (
          <button key={p} type='button' className='chip toggle' aria-pressed={people === p} onClick={() => setPeople((v) => (v === p ? null : p))}>
            {p}명 이상
          </button>
        ))}
      </div>
      {/* 결과가 바뀌면 화면 읽기 프로그램에도 알려요(role=status). */}
      <p className='room-count' role='status'>
        <span>{filtered ? `조건에 맞는 회의실 ${count}곳` : `회의실 ${count}곳`}</span>
        {filtered && (
          <button type='button' className='link' onClick={clear}>
            조건 지우기
          </button>
        )}
      </p>

      {count === 0 && <p className='empty'>조건에 맞는 회의실이 없어요. [조건 지우기]로 모든 회의실을 볼 수 있어요.</p>}
      {groups.map((g) => (
        <section key={g.floor} className='room-floor' aria-label={g.floor === me.floor ? `${g.floor} · 내 층` : g.floor}>
          <h3>
            {g.floor}
            {g.floor === me.floor && <span className='room-floor-mine'>내 층</span>}
          </h3>
          <ul className='room-grid'>
            {g.rooms.map((r) => (
              <li key={r.id}>
                <RoomCard room={r} onOpen={() => setOpen(r.id)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className='hint'>현황 {data.checkedAt.slice(11, 16)} 기준 · 다른 날 일정은 회의실을 눌러 봐요 · 그림은 시연용이에요</p>

      {open && (
        <RoomDetail roomId={open} today={today} initialDate={data.date} canEditFacilities={me.roles.includes('facilities')} onClose={() => setOpen(null)} />
      )}
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
        {room.repairs.length > 0 && <span className='room-repair'>점검 중: {room.repairs.join(' · ')}</span>}
      </span>
    </button>
  );
}
