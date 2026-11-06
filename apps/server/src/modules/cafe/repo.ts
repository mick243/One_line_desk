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
const ADMIN_MENU_COLUMNS = `${MENU_COLUMNS}, active`;

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

/** subject는 주문한 사람의 IdP 주체예요. 청구서로 옮겨 가서 총무 정산 화면에 이름을 그때 붙이는 데만 써요(2묶음). */
export async function insertOrder(
  q: Queryable,
  o: {
    pseudonymId: string;
    subject: string;
    planId: string;
    day: string;
    pickupNo: number;
    items: OrderItem[];
    totalWon: number;
    cups: number;
    slot: number;
    now: number;
  },
): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    `insert into cafe_orders (pseudonym_id, idp_subject, plan_id, order_day, pickup_no, items, total_won, cups, pickup_slot, status, created_at, updated_at)
     values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, 'waiting', $10, $10)
     on conflict (plan_id) do nothing
     returning id::text as id`,
    [o.pseudonymId, o.subject, o.planId, o.day, o.pickupNo, JSON.stringify(o.items), o.totalWon, o.cups, iso(o.slot), iso(o.now)],
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
 * 보관(ADR-21 예외, ADR-29): 취소하고 7일 지난 주문을 지워요.
 * 다른 주문(접수 대기~가져감)은 월 청구서의 근거라서 [입금 확인] 7일 뒤 청구서와 같이 지워요(purgePaid). 미납이면 남아요.
 */
export async function purgeCancelled(q: Queryable, before: number): Promise<void> {
  await q.query("delete from cafe_orders where status = 'cancelled' and updated_at < $1", [iso(before)]);
}

// ── 메뉴·직원가 관리(총무, 2묶음) ─────────────────────

export type AdminMenuRow = MenuRow & { active: boolean };

/** 총무 관리용: 쓰지 않는 메뉴까지 모두 */
export async function listAllMenu(q: Queryable): Promise<AdminMenuRow[]> {
  const { rows } = await q.query<AdminMenuRow>(`select ${ADMIN_MENU_COLUMNS} from cafe_menu order by sort, id`);
  return rows;
}

export async function nextMenuSort(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('select coalesce(max(sort), 0)::int + 10 as n from cafe_menu');
  return rows[0]?.n ?? 10;
}

export async function addMenu(q: Queryable, m: { id: string; name: string; priceWon: number; options: string[]; sort: number }): Promise<AdminMenuRow | null> {
  const { rows } = await q.query<AdminMenuRow>(
    `insert into cafe_menu (id, name, price_won, options, sort) values ($1, $2, $3, $4, $5) on conflict (id) do nothing returning ${ADMIN_MENU_COLUMNS}`,
    [m.id, m.name, m.priceWon, m.options, m.sort],
  );
  return rows[0] ?? null;
}

/** 이름·직원가·옵션·파는지 바꾸기. 품절은 바리스타가 따로 바꿔요. */
export async function updateMenu(
  q: Queryable,
  id: string,
  m: { name: string; priceWon: number; options: string[]; active: boolean },
): Promise<AdminMenuRow | null> {
  const { rows } = await q.query<AdminMenuRow>(
    `update cafe_menu set name = $2, price_won = $3, options = $4, active = $5 where id = $1 returning ${ADMIN_MENU_COLUMNS}`,
    [id, m.name, m.priceWon, m.options, m.active],
  );
  return rows[0] ?? null;
}

// ── 청구서(2묶음) ────────────────────────────────────
// 청구서는 (사람, 주문한 달) 하나예요. 합계·건수는 주문 행(취소 뺌)에서 SQL로 다시 세요.

export interface BillRow {
  id: string;
  pseudonymId: string;
  subject: string | null;
  /** 주문한 달 'YYYY-MM' */
  month: string;
  totalWon: number;
  count: number;
  code: string;
  /** 납부 기한(한국 날짜 'YYYY-MM-DD', 이날까지) */
  dueOn: string;
  status: 'unpaid' | 'paid';
  paidAt: number | null;
}

const BILL_COLUMNS = `id::text as id, pseudonym_id as "pseudonymId", idp_subject as subject, month, total_won as "totalWon",
  order_count as count, code, due_on::text as "dueOn", status, (extract(epoch from paid_at) * 1000)::float8 as "paidAt"`;

