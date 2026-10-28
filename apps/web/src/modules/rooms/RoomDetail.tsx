import type { Card, Equipment, RoomCardsResponse, RoomDayResponse } from '@one-line-desk/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { replaceCard, useActions } from '../../components/ActionHost';
import { CardView } from '../../components/CardView';
import { Sheet } from '../../components/Sheet';
import { dateLabel, dayChips, fromMinutes, splitCheckedAt, statusText, toMinutes } from './roomText';

// 방 자세히(10/26): 그림·정원·설비 · 지금 상태 · 하루 일정(30분 칸) · 빈 시간을 골라 [이 시간 확인] → 확인 시트로 예약.
// 남의 예약은 "예약됨"으로만 보이고, 내 예약에만 [취소]가 있어요(ADR-06). 확인 시트 전에는 아무것도 쓰지 않아요.

const STEP = 30;
const LENGTHS = [30, 60, 90, 120];

export function RoomDetail({
  roomId,
  today,
  initialDate,
  canEditFacilities = false,
  onClose,
}: {
  roomId: string;
  today: string;
  initialDate: string;
  /** 총무만 설비 점검 상태를 바꿔요(ADR-19). */
  canEditFacilities?: boolean;
  onClose: () => void;
}) {
  const actions = useActions();
  const [date, setDate] = useState(initialDate);
  const [day, setDay] = useState<RoomDayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(60);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDay(await apiRequest<RoomDayResponse>('GET', `/api/rooms/${roomId}/day?date=${date}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '일정을 불러오지 못했어요');
    }
  }, [roomId, date]);

  // 예약·취소가 끝나면(version) 일정을 다시 불러요.
  useEffect(() => {
    void load();
  }, [load, actions.version]);

  // 날짜를 바꾸거나 예약·취소가 끝나면 고른 시간과 확인 카드를 비워요.
  useEffect(() => {
    setStart(null);
    setCards(null);
  }, [date, actions.version]);

  const rows = useMemo(() => {
    if (!day) return [];
    const now = splitCheckedAt(day.checkedAt);
    const isToday = day.date === now.date;
    const list: { time: string; state: 'free' | 'busy' | 'mine' | 'past'; blockStart?: number }[] = [];
    for (let m = toMinutes(day.open); m < toMinutes(day.close); m += STEP) {
      const block = day.blocks.findIndex((b) => toMinutes(b.start) < m + STEP && m < toMinutes(b.end));
      const past = isToday && m + STEP <= toMinutes(now.time);
      const state = block >= 0 ? (day.blocks[block]!.mine ? 'mine' : 'busy') : past ? 'past' : 'free';
      list.push({ time: fromMinutes(m), state, ...(block >= 0 ? { blockStart: block } : {}) });
    }
    return list;
  }, [day]);

  // 설비 점검 상태 바꾸기(총무). 고정 버튼이라 바로 반영하고 일정을 다시 불러요.
  async function setFacility(facility: Equipment, status: 'ok' | 'repair') {
    if (busy) return;
    setBusy(true);
    try {
      await apiRequest('PUT', `/api/rooms/${roomId}/facilities`, { facility, status });
      actions.refresh();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금 바꾸지 못했어요');
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    if (!start || busy) return;
    setBusy(true);
    try {
      const res = await apiRequest<RoomCardsResponse>('POST', `/api/rooms/${roomId}/slot`, { date, start, minutes });
      setCards(res.cards);
    } catch (e) {
      setCards(null);
      setError(e instanceof ApiFailure ? e.message : '지금 확인하지 못했어요');
    } finally {
      setBusy(false);
    }
  }

  const room = day?.room;
  const selectedEnd = start ? fromMinutes(toMinutes(start) + minutes) : null;
  const inSelection = (time: string) => start !== null && toMinutes(time) >= toMinutes(start) && toMinutes(time) < toMinutes(start) + minutes;

  return (
    <Sheet title={room?.name ?? '회의실'} onClose={onClose}>
      {error && <p className='lock-line'>{error}</p>}
      {!room && !error && <div className='skeleton' aria-label='불러오는 중' />}
      {room && (
        <div className='room-detail'>
          {room.photoUrl && <img className='room-detail-photo' src={room.photoUrl} alt={`${room.name} 그림`} />}
          <dl className='room-facts'>
            <dt>층</dt>
            <dd>{room.floor}</dd>
            <dt>정원</dt>
            <dd>{room.capacity}명</dd>
            <dt>상태</dt>
            <dd>{statusText(room.status)}</dd>
          </dl>

          <section aria-label='설비'>
            <h3>설비</h3>
            {(room.equipment.length > 0 || room.repairs.length > 0) && (
              <ul className='room-equipment-status'>
                {room.equipment.map((e) => (
                  <li key={e}>
                    <span>{e}</span>
                    <span className='hint'>정상</span>
                    {canEditFacilities && (
                      <button type='button' className='neutral small' disabled={busy} onClick={() => void setFacility(e, 'repair')}>
                        점검 중으로
                      </button>
                    )}
                  </li>
                ))}
                {room.repairs.map((e) => (
                  <li key={e} className='repair'>
                    <span>{e}</span>
                    <span className='room-repair'>점검 중</span>
                    {canEditFacilities && (
                      <button type='button' className='neutral small' disabled={busy} onClick={() => void setFacility(e, 'ok')}>
                        정상으로
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {room.facilities.length ? (
              <ul className='room-facilities'>
                {room.facilities.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : (
              <p className='hint'>장부에 적힌 설비가 없어요</p>
            )}
          </section>

          <section aria-label='예약 현황'>
            <h3>예약 현황 · {dateLabel(date)}</h3>
            <div className='chips scroll' role='group' aria-label='날짜'>
              {dayChips(today).map((c) => (
                <button
                  key={c.date}
                  type='button'
                  className={c.date === date ? 'chip selected' : 'chip'}
                  aria-pressed={c.date === date}
                  onClick={() => setDate(c.date)}
                >
                  {c.label}
                </button>
              ))}
              <label className='chip'>
                날짜 <input type='date' value={date} min={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
              </label>
            </div>
            <p className='hint'>남의 예약은 "예약됨"으로만 보여요. 빈 칸을 누르면 그 시각부터 골라요.</p>
            <ol className='room-timeline'>
              {rows.map((r, i) => {
                const block = r.blockStart !== undefined ? day!.blocks[r.blockStart]! : null;
                const first = block && block.start === r.time;
                const firstPast = r.state === 'past' && rows[i - 1]?.state !== 'past';
                return (
                  <li key={r.time} className={`slot ${r.state}${inSelection(r.time) ? ' picked' : ''}`}>
                    <span className='slot-time'>{r.time.endsWith(':00') ? r.time : ''}</span>
                    {r.state === 'free' ? (
                      <button type='button' className='slot-bar' aria-label={`${r.time} 비어 있어요. 이 시간부터 고르기`} onClick={() => setStart(r.time)}>
                        {inSelection(r.time) && r.time === start ? `${start}~${selectedEnd}` : ''}
                      </button>
                    ) : (
                      <span className='slot-bar'>
                        {first && (
                          <>
                            {block.mine ? '내 예약' : '예약됨'} {block.start}~{block.end}
                            {block.cancel && (
                              <button type='button' className='link' onClick={() => void actions.run(block.cancel!)}>
                                취소
                              </button>
                            )}
                          </>
                        )}
                        {firstPast && '지난 시간'}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>

          <section className='room-pick' aria-label='시간 고르기'>
            <div className='row'>
              <span>{start ? `${start}부터` : '빈 칸을 눌러 시작 시각을 골라 주세요'}</span>
              <select aria-label='회의 길이' value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {LENGTHS.map((m) => (
                  <option key={m} value={m}>
                    {m}분
                  </option>
                ))}
              </select>
            </div>
            <button type='button' className='primary' disabled={!start || busy} onClick={() => void check()}>
              {busy ? '확인하는 중' : start ? `${start}~${selectedEnd} 예약할 수 있는지 보기` : '예약할 수 있는지 보기'}
            </button>
            {cards?.map((card) => (
              <CardView
                key={card.id}
                card={card}
                onAction={(action) => actions.run(action, card, (next) => setCards((list) => (list ? replaceCard(list, card.id, next) : next)))}
              />
            ))}
          </section>
        </div>
      )}
    </Sheet>
  );
}
