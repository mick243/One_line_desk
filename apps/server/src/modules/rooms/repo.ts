import type { Equipment, FacilityStatus, LoanKind } from '@one-line-desk/shared';
import type { Queryable } from '../../core/db';
import type { LedgerBooking, LedgerRoom } from './ledger-adapter';

// 회의실 SQL은 여기에만 둬요. 값은 늘 매개변수로 넘겨요.
// 시각은 UTC 밀리초로 주고받고, DB에는 ISO 문자열로 넘겨요.

export interface RoomRow {
  id: string;
  name: string;
  floor: string;
  capacity: number;
  /** 쓸 수 있는 설비. 점검 중인 설비는 빠져서 찾기 조건에 맞지 않아요(ADR-19). */
  equipment: Equipment[];
  /** 점검 중인 설비 */
  repairs: Equipment[];
  facilities: string[];
  photoUrl: string | null;
}

/** 하루 일정 한 칸. 내 예약인지(참·거짓)만 알고, 남의 예약은 누가 잡았는지 모르는 채로 와요. */
export interface DayBlockRow {
  start: number;
  end: number;
  mine: boolean;
  /** 내 앱 예약일 때만 */
  reservationId: string | null;
}

/** 어느 회의실이 언제 차 있는지만 알아요. 누가 잡았는지는 읽지 않아요. */
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
    await q.query(
      'insert into rooms (id, name, floor, capacity, equipment, facilities, photo_url) values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do nothing',
      [r.id, r.name, r.floor, r.capacity, r.equipment, r.facilities, r.photoUrl],
    );
  }
  for (const b of bookings) {
    await q.query(
      "insert into room_reservations (room_id, slot, pseudonym_id, source) values ($1, tstzrange($2, $3, '[)'), $4, 'ledger') on conflict do nothing",
      [b.roomId, iso(b.start), iso(b.end), `ledger:${b.ref}`],
    );
  }
}

/** 이미 들어간 회의실에 사진·설비가 비어 있으면 장부 값으로 채워요(301 마이그레이션 전에 넣은 시연 DB용). */
export async function fillRoomDetails(q: Queryable, rooms: LedgerRoom[]): Promise<void> {
  for (const r of rooms) {
    await q.query('update rooms set facilities = $2, photo_url = $3 where id = $1 and photo_url is null', [r.id, r.facilities, r.photoUrl]);
  }
}

// 점검 중인 설비(room_facility_status)는 equipment에서 빼고 repairs로 따로 줘요(ADR-19).
const REPAIRING = "select s.facility from room_facility_status s where s.room_id = r.id and s.status = 'repair'";
const ROOM_COLUMNS = `r.id, r.name, r.floor, r.capacity,
  array(select u.e from unnest(r.equipment) with ordinality u(e, n) where u.e not in (${REPAIRING}) order by u.n) as equipment,
  array(select u.e from unnest(r.equipment) with ordinality u(e, n) where u.e in (${REPAIRING}) order by u.n) as repairs,
  r.facilities, r.photo_url as "photoUrl"`;

export async function listRooms(q: Queryable): Promise<RoomRow[]> {
  const { rows } = await q.query<RoomRow>(`select ${ROOM_COLUMNS} from rooms r order by r.id`);
  return rows;
}

export async function getRoom(q: Queryable, id: string): Promise<RoomRow | null> {
  const { rows } = await q.query<RoomRow>(`select ${ROOM_COLUMNS} from rooms r where r.id = $1`, [id]);
  return rows[0] ?? null;
}