/** 아직 청구서가 없는 (사람, 달)마다 주문 합계·건수(취소 뺌). before(이번 달 1일) 앞 주문만이에요. lockOrders를 잡은 뒤에 불러요. */
export async function unbilledMonths(
  q: Queryable,
  before: string,
): Promise<{ pseudonymId: string; subject: string | null; month: string; totalWon: number; count: number }[]> {
  const { rows } = await q.query<{ pseudonymId: string; subject: string | null; month: string; totalWon: number; count: number }>(
    `select o.pseudonym_id as "pseudonymId", max(o.idp_subject) as subject, to_char(o.order_day, 'YYYY-MM') as month,
            coalesce(sum(o.total_won), 0)::int as "totalWon", count(*)::int as count
       from cafe_orders o
      where o.status <> 'cancelled' and o.order_day < $1::date
        and not exists (select 1 from cafe_bills b where b.pseudonym_id = o.pseudonym_id and b.month = to_char(o.order_day, 'YYYY-MM'))
      group by o.pseudonym_id, to_char(o.order_day, 'YYYY-MM')
      order by 3, 1`,
    [before],
  );
  return rows;
}

export async function codeTaken(q: Queryable, code: string): Promise<boolean> {
  const { rows } = await q.query('select 1 from cafe_bills where code = $1', [code]);
  return rows.length > 0;
}

/** 청구서를 만들어요. (사람, 달)이 이미 있으면 null이에요(멱등). paid면 낼 게 없는 0원 청구서예요. */
export async function insertBill(
  q: Queryable,
  b: {
    pseudonymId: string;
    subject: string | null;
    month: string;
    totalWon: number;
    count: number;
    code: string;
    issuedAt: number;
    dueOn: string;
    paid: boolean;
  },
): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    `insert into cafe_bills (pseudonym_id, idp_subject, month, total_won, order_count, code, issued_at, due_on, status, paid_at)
     values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::date, case when $9::boolean then 'paid' else 'unpaid' end, case when $9::boolean then $7::timestamptz end)
     on conflict (pseudonym_id, month) do nothing
     returning id::text as id`,
    [b.pseudonymId, b.subject, b.month, b.totalWon, b.count, b.code, iso(b.issuedAt), b.dueOn, b.paid],
  );
  return rows[0]?.id ?? null;
}

/** 알림 보낸 기록. 이미 보냈으면 false예요(중복 알림 막기). */
export async function insertNotice(q: Queryable, billId: string, kind: 'issued' | 'overdue', seq: number, now: number): Promise<boolean> {
  const { rows } = await q.query(
    'insert into cafe_bill_notices (bill_id, kind, seq, sent_at) values ($1::bigint, $2, $3, $4) on conflict do nothing returning bill_id',
    [billId, kind, seq, iso(now)],
  );
  return rows.length > 0;
}

/** 기한(due_on)이 오늘 앞인 미납 청구서. 기한 다음 날·주 1회 알림 대상이에요. */
export async function overdueBills(q: Queryable, today: string): Promise<{ id: string; pseudonymId: string; dueOn: string }[]> {
  const { rows } = await q.query<{ id: string; pseudonymId: string; dueOn: string }>(
    `select id::text as id, pseudonym_id as "pseudonymId", due_on::text as "dueOn" from cafe_bills where status = 'unpaid' and due_on < $1::date order by id`,
    [today],
  );
  return rows;
}

/** 기한이 지난 미납 청구서가 있는지(기한 다음 날부터 새 주문 막기). */
export async function hasOverdue(q: Queryable, pseudonymId: string, today: string): Promise<boolean> {
  const { rows } = await q.query("select 1 from cafe_bills where pseudonym_id = $1 and status = 'unpaid' and due_on < $2::date limit 1", [pseudonymId, today]);
  return rows.length > 0;
}

/** 내 청구서(최근 달부터) */
export async function myBills(q: Queryable, pseudonymId: string): Promise<BillRow[]> {
  const { rows } = await q.query<BillRow>(`select ${BILL_COLUMNS} from cafe_bills where pseudonym_id = $1 order by month desc`, [pseudonymId]);
  return rows;
}

