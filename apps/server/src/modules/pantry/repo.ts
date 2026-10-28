import type { Queryable } from '../../core/db';

// 같이 채워요 판 SQL(ADR-07). 값은 늘 매개변수로 넘겨요. 투표자(가명 ID)는 여기서 멈추고 응답에는 수만 나가요.

export interface CardRow {
  id: number;
  floor: string;
  itemName: string;
  catalogItemId: string | null;
  state: 'open' | 'ordered';
  bundleVersion: number;
  createdAt: string;
  postedCycleNo: number | null;
}

interface RawCard {
  id: number;
  floor: string;
  item_name: string;
  catalog_item_id: string | null;
  state: 'open' | 'ordered';
  bundle_version: number;
  created_at: Date | string;
  posted_cycle_no: number | null;
}

const CARD_COLUMNS = 'id, floor, item_name, catalog_item_id, state, bundle_version, created_at, posted_cycle_no';

function toCard(r: RawCard): CardRow {
  return {
    id: Number(r.id),
    floor: r.floor,
    itemName: r.item_name,
    catalogItemId: r.catalog_item_id,
    state: r.state,
    bundleVersion: Number(r.bundle_version),
    createdAt: new Date(r.created_at).toISOString(),
    postedCycleNo: r.posted_cycle_no === null ? null : Number(r.posted_cycle_no),
  };
}

/** 사람 단위 잠금(R3). 같은 사람의 표 쓰기(게시·+1·거두기)를 차례로 처리해요. 트랜잭션이 끝나면 풀려요. */
export async function lockPerson(q: Queryable, pseudonymId: string): Promise<void> {
  await q.query('select pg_advisory_xact_lock(hashtext($1))', [pseudonymId]);
}

export async function cardsByIds(q: Queryable, ids: number[]): Promise<CardRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await q.query<RawCard>(`select ${CARD_COLUMNS} from pantry_cards where id = any($1::bigint[]) order by id`, [ids]);
  return rows.map(toCard);
}

/** 합치기·되돌리기·주문안 확정: 관련 카드 행을 ID 순서로 잠가요(R3). 셋이 같은 순서로 잠가서 교착 없이 한쪽이 기다려요. */
export async function lockCards(q: Queryable, ids: number[]): Promise<CardRow[]> {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const { rows } = await q.query<RawCard>(`select ${CARD_COLUMNS} from pantry_cards where id = any($1::bigint[]) order by id for update`, [sorted]);
  return rows.map(toCard);
}

/**
 * +1·거두기·게시: 묶음 대표 카드를 나눔 잠금(FOR SHARE)으로 ID 순서대로 잡아요(M2, ADR-07 I6).
 * 주문안 확정·합치기·되돌리기(FOR UPDATE)가 끝날 때까지 기다린 뒤 끝난 상태를 읽어서, 주문됨 묶음에 표가 생기지 않아요.
 * 표 쓰기끼리는 서로 막지 않고, 합치기와는 기다림만 생겨요(409 없음, I8).
 */
export async function shareLockCards(q: Queryable, ids: number[]): Promise<CardRow[]> {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const { rows } = await q.query<RawCard>(`select ${CARD_COLUMNS} from pantry_cards where id = any($1::bigint[]) order by id for share`, [sorted]);
  return rows.map(toCard);
}

/** 이 카드가 지금 다른 카드에 묶여 있는지(뿌리가 아닌지) */
export async function isMergedAway(q: Queryable, cardId: number): Promise<boolean> {
  const { rows } = await q.query('select 1 from pantry_merges where merged_card_id = $1 and reverted_at is null', [cardId]);
  return rows.length > 0;
}

