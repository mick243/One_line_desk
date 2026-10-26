import { EQUIPMENT, type Equipment, parseRoomConditionFields, type RoomCardsResponse, type RoomQuery } from '@one-line-desk/shared';
import { useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { useActions } from '../../components/ActionHost';
import type { CardViewProps } from '../../components/CardView';

// S2 회의실 "조건 칩 줄"(F2-1, 화면설계 ②-2·4). 서버가 준 조건 카드의 칸을 칩으로 그려 고치게 해요.
// 고친 값은 이 부품 상태(페이지 메모리)에만 두고, [이 조건으로 다시 찾기]가 POST 본문으로만 보내요(R13).
// 다시 찾기는 읽기만 해요. 예약은 새 후보 카드의 [이 방으로 예약] → 확인 시트에서만 돼요.

const MISSING_CLASS = 'missing';

export function RoomConditionsCard({ card, onWrong }: CardViewProps) {
  const actions = useActions();
  const initial = parseRoomConditionFields(card.fields);
  const [date, setDate] = useState(initial.date ?? '');
  const [start, setStart] = useState(initial.start ?? '');
  const [minutes, setMinutes] = useState(initial.minutes ? String(initial.minutes) : '');
  const [people, setPeople] = useState(initial.people ? String(initial.people) : '');
  const [equipment, setEquipment] = useState<Equipment[]>(initial.equipment ?? []);
  const [floor, setFloor] = useState(initial.floor ? initial.floor.replace('층', '') : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function query(): Partial<RoomQuery> {
    const q: Partial<RoomQuery> = { equipment };
    if (date) q.date = date;
    if (start) q.start = start;
    if (Number(minutes) > 0) q.minutes = Number(minutes);
    if (Number(people) > 0) q.people = Number(people);
    if (/^\d{1,2}$/.test(floor)) q.floor = `${floor}층`;
    return q;
  }

  async function research() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiRequest<RoomCardsResponse>('POST', '/api/rooms/search', { query: query() });
      actions.show({ title: '회의실 후보', cards: res.cards });
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금 다시 찾지 못했어요');
    } finally {
      setBusy(false);
    }
  }

  const toggle = (e: Equipment) => setEquipment((list) => (list.includes(e) ? list.filter((x) => x !== e) : [...list, e]));

  return (
    <article className={`result-card label-${card.label} room-conditions`} aria-label={`회의실 ${card.label}`}>
      <header className='card-head'>
        <span className='kind'>회의실</span>
        <span className='label'>{card.label}</span>
      </header>
      <div className='card-body'>
        <p className='headline'>{card.headline}</p>
        <div className='chips' role='group' aria-label='조건 칩'>
          <label className={`chip ${date ? '' : MISSING_CLASS}`}>
            날짜 <input type='date' autoComplete='off' value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className={`chip ${start ? '' : MISSING_CLASS}`}>
            시작 <input type='time' step={1800} autoComplete='off' value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className='chip'>
            길이{' '}
            <input
              type='number'
              inputMode='numeric'
              min={10}
              max={600}
              step={10}
              autoComplete='off'
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
            분
          </label>
          <label className={`chip ${people ? '' : MISSING_CLASS}`}>
            인원 <input type='number' inputMode='numeric' min={1} max={200} autoComplete='off' value={people} onChange={(e) => setPeople(e.target.value)} />명
          </label>
          {EQUIPMENT.map((e) => (
            <label key={e} className={`chip ${equipment.includes(e) ? 'selected' : ''}`}>
              <input type='checkbox' checked={equipment.includes(e)} onChange={() => toggle(e)} /> {e}
            </label>
          ))}
          <label className='chip'>
            층{' '}
            <input
              type='text'
              inputMode='numeric'
              maxLength={2}
              placeholder='상관없어요'
              autoComplete='off'
              value={floor}
              onChange={(e) => setFloor(e.target.value.replace(/\D/g, ''))}
            />
          </label>
        </div>
        {error && (
          <p className='lock-line' role='alert'>
            {error}
          </p>
        )}
      </div>
      <p className='evidence'>
        {card.evidence.aiSummarized && <span className='ai-badge'>AI 정리</span>}
        {card.evidence.text}
      </p>
      <div className='card-actions'>
        <button type='button' className='secondary' disabled={busy} onClick={() => void research()}>
          {busy ? '다시 찾는 중' : '이 조건으로 다시 찾기'}
        </button>
        {card.wrong && onWrong && (
          <button type='button' className='link' onClick={() => onWrong(card)}>
            틀렸어요
          </button>
        )}
      </div>
      <p className='tail'>{card.tail}</p>
    </article>
  );
}
