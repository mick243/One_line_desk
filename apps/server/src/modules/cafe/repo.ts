import type { CafeOrderStatus } from '@one-line-desk/shared';
import type { Queryable } from '../../core/db';

// 사내 카페 SQL은 여기에만 둬요. 값은 늘 매개변수로 넘겨요.
// 시각은 UTC 밀리초로 주고받고, DB에는 ISO 문자열로 넘겨요. order_day는 한국 날짜 'YYYY-MM-DD'예요.

export interface MenuRow {
  id: string;
  name: string;
  priceWon: number;
  options: string[];
  soldOut: boolean;
  sort: number;
}

/** 주문 행 items 칸의 한 줄. 주문한 때의 메뉴 이름·직원가가 남아요. */
export interface OrderItem {
  menuId: string;
  name: string;
  priceWon: number;
  qty: number;
  options: string[];
}

export interface DutyRow {
  open: boolean;
  lastSeenAt: number | null;
}

export interface OrderRow {
  id: string;
  pickupNo: number;
  items: OrderItem[];
  totalWon: number;
  slot: number;
  status: CafeOrderStatus;
  createdAt: number;
}

const iso = (at: number) => new Date(at).toISOString();

/** 주문을 넣는 길(확인 시트 실행)마다 이 잠금을 먼저 잡아요. 픽업 칸 잔 수와 그날 픽업 번호를 한 번에 하나씩만 세요. */
export async function lockOrders(q: Queryable): Promise<void> {
  await q.query('select pg_advisory_xact_lock(hashtext($1))', ['cafe:orders']);
}

// ── 메뉴 ─────────────────────────────────────────────

export async function countMenu(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('select count(*)::int as n from cafe_menu');
  return rows[0]?.n ?? 0;
}

export async function insertMenu(q: Queryable, items: Omit<MenuRow, 'soldOut'>[]): Promise<void> {
  for (const m of items) {
    await q.query('insert into cafe_menu (id, name, price_won, options, sort) values ($1, $2, $3, $4, $5) on conflict (id) do nothing', [
      m.id,
      m.name,
      m.priceWon,
      m.options,
      m.sort,
    ]);
  }
}

const MENU_COLUMNS = 'id, name, price_won as "priceWon", options, sold_out as "soldOut", sort';

/** 파는 메뉴(active)만, 정한 순서대로 */
export async function listMenu(q: Queryable): Promise<MenuRow[]> {
  const { rows } = await q.query<MenuRow>(`select ${MENU_COLUMNS} from cafe_menu where active order by sort, id`);
  return rows;
}