/** 한 회의실의 하루 일정. 예약자 칸은 고르지 않고, 내 예약인지만 계산해요(ADR-06). */
export async function dayBlocks(q: Queryable, roomId: string, from: number, to: number, pseudonymId: string): Promise<DayBlockRow[]> {
  const { rows } = await q.query<DayBlockRow>(
    `select (extract(epoch from lower(slot)) * 1000)::float8 as start,
            (extract(epoch from upper(slot)) * 1000)::float8 as "end",
            (source = 'app' and pseudonym_id = $4) as mine,
            case when source = 'app' and pseudonym_id = $4 then id::text end as "reservationId"
       from room_reservations
      where room_id = $1 and slot && tstzrange($2, $3, '[)')
      order by lower(slot)`,
    [roomId, iso(from), iso(to), pseudonymId],
  );
  return rows;
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

/** 한 사람의 아직 끝나지 않은 앱 예약 하나. 장비를 회의에 붙여 빌릴 때 써요. */
export async function getMyReservation(q: Queryable, id: string, pseudonymId: string, now: number): Promise<ReservationRow | null> {
  const { rows } = await q.query<ReservationRow>(
    `select ${RESERVATION_COLUMNS}
       from room_reservations x join rooms r on r.id = x.room_id
      where x.id = $1 and x.pseudonym_id = $2 and x.source = 'app' and upper(x.slot) > $3`,
    [id, pseudonymId, iso(now)],
  );
  return rows[0] ?? null;
}

// ── 장비 대여·설비 상태(ADR-19) ─────────────────────────────────

export interface LoanItemRow {
  id: string;
  kind: LoanKind;
  name: string;
  home: string;
}

/** 대여 한 줄. 내 대여만 읽어요. */
export interface LoanRow {
  id: string;
  kind: LoanKind;
  itemName: string;
  home: string;
  start: number;
  end: number;
  reservationId: string | null;
  roomName: string | null;
}

/** 종류별 전체 수와 [from, to)에 빌릴 수 있는 수. 누가 빌렸는지는 읽지 않아요. */
export interface LoanStockRow {
  kind: LoanKind;
  total: number;
  free: number;
}

/** 시연용 이동식 장비(등급 0). 여러 번 불러도 한 번만 들어가요. */
export async function insertEquipment(q: Queryable, items: LoanItemRow[]): Promise<void> {
  for (const item of items) {
    await q.query('insert into room_equipment (id, kind, name, home) values ($1, $2, $3, $4) on conflict (id) do nothing', [
      item.id,
      item.kind,
      item.name,
      item.home,
    ]);
  }
}

export async function countEquipment(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('select count(*)::int as n from room_equipment');
  return rows[0]?.n ?? 0;
}

const FREE_ITEM = `e.status = 'ok' and not exists (
  select 1 from room_equipment_loans l where l.item_id = e.id and l.slot && tstzrange($1, $2, '[)'))`;

export async function loanStock(q: Queryable, from: number, to: number): Promise<LoanStockRow[]> {
  const { rows } = await q.query<LoanStockRow>(
    `select e.kind, count(*)::int as total, (count(*) filter (where ${FREE_ITEM}))::int as free
       from room_equipment e
      group by e.kind`,
    [iso(from), iso(to)],
  );
  return rows;
}

/** 그 종류에서 [from, to)에 비어 있는 장비. 점검 중인 장비는 빼요. */
export async function freeItems(q: Queryable, kind: LoanKind, from: number, to: number): Promise<LoanItemRow[]> {
  const { rows } = await q.query<LoanItemRow>(`select e.id, e.kind, e.name, e.home from room_equipment e where e.kind = $3 and ${FREE_ITEM} order by e.id`, [
    iso(from),
    iso(to),
    kind,
  ]);
  return rows;
}

/**
 * 대여를 넣어요. 같은 장비 같은 시간 겹침은 제약이 막고 null을 돌려줘요.
 * 실행 중인 같은 사람의 'rooms:rent' plan이 있어야 들어가요(303 마이그레이션의 트리거).
 */
export async function insertLoan(
  q: Queryable,
  l: { itemId: string; start: number; end: number; pseudonymId: string; planId: string; reservationId: string | null },
): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    `insert into room_equipment_loans (item_id, slot, pseudonym_id, plan_id, reservation_id)
     values ($1, tstzrange($2, $3, '[)'), $4, $5, $6)
     on conflict do nothing
     returning id::text as id`,
    [l.itemId, iso(l.start), iso(l.end), l.pseudonymId, l.planId, l.reservationId],
  );
  return rows[0]?.id ?? null;
}

const LOAN_COLUMNS = `l.id::text as id, e.kind, e.name as "itemName", e.home,
  (extract(epoch from lower(l.slot)) * 1000)::float8 as start,
  (extract(epoch from upper(l.slot)) * 1000)::float8 as "end",
  l.reservation_id::text as "reservationId", r.name as "roomName"`;