export async function insertCard(
  q: Queryable,
  c: { floor: string; itemName: string; catalogItemId: string | null; authorPseudonymId: string; postedCycleNo: number; postKey: string; createdAt: string },
): Promise<number | null> {
  const { rows } = await q.query<{ id: number }>(
    `insert into pantry_cards (floor, item_name, catalog_item_id, author_pseudonym_id, posted_cycle_no, post_key, created_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (post_key) do nothing
     returning id`,
    [c.floor, c.itemName, c.catalogItemId, c.authorPseudonymId, c.postedCycleNo, c.postKey, c.createdAt],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export async function insertVote(q: Queryable, pseudonymId: string, cardId: number, at: string): Promise<boolean> {
  const { rows } = await q.query('insert into pantry_votes (pseudonym_id, card_id, created_at) values ($1, $2, $3) on conflict do nothing returning card_id', [
    pseudonymId,
    cardId,
    at,
  ]);
  return rows.length > 0;
}

/** 거두기: 그 사람이 묶음 안에 가진 표를 모두 지워요(I4). */
export async function deleteVotes(q: Queryable, pseudonymId: string, cardIds: number[]): Promise<number> {
  if (cardIds.length === 0) return 0;
  const { rows } = await q.query('delete from pantry_votes where pseudonym_id = $1 and card_id = any($2::bigint[]) returning card_id', [pseudonymId, cardIds]);
  return rows.length;
}

/** 이 사람이 표를 준 카드 ID(주어진 카드 안에서). 화면에는 "내 표 있음"으로만 나가요. */
export async function myVotedCardIds(q: Queryable, pseudonymId: string, cardIds: number[]): Promise<number[]> {
  if (cardIds.length === 0) return [];
  const { rows } = await q.query<{ card_id: number }>('select card_id from pantry_votes where pseudonym_id = $1 and card_id = any($2::bigint[])', [
    pseudonymId,
    cardIds,
  ]);
  return rows.map((r) => Number(r.card_id));
}

/** 카드들에 표를 준 서로 다른 사람 수(I1) */
export async function distinctVoters(q: Queryable, cardIds: number[]): Promise<number> {
  if (cardIds.length === 0) return 0;
  const { rows } = await q.query<{ n: number }>('select count(distinct pseudonym_id)::int as n from pantry_votes where card_id = any($1::bigint[])', [cardIds]);
  return rows[0]?.n ?? 0;
}

/** 내가 표를 준 카드(열림·주문됨). S6 "내 요청"에 써요. */
export async function myVoteCards(q: Queryable, pseudonymId: string): Promise<{ cardId: number; floor: string; state: 'open' | 'ordered' }[]> {
  const { rows } = await q.query<{ card_id: number; floor: string; state: 'open' | 'ordered' }>(
    'select c.id as card_id, c.floor, c.state from pantry_votes v join pantry_cards c on c.id = v.card_id where v.pseudonym_id = $1',
    [pseudonymId],
  );
  return rows.map((r) => ({ cardId: Number(r.card_id), floor: r.floor, state: r.state }));
}

export async function bumpVersions(q: Queryable, ids: number[]): Promise<void> {
  await q.query('update pantry_cards set bundle_version = bundle_version + 1 where id = any($1::bigint[])', [[...new Set(ids)]]);
}

export async function insertMerge(
  q: Queryable,
  mergedCardId: number,
  representativeCardId: number,
  facilitiesPseudonymId: string,
  at: string,
): Promise<number> {
  const { rows } = await q.query<{ id: number }>(
    'insert into pantry_merges (merged_card_id, representative_card_id, facilities_pseudonym_id, merged_at) values ($1, $2, $3, $4) returning id',
    [mergedCardId, representativeCardId, facilitiesPseudonymId, at],
  );
  return Number(rows[0]!.id);
}

export interface MergeRow {
  id: number;
  mergedCardId: number;
  representativeCardId: number;
  mergedAt: string;
  revertedAt: string | null;
}

export async function lockMerge(q: Queryable, mergeId: number): Promise<MergeRow | null> {
  const { rows } = await q.query<{ id: number; merged_card_id: number; representative_card_id: number; merged_at: Date; reverted_at: Date | null }>(
    'select id, merged_card_id, representative_card_id, merged_at, reverted_at from pantry_merges where id = $1 for update',
    [mergeId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    mergedCardId: Number(r.merged_card_id),
    representativeCardId: Number(r.representative_card_id),
    mergedAt: new Date(r.merged_at).toISOString(),
    revertedAt: r.reverted_at ? new Date(r.reverted_at).toISOString() : null,
  };
}

export async function revertMerge(q: Queryable, mergeId: number, at: string): Promise<boolean> {
  const { rows } = await q.query('update pantry_merges set reverted_at = $2 where id = $1 and reverted_at is null returning id', [mergeId, at]);
  return rows.length > 0;
}

/** 되돌리지 않은 합치기 기록(이 층, 열린 카드). 합친 총무는 내보내지 않아요. */
export async function activeMerges(
  q: Queryable,
  floor: string,
): Promise<{ id: number; mergedAt: string; representativeName: string; mergedName: string; representativeCardId: number }[]> {
  const { rows } = await q.query<{ id: number; merged_at: Date; rep_name: string; merged_name: string; rep_id: number }>(
    `select m.id, m.merged_at, rep.item_name as rep_name, merged.item_name as merged_name, rep.id as rep_id
       from pantry_merges m
       join pantry_cards rep on rep.id = m.representative_card_id
       join pantry_cards merged on merged.id = m.merged_card_id
      where m.reverted_at is null and merged.floor = $1 and merged.state = 'open'
      order by m.merged_at desc, m.id desc`,
    [floor],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    mergedAt: new Date(r.merged_at).toISOString(),
    representativeName: r.rep_name,
    mergedName: r.merged_name,
    representativeCardId: Number(r.rep_id),
  }));
}

export interface FlagRow {
  cardA: number;
  cardB: number;
  source: 'ai' | 'rule';
  state: 'showing' | 'merged' | 'kept-apart';
}

/** 주어진 카드가 한쪽이라도 든 "같은 상품 같아요" 표시 행 */
export async function flagsTouching(q: Queryable, cardIds: number[], states?: FlagRow['state'][]): Promise<FlagRow[]> {
  if (cardIds.length === 0) return [];
  const { rows } = await q.query<{ card_a: number; card_b: number; source: 'ai' | 'rule'; state: FlagRow['state'] }>(
    `select card_a, card_b, source, state from pantry_similar_flags
      where (card_a = any($1::bigint[]) or card_b = any($1::bigint[])) and ($2::text[] is null or state = any($2::text[]))`,
    [cardIds, states ?? null],
  );
  return rows.map((r) => ({ cardA: Number(r.card_a), cardB: Number(r.card_b), source: r.source, state: r.state }));
}

export async function insertFlag(q: Queryable, a: number, b: number, source: 'ai' | 'rule'): Promise<void> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  if (lo === hi) return;
  await q.query('insert into pantry_similar_flags (card_a, card_b, source) values ($1, $2, $3) on conflict do nothing', [lo, hi, source]);
}