/** 청구서의 건별 내역: 그 달 내 주문(취소 뺌, 날짜·번호 순) */
export async function billOrders(
  q: Queryable,
  pseudonymId: string,
  months: string[],
): Promise<{ month: string; day: string; items: OrderItem[]; totalWon: number }[]> {
  const { rows } = await q.query<{ month: string; day: string; items: OrderItem[]; totalWon: number }>(
    `select to_char(order_day, 'YYYY-MM') as month, order_day::text as day, items, total_won as "totalWon"
       from cafe_orders
      where pseudonym_id = $1 and status <> 'cancelled' and to_char(order_day, 'YYYY-MM') = any($2::text[])
      order by order_day, pickup_no`,
    [pseudonymId, months],
  );
  return rows;
}

/** 총무 정산: 그 달 청구서 모두 */
export async function billsOfMonth(q: Queryable, month: string): Promise<BillRow[]> {
  const { rows } = await q.query<BillRow>(`select ${BILL_COLUMNS} from cafe_bills where month = $1 order by id`, [month]);
  return rows;
}

/** 청구서가 있는 달(최근 것부터) */
export async function billMonths(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ month: string }>('select distinct month from cafe_bills order by month desc');
  return rows.map((r) => r.month);
}

/** [입금 확인]: 미납일 때만 바꿔요. 바꿨으면 그 사람 가명 ID(알림·접속기록용)를 돌려줘요. */
export async function markPaid(q: Queryable, id: string, now: number): Promise<string | null> {
  const { rows } = await q.query<{ pseudonym_id: string }>(
    "update cafe_bills set status = 'paid', paid_at = $2 where id = $1::bigint and status = 'unpaid' returning pseudonym_id",
    [id, iso(now)],
  );
  return rows[0]?.pseudonym_id ?? null;
}

export async function billOwner(q: Queryable, id: string): Promise<{ pseudonymId: string; status: 'unpaid' | 'paid' } | null> {
  const { rows } = await q.query<{ pseudonymId: string; status: 'unpaid' | 'paid' }>(
    'select pseudonym_id as "pseudonymId", status from cafe_bills where id = $1::bigint',
    [id],
  );
  return rows[0] ?? null;
}

// ── 한도(2묶음) ──────────────────────────────────────

/** 그 달에 늘린 한도. 없으면 null이에요(운영 값 한도를 써요). */
export async function monthLimit(q: Queryable, pseudonymId: string, month: string): Promise<number | null> {
  const { rows } = await q.query<{ won: number }>('select limit_won as won from cafe_month_limits where pseudonym_id = $1 and month = $2', [
    pseudonymId,
    month,
  ]);
  return rows[0]?.won ?? null;
}

/** [늘려 주기]: 그 달 한도를 늘려요(이미 더 크면 그대로). */
export async function raiseMonthLimit(q: Queryable, pseudonymId: string, month: string, limitWon: number): Promise<void> {
  await q.query(
    `insert into cafe_month_limits (pseudonym_id, month, limit_won) values ($1, $2, $3)
     on conflict (pseudonym_id, month) do update set limit_won = greatest(cafe_month_limits.limit_won, excluded.limit_won)`,
    [pseudonymId, month, limitWon],
  );
}

export interface LimitRequestRow {
  id: string;
  pseudonymId: string;
  subject: string | null;
  month: string;
  amountWon: number;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
}

const REQUEST_COLUMNS = `id::text as id, pseudonym_id as "pseudonymId", idp_subject as subject, month, amount_won as "amountWon", status,
  (extract(epoch from created_at) * 1000)::float8 as "createdAt"`;

/** 한도 요청을 넣어요. 그 달 대기 중 요청이 이미 있으면 null이에요. */
export async function insertLimitRequest(
  q: Queryable,
  r: { pseudonymId: string; subject: string; month: string; amountWon: number; now: number },
): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    `insert into cafe_limit_requests (pseudonym_id, idp_subject, month, amount_won, status, created_at) values ($1, $2, $3, $4, 'pending', $5)
     on conflict do nothing returning id::text as id`,
    [r.pseudonymId, r.subject, r.month, r.amountWon, iso(r.now)],
  );
  return rows[0]?.id ?? null;
}