/** 고른 메뉴(파는 것만). 없는 ID는 빠져요. */
export async function menuByIds(q: Queryable, ids: string[]): Promise<Map<string, MenuRow>> {
  const { rows } = await q.query<MenuRow>(`select ${MENU_COLUMNS} from cafe_menu where active and id = any($1::text[])`, [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

export async function setSoldOut(q: Queryable, id: string, soldOut: boolean): Promise<boolean> {
  const { rows } = await q.query('update cafe_menu set sold_out = $2 where id = $1 and active returning id', [id, soldOut]);
  return rows.length > 0;
}

// ── 영업 ─────────────────────────────────────────────

export async function getDuty(q: Queryable): Promise<DutyRow> {
  const { rows } = await q.query<{ open: boolean; last_seen: number | null }>(
    'select open, (extract(epoch from last_seen_at) * 1000)::float8 as last_seen from cafe_duty where id = 1',
  );
  const row = rows[0];
  return { open: row?.open ?? false, lastSeenAt: row?.last_seen ?? null };
}

/** [영업 시작]·[영업 끝]. 시작하면 판이 지금 보인 것으로 쳐요. */
export async function setOpen(q: Queryable, open: boolean, now: number): Promise<void> {
  if (open) await q.query('update cafe_duty set open = true, opened_at = $1, last_seen_at = $1 where id = 1', [iso(now)]);
  else await q.query('update cafe_duty set open = false where id = 1');
}

/** 카페 판이 서버에 보였어요(영업 중일 때만 불러요). */
export async function touchSeen(q: Queryable, now: number): Promise<void> {
  await q.query('update cafe_duty set last_seen_at = $1 where id = 1 and open', [iso(now)]);
}

// ── 주문 ─────────────────────────────────────────────

/** [from, to) 픽업 칸마다 받은 잔 수(취소 빼고). 칸 시작(ms) → 잔 수 */
export async function slotCups(q: Queryable, from: number, to: number): Promise<Map<number, number>> {
  const { rows } = await q.query<{ slot: number; cups: number }>(
    `select (extract(epoch from pickup_slot) * 1000)::float8 as slot, sum(cups)::int as cups
       from cafe_orders
      where status <> 'cancelled' and pickup_slot >= $1 and pickup_slot < $2
      group by pickup_slot`,
    [iso(from), iso(to)],
  );
  return new Map(rows.map((r) => [r.slot, r.cups]));
}

/** 그날 다음 픽업 번호(1부터). lockOrders를 잡은 뒤에 불러요. */
export async function nextPickupNo(q: Queryable, day: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>('select coalesce(max(pickup_no), 0)::int + 1 as n from cafe_orders where order_day = $1::date', [day]);
  return rows[0]?.n ?? 1;
}

export async function insertOrder(
  q: Queryable,
  o: { pseudonymId: string; planId: string; day: string; pickupNo: number; items: OrderItem[]; totalWon: number; cups: number; slot: number; now: number },
): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    `insert into cafe_orders (pseudonym_id, plan_id, order_day, pickup_no, items, total_won, cups, pickup_slot, status, created_at, updated_at)
     values ($1, $2, $3::date, $4, $5, $6, $7, $8, 'waiting', $9, $9)
     on conflict (plan_id) do nothing
     returning id::text as id`,
    [o.pseudonymId, o.planId, o.day, o.pickupNo, JSON.stringify(o.items), o.totalWon, o.cups, iso(o.slot), iso(o.now)],
  );
  return rows[0]?.id ?? null;
}

const ORDER_COLUMNS = `id::text as id, pickup_no as "pickupNo", items, total_won as "totalWon",
  (extract(epoch from pickup_slot) * 1000)::float8 as slot, status,
  (extract(epoch from created_at) * 1000)::float8 as "createdAt"`;

/** 그날 내 주문(취소 포함, 최근 것부터) */
export async function myOrdersOn(q: Queryable, pseudonymId: string, day: string): Promise<OrderRow[]> {
  const { rows } = await q.query<OrderRow>(
    `select ${ORDER_COLUMNS} from cafe_orders where pseudonym_id = $1 and order_day = $2::date order by pickup_no desc`,
    [pseudonymId, day],
  );
  return rows;
}

/** 그달(한국 날짜 monthStart부터 한 달) 내 주문 합계. 취소한 주문은 빼요. 주문 행에서 바로 세요. */
export async function monthTotal(q: Queryable, pseudonymId: string, monthStart: string): Promise<number> {
  const { rows } = await q.query<{ won: number }>(
    `select coalesce(sum(total_won), 0)::int as won
       from cafe_orders
      where pseudonym_id = $1 and status <> 'cancelled' and order_day >= $2::date and order_day < ($2::date + interval '1 month')`,
    [pseudonymId, monthStart],
  );
  return rows[0]?.won ?? 0;
}

/** 카페 판: 그날 아직 건네지 않은 주문(픽업 칸·번호 순). 가명 ID·금액 칸은 읽지 않아요. */
export async function boardOrders(q: Queryable, day: string): Promise<Omit<OrderRow, 'totalWon'>[]> {
  const { rows } = await q.query<Omit<OrderRow, 'totalWon'>>(
    `select id::text as id, pickup_no as "pickupNo", items, (extract(epoch from pickup_slot) * 1000)::float8 as slot, status,
            (extract(epoch from created_at) * 1000)::float8 as "createdAt"
       from cafe_orders
      where order_day = $1::date and status in ('waiting', 'making', 'ready')
      order by pickup_slot, pickup_no`,
    [day],
  );
  return rows;
}

/** 상태를 한 단계만 바꿔요(from일 때만). 바뀌었으면 주문한 사람의 가명 ID(알림용)를 돌려줘요. */
export async function advanceStatus(q: Queryable, id: string, from: CafeOrderStatus, to: CafeOrderStatus, now: number): Promise<string | null> {
  const { rows } = await q.query<{ pseudonym_id: string }>(
    'update cafe_orders set status = $3, updated_at = $4 where id = $1::bigint and status = $2 returning pseudonym_id',
    [id, from, to, iso(now)],
  );
  return rows[0]?.pseudonym_id ?? null;
}

export async function orderStatus(q: Queryable, id: string): Promise<CafeOrderStatus | null> {
  const { rows } = await q.query<{ status: CafeOrderStatus }>('select status from cafe_orders where id = $1::bigint', [id]);
  return rows[0]?.status ?? null;
}

/** 내 주문이고 접수 대기일 때만 취소해요. 취소했으면 그 주문을 돌려줘요. */
export async function cancelMine(q: Queryable, id: string, pseudonymId: string, now: number): Promise<OrderRow | null> {
  const { rows } = await q.query<OrderRow>(
    `update cafe_orders set status = 'cancelled', updated_at = $3
      where id = $1::bigint and pseudonym_id = $2 and status = 'waiting'
      returning ${ORDER_COLUMNS}`,
    [id, pseudonymId, iso(now)],
  );
  return rows[0] ?? null;
}

/** 내 주문의 지금 상태. 남의 주문이면 null이에요(있는지도 알려 주지 않아요). */
export async function myOrderStatus(q: Queryable, id: string, pseudonymId: string): Promise<CafeOrderStatus | null> {
  const { rows } = await q.query<{ status: CafeOrderStatus }>('select status from cafe_orders where id = $1::bigint and pseudonym_id = $2', [id, pseudonymId]);
  return rows[0]?.status ?? null;
}

/**
 * 보관(ADR-21 예외, ADR-29): 취소하고 7일 지난 주문만 지워요.
 * 다른 주문(접수 대기~가져감)은 지우지 않아요. 주문 상세는 월 청구서의 근거라서, 청구·[입금 확인] 7일 뒤 지우기(다음 묶음,
 * ADR-29 사용자 승인 예외)가 들어올 때까지 남겨요. 지금 지우면 청구 합계를 주문 행에서 다시 셀 수 없어요.
 */
export async function purgeCancelled(q: Queryable, before: number): Promise<void> {
  await q.query("delete from cafe_orders where status = 'cancelled' and updated_at < $1", [iso(before)]);
}