export async function setFlagState(q: Queryable, pairs: [number, number][], state: FlagRow['state']): Promise<void> {
  for (const [a, b] of pairs) {
    await q.query('update pantry_similar_flags set state = $3 where card_a = $1 and card_b = $2', [Math.min(a, b), Math.max(a, b), state]);
  }
}

export interface CatalogRow {
  id: string;
  name: string;
  unitPrice: number;
  packUnit: number;
  aliases: string[];
}

export async function catalog(q: Queryable): Promise<CatalogRow[]> {
  const { rows } = await q.query<{ id: string; name: string; unit_price: number; pack_unit: number; aliases: string[] }>(
    'select id, name, unit_price, pack_unit, aliases from pantry_catalog order by id',
  );
  return rows.map((r) => ({ id: r.id, name: r.name, unitPrice: r.unit_price, packUnit: r.pack_unit, aliases: r.aliases }));
}

export async function insertCatalogItem(q: Queryable, c: CatalogRow): Promise<void> {
  await q.query('insert into pantry_catalog (id, name, unit_price, pack_unit, aliases) values ($1, $2, $3, $4, $5) on conflict (id) do nothing', [
    c.id,
    c.name,
    c.unitPrice,
    c.packUnit,
    c.aliases,
  ]);
}

export interface FloorSettingRow {
  floor: string;
  minShareWon: number;
  perPersonLimit: number;
  cycleNote: string;
}