/** 그 달 내 한도 요청(가장 최근 것) */
export async function myLimitRequest(q: Queryable, pseudonymId: string, month: string): Promise<LimitRequestRow | null> {
  const { rows } = await q.query<LimitRequestRow>(
    `select ${REQUEST_COLUMNS} from cafe_limit_requests where pseudonym_id = $1 and month = $2 order by created_at desc, id desc limit 1`,
    [pseudonymId, month],
  );
  return rows[0] ?? null;
}

/** 총무 정산: 남아 있는 한도 요청 모두(대기 중 먼저, 최근 것부터) */
export async function limitRequests(q: Queryable): Promise<LimitRequestRow[]> {
  const { rows } = await q.query<LimitRequestRow>(
    `select ${REQUEST_COLUMNS} from cafe_limit_requests order by (status = 'pending') desc, created_at desc, id desc`,
  );
  return rows;
}

export async function limitRequest(q: Queryable, id: string): Promise<LimitRequestRow | null> {
  const { rows } = await q.query<LimitRequestRow>(`select ${REQUEST_COLUMNS} from cafe_limit_requests where id = $1::bigint`, [id]);
  return rows[0] ?? null;
}

/** [늘려 주기]·[안 돼요]: 대기 중일 때만 바꿔요. 바꿨으면 true예요. */
export async function decideLimitRequest(q: Queryable, id: string, status: 'approved' | 'rejected', now: number): Promise<boolean> {
  const { rows } = await q.query("update cafe_limit_requests set status = $2, decided_at = $3 where id = $1::bigint and status = 'pending' returning id", [
    id,
    status,
    iso(now),
  ]);
  return rows.length > 0;
}

// ── 매출 합계 내보내기(이름·가명 ID 없음) ─────────────

/**
 * 그 달 날·메뉴별 잔 수·금액(취소 뺌). 주문 때 남긴 메뉴 이름·직원가로 세요.
 * 메뉴 이름 순서는 DB 언어 설정과 상관없이 글자 번호 순(collate "C")이에요. 한글은 이 순서가 가나다 순과 같아요.
 */
export async function salesOf(q: Queryable, month: string): Promise<{ day: string; name: string; cups: number; won: number }[]> {
  const { rows } = await q.query<{ day: string; name: string; cups: number; won: number }>(
    `select o.order_day::text as day, i->>'name' as name, sum((i->>'qty')::int)::int as cups,
            sum((i->>'qty')::int * (i->>'priceWon')::int)::int as won
       from cafe_orders o cross join lateral jsonb_array_elements(o.items) as i
      where o.status <> 'cancelled' and o.order_day >= to_date($1 || '-01', 'YYYY-MM-DD')
        and o.order_day < (to_date($1 || '-01', 'YYYY-MM-DD') + interval '1 month')
      group by o.order_day, i->>'name'
      order by o.order_day, (i->>'name') collate "C"`,
    [month],
  );
  return rows;
}

// ── 보관 지우기(2묶음) ────────────────────────────────

/**
 * 보관(ADR-21 예외, ADR-29 사용자 승인): [입금 확인]하고 7일 지난 청구서와 그 사람 그 달 주문을 같이 지워요(알림 기록은 청구서와 같이).
 * 미납 청구서와 그 달 주문은 남아요.
 */
export async function purgePaid(q: Queryable, before: number): Promise<void> {
  await q.query(
    `with gone as (delete from cafe_bills where status = 'paid' and paid_at < $1 returning pseudonym_id, month)
     delete from cafe_orders o using gone
      where o.pseudonym_id = gone.pseudonym_id
        and o.order_day >= to_date(gone.month || '-01', 'YYYY-MM-DD')
        and o.order_day < (to_date(gone.month || '-01', 'YYYY-MM-DD') + interval '1 month')`,
    [iso(before)],
  );
}

/** 한도 요청은 처리(대기 중이면 만든) 뒤 7일에 지워요. */
export async function purgeLimitRequests(q: Queryable, before: number): Promise<void> {
  await q.query('delete from cafe_limit_requests where coalesce(decided_at, created_at) < $1', [iso(before)]);
}

/** 늘린 한도는 그 달에만 써요. 달이 끝나면 지워요. */
export async function purgeMonthLimits(q: Queryable, thisMonth: string): Promise<void> {
  await q.query('delete from cafe_month_limits where month < $1', [thisMonth]);
}
