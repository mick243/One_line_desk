import { INVITE_RESPONSE_LABEL, type MyReservationsResponse, ROOM_CONDITIONS_VARIANT } from '@one-line-desk/shared';
import { type ComponentType, useEffect, useState } from 'react';
import { apiRequest } from '../../api';
import { useActions } from '../../components/ActionHost';
import type { CardViewProps } from '../../components/CardView';
import { RoomConditionsCard } from './RoomConditionsCard';

export { DemoInbox, InvitedMeetings } from './Invited';
export { InviteSheet } from './InviteSheet';
export { RoomDirectory } from './RoomDirectory';
export { MyLoans, RoomChat } from './RoomChat';

// F2 회의실 화면 부품.
// - MyReservations: S1(compact, 짧은 목록)·S6 "내 예약" 칸. [취소]는 확인 시트를 거쳐요(ADR-03).
// - roomsCardRenderers: S2 조건 칩 줄(카드 variant 'rooms-conditions'). registry에 붙이는 건 리드가 해요.
// - RoomDirectory: 회의실 페이지 "모든 회의실" 방 카드와 방 자세히(10/26).
// - RoomChat·MyLoans: 회의실 채팅(시키면 바로 예약·대여)과 "내 대여" 칸(10/28, ADR-19).

const COMPACT_LIMIT = 2;

/** S1·S6 "내 예약" 칸. 회의실이 꺼졌거나 회의실 쓰기가 꺼지면 칸을 숨겨요(R4). */
export function MyReservations({ compact }: { compact?: boolean }) {
  const { run, version } = useActions();
  const [data, setData] = useState<MyReservationsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  // 쓰기(예약·취소)가 끝나 version이 오르면 다시 불러요.
  useEffect(() => {
    let alive = true;
    apiRequest<MyReservationsResponse>('GET', '/api/rooms/my-reservations')
      .then((d) => {
        if (!alive) return;
        setData(d);
        setFailed(false);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [version, retry]);

  if (failed && !data) {
    return (
      <section className='card' aria-label='내 예약'>
        <h2>내 예약</h2>
        <p className='empty'>내 예약을 불러오지 못했어요.</p>
        <button type='button' className='secondary small' onClick={() => setRetry((n) => n + 1)}>
          다시 불러오기
        </button>
      </section>
    );
  }
  if (!data || !data.enabled) return null;

  const items = compact ? data.items.slice(0, COMPACT_LIMIT) : data.items;
  const more = data.items.length - items.length;
  return (
    <section className='card' aria-label='내 예약'>
      <h2>내 예약</h2>
      {items.length === 0 ? (
        <p className='empty'>{compact ? '다가오는 예약이 없어요.' : '예약이 없어요. 회의실 탭에서 빈 방을 찾아보세요.'}</p>
      ) : (
        <ul className='plain my-reservations'>
          {items.map((r) => (
            <li key={r.id} className='invited'>
              <div>
                <p>
                  <strong>{r.roomName}</strong> · {r.floor}
                </p>
                <p className='hint'>{r.when} · 내 예약</p>
                {r.loans.length > 0 && <p className='hint'>같이 빌린 장비: {r.loans.join(' · ')}</p>}
                {r.attendees.length > 0 && (
                  <p className='hint'>{r.attendees.map((a) => `${a.name.split(' ').at(-1)}(${INVITE_RESPONSE_LABEL[a.response]})`).join(' · ')}</p>
                )}
              </div>
              {!compact && (
                <div className='row-actions'>
                  <button type='button' className='secondary small' onClick={() => void run(r.invite)}>
                    {r.invite.text}
                  </button>
                  <a className='neutral small' href={r.icsPath} download>
                    캘린더 파일
                  </a>
                  <button type='button' className='neutral small' onClick={() => void run(r.cancel)}>
                    {r.cancel.text}
                  </button>
                </div>
              )}
              {compact && (
                <button type='button' className='secondary small' onClick={() => void run(r.cancel)}>
                  {r.cancel.text}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className='hint'>내 것에서 {more}건 더 볼 수 있어요.</p>}
    </section>
  );
}

/** card.variant → 회의실이 따로 그리는 카드 */
export const roomsCardRenderers: Record<string, ComponentType<CardViewProps>> = {
  [ROOM_CONDITIONS_VARIANT]: RoomConditionsCard,
};