export async function floorSettings(q: Queryable): Promise<FloorSettingRow[]> {
  const { rows } = await q.query<{ floor: string; min_share_won: number; per_person_limit: number; cycle_note: string }>(
    `select f.floor, coalesce(s.min_share_won, 0) as min_share_won, coalesce(s.per_person_limit, 5) as per_person_limit, coalesce(s.cycle_note, '') as cycle_note
       from (select floor from pantry_floor_settings union select floor from pantry_cycles) f
       left join pantry_floor_settings s on s.floor = f.floor
      order by length(f.floor), f.floor`,
  );
  return rows.map((r) => ({ floor: r.floor, minShareWon: r.min_share_won, perPersonLimit: r.per_person_limit, cycleNote: r.cycle_note }));
}

export async function floorSetting(q: Queryable, floor: string): Promise<FloorSettingRow | null> {
  const { rows } = await q.query<{ floor: string; min_share_won: number; per_person_limit: number; cycle_note: string }>(
    'select floor, min_share_won, per_person_limit, cycle_note from pantry_floor_settings where floor = $1',
    [floor],
  );
  const r = rows[0];
  return r ? { floor: r.floor, minShareWon: r.min_share_won, perPersonLimit: r.per_person_limit, cycleNote: r.cycle_note } : null;
}

/** 층 설정이 없을 때만 기본값을 넣어요(seed·첫 게시). */
export async function insertFloorSettingIfMissing(q: Queryable, s: FloorSettingRow): Promise<void> {
  await q.query(
    'insert into pantry_floor_settings (floor, min_share_won, per_person_limit, cycle_note) values ($1, $2, $3, $4) on conflict (floor) do nothing',
    [s.floor, s.minShareWon, s.perPersonLimit, s.cycleNote],
  );
}

/** 총무가 S4 설정에서 바꿔요. */
export async function saveFloorSetting(q: Queryable, s: FloorSettingRow): Promise<void> {
  await q.query(
    `insert into pantry_floor_settings (floor, min_share_won, per_person_limit, cycle_note) values ($1, $2, $3, $4)
     on conflict (floor) do update set min_share_won = excluded.min_share_won, per_person_limit = excluded.per_person_limit, cycle_note = excluded.cycle_note`,
    [s.floor, s.minShareWon, s.perPersonLimit, s.cycleNote],
  );
}

/** 이 층의 열린 주기 번호. 없으면 null이에요. */
export async function openCycleNo(q: Queryable, floor: string): Promise<number | null> {
  const { rows } = await q.query<{ cycle_no: number }>(
    "select cycle_no from pantry_cycles where floor = $1 and state = 'open' order by cycle_no desc limit 1",
    [floor],
  );
  return rows[0] ? Number(rows[0].cycle_no) : null;
}

/** 열린 주기가 없으면 다음 번호로 열어요(게시 트랜잭션 안에서만 불러요). */
export async function ensureOpenCycle(q: Queryable, floor: string, perPersonLimit: number): Promise<number> {
  const open = await openCycleNo(q, floor);
  if (open !== null) return open;
  await q.query(
    `insert into pantry_cycles (floor, cycle_no, state, per_person_limit)
     select $1, coalesce(max(cycle_no), 0) + 1, 'open', $2 from pantry_cycles where floor = $1
     on conflict do nothing`,
    [floor, perPersonLimit],
  );
  return (await openCycleNo(q, floor)) ?? 1;
}

/** 총무가 표 상한을 바꾸면 열린 주기의 상한도 같이 맞춰요(주기 표의 1인 품목 수 상한, ADR-07). */
export async function setOpenCycleLimit(q: Queryable, floor: string, perPersonLimit: number): Promise<void> {
  await q.query("update pantry_cycles set per_person_limit = $2 where floor = $1 and state = 'open'", [floor, perPersonLimit]);
}

/** 가장 최근 주문안 확정 때 '주문됨'이 된 카드들(이 층). S3 지난 주기 결과에 써요. */
export async function latestOrderedBatch(q: Queryable, floor: string): Promise<CardRow[]> {
  const { rows } = await q.query<RawCard>(
    `select ${CARD_COLUMNS} from pantry_cards
      where floor = $1 and state = 'ordered'
        and ordered_batch_at = (select max(ordered_batch_at) from pantry_cards where floor = $1 and state = 'ordered')
      order by id`,
    [floor],
  );
  return rows.map(toCard);
}

