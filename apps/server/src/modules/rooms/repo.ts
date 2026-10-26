import type { Equipment } from '@one-line-desk/shared';
import type { Queryable } from '../../core/db';
import type { LedgerBooking, LedgerRoom } from './ledger-adapter';

// 회의실 SQL은 여기에만 둬요. 값은 늘 매개변수로 넘겨요.
// 시각은 UTC 밀리초로 주고받고, DB에는 ISO 문자열로 넘겨요.

export interface RoomRow {
  id: string;
  name: string;
  floor: string;
  capacity: number;
  equipment: Equipment[];
}

/** 어느 방이 언제 차 있는지만 알아요. 누가 잡았는지는 읽지 않아요. */
export interface BusyRow {
  roomId: string;
  start: number;
  end: number;
}

/** 내 예약 한 줄 */
export interface ReservationRow {
  id: string;
  roomId: string;
  roomName: string;
  floor: string;
  start: number;
  end: number;
}

const iso = (at: number) => new Date(at).toISOString();

export async function countRooms(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('select count(*)::int as n from rooms');
  return rows[0]?.n ?? 0;
}

/** 모의 장부를 넣어요. 남의 예약은 'ledger' 출처·가명 값으로만 들어가요(plan 없음). */
export async function insertLedger(q: Queryable, rooms: LedgerRoom[], bookings: LedgerBooking[]): Promise<void> {
  for (const r of rooms) {
    await q.query('insert into rooms (id, name, floor, capacity, equipment) values ($1, $2, $3, $4, $5) on conflict (id) do nothing', [
      r.id,
      r.name,
      r.floor,
      r.capacity,
      r.equipment,
    ]);
  }
  for (const b of bookings) {
    await q.query(
      "insert into room_reservations (room_id, slot, pseudonym_id, source) values ($1, tstzrange($2, $3, '[)'), $4, 'ledger') on conflict do nothing",
      [b.roomId, iso(b.start), iso(b.end), `ledger:${b.ref}`],
    );
  }
}

export async function listRooms(q: Queryable): Promise<RoomRow[]> {
  const { rows } = await q.query<RoomRow>('select id, name, floor, capacity, equipment from rooms order by id');
  return rows;
}

export async function getRoom(q: Queryable, id: string): Promise<RoomRow | null> {
  const { rows } = await q.query<RoomRow>('select id, name, floor, capacity, equipment from rooms where id = $1', [id]);
  return rows[0] ?? null;
}

/** [from, to)와 겹치는 예약 구간. 예약자 칸은 고르지 않아요. */
export async function busyBetween(q: Queryable, from: number, to: number): Promise<BusyRow[]> {
  const { rows } = await q.query<BusyRow>(
    `select room_id as "roomId",
            (extract(epoch from lower(slot)) * 1000)::float8 as start,
            (extract(epoch from upper(slot)) * 1000)::float8 as "end"
       from room_reservations
      where slot && tstzrange($1, $2, '[)')`,
    [iso(from), iso(to)],
  );
  return rows;
}

/**
 * 확정 순간 재확인(ADR-06). 겹침 제약이 막으면 아무것도 넣지 않고 null을 돌려줘요.
 * 앱 예약은 실행 중인 같은 사람의 plan이 있어야 들어가요(300 마이그레이션의 트리거).
 */
export async function insertReservation(
  q: Queryable,
  r: { roomId: string; start: number; end: number; pseudonymId: string; planId: string },
): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    `insert into room_reservations (room_id, slot, pseudonym_id, plan_id, source)
     values ($1, tstzrange($2, $3, '[)'), $4, $5, 'app')
     on conflict do nothing
     returning id::text as id`,
    [r.roomId, iso(r.start), iso(r.end), r.pseudonymId, r.planId],
  );
  return rows[0]?.id ?? null;
}

const RESERVATION_COLUMNS = `x.id::text as id, x.room_id as "roomId", r.name as "roomName", r.floor,
  (extract(epoch from lower(x.slot)) * 1000)::float8 as start,
  (extract(epoch from upper(x.slot)) * 1000)::float8 as "end"`;

/** 내 예약 중 아직 끝나지 않은 것 */
export async function myUpcoming(q: Queryable, pseudonymId: string, now: number): Promise<ReservationRow[]> {
  const { rows } = await q.query<ReservationRow>(
    `select ${RESERVATION_COLUMNS}
       from room_reservations x join rooms r on r.id = x.room_id
      where x.pseudonym_id = $1 and x.source = 'app' and upper(x.slot) > $2
      order by lower(x.slot), x.id`,
    [pseudonymId, iso(now)],
  );
  return rows;
}

/** 취소: 내 예약을 예약 표에서 지우고 이력 표로 옮겨요(ADR-06). 끝난 예약과 남의 예약은 건드리지 않아요. */
export async function moveToHistory(q: Queryable, id: string, pseudonymId: string, now: number): Promise<ReservationRow | null> {
  const { rows } = await q.query<ReservationRow>(
    `with moved as (
       delete from room_reservations
        where id = $1 and pseudonym_id = $2 and source = 'app' and upper(slot) > $3
        returning id, room_id, slot, pseudonym_id, plan_id, created_at
     ), saved as (
       insert into room_reservation_history (id, room_id, slot, pseudonym_id, plan_id, created_at, cancelled_at)
       select id, room_id, slot, pseudonym_id, plan_id, created_at, $3 from moved
       returning id, room_id, slot
     )
     select ${RESERVATION_COLUMNS} from saved x join rooms r on r.id = x.room_id`,
    [id, pseudonymId, iso(now)],
  );
  return rows[0] ?? null;
}