const LOAN_FROM = `room_equipment_loans l
  join room_equipment e on e.id = l.item_id
  left join room_reservations x on x.id = l.reservation_id
  left join rooms r on r.id = x.room_id`;

/** 내 대여 중 아직 끝나지 않은 것 */
export async function myLoans(q: Queryable, pseudonymId: string, now: number): Promise<LoanRow[]> {
  const { rows } = await q.query<LoanRow>(
    `select ${LOAN_COLUMNS} from ${LOAN_FROM} where l.pseudonym_id = $1 and upper(l.slot) > $2 order by lower(l.slot), l.id`,
    [pseudonymId, iso(now)],
  );
  return rows;
}

/** 예약에 붙여 빌린 장비 종류(예약 id → 종류들). 내 예약만 물어요. */
export async function loanKindsByReservation(q: Queryable, reservationIds: string[]): Promise<Map<string, LoanKind[]>> {
  const out = new Map<string, LoanKind[]>();
  if (!reservationIds.length) return out;
  const { rows } = await q.query<{ reservationId: string; kind: LoanKind }>(
    `select l.reservation_id::text as "reservationId", e.kind
       from room_equipment_loans l join room_equipment e on e.id = l.item_id
      where l.reservation_id = any($1::bigint[])
      order by l.id`,
    [reservationIds],
  );
  for (const r of rows) out.set(r.reservationId, [...(out.get(r.reservationId) ?? []), r.kind]);
  return out;
}

/**
 * 대여 끝내기(고정 버튼). 시작 전이면 지우고(대여 취소), 쓰는 중이면 지금 시각에 끝내요(반납).
 * 내 대여이고 아직 끝나지 않은 것만 건드려요.
 */
export async function endLoan(q: Queryable, id: string, pseudonymId: string, now: number): Promise<{ row: LoanRow; how: 'cancelled' | 'returned' } | null> {
  const { rows } = await q.query<LoanRow>(
    `select ${LOAN_COLUMNS} from ${LOAN_FROM} where l.id = $1 and l.pseudonym_id = $2 and upper(l.slot) > $3 for update of l`,
    [id, pseudonymId, iso(now)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.start >= now) {
    await q.query('delete from room_equipment_loans where id = $1', [id]);
    return { row, how: 'cancelled' };
  }
  await q.query("update room_equipment_loans set slot = tstzrange(lower(slot), $2, '[)') where id = $1", [id, iso(now)]);
  return { row: { ...row, end: now }, how: 'returned' };
}

/** 회의실 설비 상태를 바꿔요(총무). 정상으로 돌리면 줄을 남겨 두고 상태만 바꿔요. */
export async function setFacilityStatus(q: Queryable, roomId: string, facility: Equipment, status: FacilityStatus, now: number): Promise<void> {
  await q.query(
    `insert into room_facility_status (room_id, facility, status, updated_at) values ($1, $2, $3, $4)
     on conflict (room_id, facility) do update set status = excluded.status, updated_at = excluded.updated_at`,
    [roomId, facility, status, iso(now)],
  );
}

/** 시연용 설비 상태(처음 한 번만). 이미 줄이 있으면 총무가 바꾼 값을 그대로 둬요. */
export async function seedFacilityStatus(q: Queryable, rows: { roomId: string; facility: Equipment; status: FacilityStatus }[]): Promise<void> {
  for (const r of rows) {
    await q.query(
      'insert into room_facility_status (room_id, facility, status) select $1, $2, $3 where exists (select 1 from rooms where id = $1) on conflict do nothing',
      [r.roomId, r.facility, r.status],
    );
  }
}

/**
 * 보관 기간(7일, 10/28)이 지난 회의실 기록을 지워요. 서버가 한 시간마다 불러요.
 * 끝난 지 7일 지난 예약(초대·같이 빌린 장비는 함께 지워져요), 끝난 지 7일 지난 대여, 취소한 지 7일 지난 취소 이력이에요.
 * 앞으로 할 예약·대여는 언제 잡았든 남아요.
 */
export async function purgeRecords(q: Queryable, before: number): Promise<void> {
  const at = new Date(before).toISOString();
  await q.query('delete from room_reservations where upper(slot) < $1', [at]);
  await q.query('delete from room_equipment_loans where upper(slot) < $1', [at]);
  await q.query('delete from room_reservation_history where cancelled_at < $1', [at]);
}