/** 이 층에서 가장 최근 주문 묶음 시각. 없으면 null이에요. */
export async function latestOrderedBatchAt(q: Queryable, floor: string): Promise<string | null> {
  const { rows } = await q.query<{ at: Date | null }>("select max(ordered_batch_at) as at from pantry_cards where floor = $1 and state = 'ordered'", [floor]);
  return rows[0]?.at ? new Date(rows[0].at).toISOString() : null;
}

export async function cardBatchAt(q: Queryable, ids: number[]): Promise<Map<number, string | null>> {
  if (ids.length === 0) return new Map();
  const { rows } = await q.query<{ id: number; ordered_batch_at: Date | null }>('select id, ordered_batch_at from pantry_cards where id = any($1::bigint[])', [
    ids,
  ]);
  return new Map(rows.map((r) => [Number(r.id), r.ordered_batch_at ? new Date(r.ordered_batch_at).toISOString() : null]));
}

export async function countCards(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('select count(*)::int as n from pantry_cards');
  return rows[0]?.n ?? 0;
}

/**
 * 보관 기간(7일, 10/28)이 지난 같이 채워요 기록을 지워요. 서버가 한 시간마다 트랜잭션 안에서 불러요.
 * - 주문안: 확정안은 확정한 지 7일, 초안·바뀐 안은 만든 지 7일. 지울 요청이 들어 있는 초안·바뀐 안도 지워요(총무가 다시 만들어요).
 * - 요청 카드: 열린 요청은 올린 지 7일, 주문된 요청은 주문 확정 7일 뒤. 표·합치기·같은 상품 표시도 같이 지워요.
 *   남은 확정 주문안에 줄이 있는 카드(예산 초과로 빠진 요청 등)는 그 주문안이 지워질 때 같이 지워져요.
 * 묶음에서 한쪽만 지워지면 남은 카드의 묶음 번호를 올려서, 그 묶음을 담은 주문안이 바뀐 걸 알게 해요.
 */
export async function purgeRecords(q: Queryable, before: number): Promise<void> {
  const at = new Date(before).toISOString();
  const expired = "((c.state = 'open' and c.created_at < $1) or (c.state = 'ordered' and coalesce(c.ordered_batch_at, c.created_at) < $1))";

  const plans = await q.query<{ id: string }>(
    `select p.id from pantry_order_plans p
      where coalesce(p.confirmed_at, p.created_at) < $1
         or (p.status <> 'confirmed' and exists (
               select 1 from pantry_order_lines l join pantry_cards c on c.id = l.bundle_id where l.plan_id = p.id and ${expired}))`,
    [at],
  );
  const planIds = plans.rows.map((r) => r.id);
  if (planIds.length > 0) {
    await q.query('delete from pantry_order_lines where plan_id = any($1::uuid[])', [planIds]);
    await q.query('delete from pantry_order_plans where id = any($1::uuid[])', [planIds]);
  }

  const cards = await q.query<{ id: number }>(
    `select c.id from pantry_cards c where ${expired} and not exists (select 1 from pantry_order_lines l where l.bundle_id = c.id)`,
    [at],
  );
  const ids = cards.rows.map((r) => Number(r.id));
  if (ids.length === 0) return;
  const gone = new Set(ids);
  await q.query('delete from pantry_similar_flags where card_a = any($1::bigint[]) or card_b = any($1::bigint[])', [ids]);
  const merges = await q.query<{ merged_card_id: number; representative_card_id: number }>(
    'delete from pantry_merges where merged_card_id = any($1::bigint[]) or representative_card_id = any($1::bigint[]) returning merged_card_id, representative_card_id',
    [ids],
  );
  const touched = merges.rows.flatMap((m) => [Number(m.merged_card_id), Number(m.representative_card_id)]).filter((id) => !gone.has(id));
  if (touched.length > 0) await bumpVersions(q, touched);
  await q.query('delete from pantry_votes where card_id = any($1::bigint[])', [ids]);
  await q.query('delete from pantry_cards where id = any($1::bigint[])', [ids]);
}
