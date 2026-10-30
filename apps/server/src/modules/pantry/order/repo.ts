import type { OrderCycleChange, OrderPlanStatus, OrderReasonCode } from '@one-line-desk/shared';
import type { Queryable } from '../../../core/db';
import type { FloorBasis, PlannedLine } from './plan';

// 주문안 SQL(460_pantry_order.sql). 판 표(pantry_cards·pantry_cycles·pantry_floor_settings)는 확정 때만 바꿔요.

export interface PlanRow {
  id: string;
  status: OrderPlanStatus;
  budget: number;
  floorBasis: FloorBasis[];
  explained: boolean;
  createdAt: string;
  confirmedAt: string | null;
}

export interface LineRow extends PlannedLine {
  explanation: string;
  explanationSource: 'ai' | 'template';
}

interface RawPlan {
  id: string;
  status: OrderPlanStatus;
  budget: number;
  floor_basis: FloorBasis[] | string;
  explained: boolean;
  created_at: Date;
  confirmed_at: Date | null;
}

interface RawLine {
  line_no: number;
  bundle_id: number | string;
  bundle_version: number;
  floor: string;
  item_name: string;
  catalog_item_id: string | null;
  votes: number;
  unit_price: number | null;
  pack_unit: number | null;
  quantity: number;
  amount: number;
  included: boolean;
  reason: OrderReasonCode;
  rank: number;
  explanation: string;
  explanation_source: 'ai' | 'template';
  edited: boolean;
}

const PLAN_COLUMNS = 'id, status, budget, floor_basis, explained, created_at, confirmed_at';

function toPlan(r: RawPlan): PlanRow {
  return {
    id: r.id,
    status: r.status,
    budget: r.budget,
    floorBasis: typeof r.floor_basis === 'string' ? (JSON.parse(r.floor_basis) as FloorBasis[]) : r.floor_basis,
    explained: r.explained,
    createdAt: new Date(r.created_at).toISOString(),
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
  };
}

function toLine(r: RawLine): LineRow {
  return {
    lineNo: r.line_no,
    bundleId: Number(r.bundle_id),
    bundleVersion: r.bundle_version,
    floor: r.floor,
    itemName: r.item_name,
    catalogItemId: r.catalog_item_id,
    votes: r.votes,
    unitPrice: r.unit_price,
    packUnit: r.pack_unit,
    quantity: r.quantity,
    amount: r.amount,
    included: r.included,
    reason: r.reason,
    rank: r.rank,
    explanation: r.explanation,
    explanationSource: r.explanation_source,
    edited: r.edited,
  };
}

/** 층별 최소 몫(총무가 S4 설정에서 정한 값) */
export async function readMinShares(q: Queryable): Promise<Record<string, number>> {
  const { rows } = await q.query<{ floor: string; min_share_won: number }>('select floor, min_share_won from pantry_floor_settings');
  return Object.fromEntries(rows.map((r) => [r.floor, r.min_share_won]));
}

/**
 * 주문안 만들기를 차례로 처리해요(L10). 두 만들기가 동시에 오면 뒤의 것이 앞의 것이 끝날 때까지 기다린 뒤
 * 그 초안을 replaced로 바꾸고 새 초안을 넣어요. "초안 하나" 유일 인덱스 위반(500)이 생기지 않아요. 트랜잭션이 끝나면 풀려요.
 */
export async function lockPlanCreation(q: Queryable): Promise<void> {
  await q.query('select pg_advisory_xact_lock(hashtext($1))', ['pantry:order-plan-create']);
}

export async function insertPlan(
  q: Queryable,
  plan: { id: string; budget: number; floorBasis: FloorBasis[]; createdAt: Date },
  lines: readonly (PlannedLine & { explanation: string })[],
): Promise<void> {
  await q.query("update pantry_order_plans set status = 'replaced' where status = 'draft'");
  await q.query('insert into pantry_order_plans (id, budget, floor_basis, created_at) values ($1, $2, $3::jsonb, $4)', [
    plan.id,
    plan.budget,
    JSON.stringify(plan.floorBasis),
    plan.createdAt,
  ]);
  for (const l of lines) {
    await q.query(
      `insert into pantry_order_lines (plan_id, line_no, bundle_id, bundle_version, floor, item_name, catalog_item_id, votes, unit_price, pack_unit,
                                       quantity, amount, included, reason, rank, explanation, explanation_source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'template')`,
      [
        plan.id,
        l.lineNo,
        l.bundleId,
        l.bundleVersion,
        l.floor,
        l.itemName,
        l.catalogItemId,
        l.votes,
        l.unitPrice,
        l.packUnit,
        l.quantity,
        l.amount,
        l.included,
        l.reason,
        l.rank,
        l.explanation,
      ],
    );
  }
}

export async function findPlan(q: Queryable, planId: string, opts: { lock?: boolean } = {}): Promise<PlanRow | null> {
  const { rows } = await q.query<RawPlan>(`select ${PLAN_COLUMNS} from pantry_order_plans where id = $1${opts.lock ? ' for update' : ''}`, [planId]);
  return rows[0] ? toPlan(rows[0]) : null;
}

/** 고치는 중인 주문안, 없으면 마지막으로 확정한 주문안 */
export async function findCurrentPlan(q: Queryable): Promise<PlanRow | null> {
  const { rows } = await q.query<RawPlan>(
    `select ${PLAN_COLUMNS} from pantry_order_plans where status in ('draft', 'confirmed')
      order by (status = 'draft') desc, created_at desc limit 1`,
  );
  return rows[0] ? toPlan(rows[0]) : null;
}

export async function listLines(q: Queryable, planId: string): Promise<LineRow[]> {
  const { rows } = await q.query<RawLine>(
    `select line_no, bundle_id, bundle_version, floor, item_name, catalog_item_id, votes, unit_price, pack_unit, quantity, amount, included,
            reason, rank, explanation, explanation_source, edited
       from pantry_order_lines where plan_id = $1 order by line_no`,
    [planId],
  );
  return rows.map(toLine);
}

/** AI 설명을 넣어요. 그사이 총무가 고친 줄은 건드리지 않아요. */
export async function saveExplanations(
  q: Queryable,
  planId: string,
  explanations: ReadonlyMap<number, { sentence: string; source: 'ai' | 'template' }>,
): Promise<void> {
  for (const [lineNo, e] of explanations) {
    await q.query('update pantry_order_lines set explanation = $3, explanation_source = $4 where plan_id = $1 and line_no = $2 and not edited', [
      planId,
      lineNo,
      e.sentence,
      e.source,
    ]);
  }
  await q.query("update pantry_order_plans set explained = true where id = $1 and status = 'draft'", [planId]);
}

export async function updateLine(
  q: Queryable,
  planId: string,
  lineNo: number,
  change: { included: boolean; quantity: number; amount: number; explanation: string },
): Promise<void> {
  await q.query(
    `update pantry_order_lines set included = $3, quantity = $4, amount = $5, explanation = $6, explanation_source = 'template', edited = true
      where plan_id = $1 and line_no = $2`,
    [planId, lineNo, change.included, change.quantity, change.amount, change.explanation],
  );
}

/** 주문에 들어간 묶음의 카드를 주문됨으로 바꿔요(표 닫힘, ADR-07 I6). 바꾼 카드 수를 돌려줘요. */
export async function markCardsOrdered(q: Queryable, cardIds: readonly number[]): Promise<number> {
  if (cardIds.length === 0) return 0;
  const { rows } = await q.query<{ id: number }>("update pantry_cards set state = 'ordered' where id = any($1::bigint[]) and state = 'open' returning id", [
    cardIds,
  ]);
  return rows.length;
}

/** 그 층의 열린 주기를 닫고 다음 주기를 열어요(R16). 상한은 층 설정, 없으면 닫은 주기 값을 이어받아요. */
export async function rollCycle(q: Queryable, floor: string): Promise<OrderCycleChange> {
  const open = await q.query<{ cycle_no: number; per_person_limit: number }>(
    "select cycle_no, per_person_limit from pantry_cycles where floor = $1 and state = 'open' order by cycle_no desc for update",
    [floor],
  );
  const setting = await q.query<{ per_person_limit: number }>('select per_person_limit from pantry_floor_settings where floor = $1', [floor]);
  const last = await q.query<{ max: number | null }>('select max(cycle_no) as max from pantry_cycles where floor = $1', [floor]);
  const current = open.rows[0];
  if (open.rows.length > 0) await q.query("update pantry_cycles set state = 'closed' where floor = $1 and state = 'open'", [floor]);
  const next = (last.rows[0]?.max ?? 0) + 1;
  const limit = setting.rows[0]?.per_person_limit ?? current?.per_person_limit ?? 5;
  await q.query("insert into pantry_cycles (floor, cycle_no, state, per_person_limit) values ($1, $2, 'open', $3)", [floor, next, limit]);
  return { floor, closedCycleNo: current?.cycle_no ?? null, openedCycleNo: next };
}

export async function markConfirmed(q: Queryable, planId: string, at: Date): Promise<void> {
  await q.query("update pantry_order_plans set status = 'confirmed', confirmed_at = $2 where id = $1", [planId, at]);
}
