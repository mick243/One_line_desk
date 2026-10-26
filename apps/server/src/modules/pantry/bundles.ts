import type { Queryable } from '../../core/db';

// 묶음(ADR-07): 되돌리지 않은 합치기 기록으로 이은 카드들. 대표는 카탈로그에 맞춘 카드, 같으면 먼저 만든 카드예요.
// 셈: 묶음 표 = 묶음 안 카드들에 표를 준 서로 다른 사람 수(사람 × 묶음, I1).
// 판(board)과 주문안(order)이 같이 쓰는 약속이에요. 판 에이전트가 맡고, 주문안 에이전트는 읽기만 해요.

export interface Bundle {
  /** 대표 카드 ID */
  bundleId: number;
  floor: string;
  /** 대표 카드의 품목 이름 */
  name: string;
  catalogItemId: string | null;
  unitPrice: number | null;
  packUnit: number | null;
  /** 서로 다른 사람 수 */
  votes: number;
  cardIds: number[];
  /** 합치기·되돌리기 때만 올라가요(R3) */
  bundleVersion: number;
  createdAt: string;
}

/**
 * 열린 카드를 묶음으로 모아 표를 세요. floor가 없으면 모든 층이에요.
 * 합치기 연결은 merged_card_id → representative_card_id 방향이고 순환이 없어요(I5).
 */
export async function listOpenBundles(q: Queryable, floor?: string): Promise<Bundle[]> {
  const { rows } = await q.query<{
    bundle_id: number;
    floor: string;
    name: string;
    catalog_item_id: string | null;
    unit_price: number | null;
    pack_unit: number | null;
    votes: number;
    card_ids: number[];
    bundle_version: number;
    created_at: Date;
  }>(
    `with recursive edges as (
       select merged_card_id as card_id, representative_card_id as parent
         from pantry_merges where reverted_at is null
     ),
     roots as (
       select c.id as card_id, c.id as root from pantry_cards c
        where c.state = 'open' and not exists (select 1 from edges e where e.card_id = c.id)
       union all
       select e.card_id, r.root from edges e join roots r on e.parent = r.card_id
     )
     select rep.id as bundle_id, rep.floor, rep.item_name as name, rep.catalog_item_id,
            cat.unit_price, cat.pack_unit, rep.bundle_version, rep.created_at,
            array_agg(distinct r.card_id order by r.card_id) as card_ids,
            count(distinct v.pseudonym_id)::int as votes
       from roots r
       join pantry_cards rep on rep.id = r.root
       join pantry_cards member on member.id = r.card_id and member.state = 'open'
       left join pantry_votes v on v.card_id = r.card_id
       left join pantry_catalog cat on cat.id = rep.catalog_item_id
      where ($1::text is null or rep.floor = $1)
      group by rep.id, rep.floor, rep.item_name, rep.catalog_item_id, cat.unit_price, cat.pack_unit, rep.bundle_version, rep.created_at
      order by votes desc, rep.created_at desc, rep.id desc`,
    [floor ?? null],
  );
  return rows.map((r) => ({
    bundleId: Number(r.bundle_id),
    floor: r.floor,
    name: r.name,
    catalogItemId: r.catalog_item_id,
    unitPrice: r.unit_price,
    packUnit: r.pack_unit,
    votes: r.votes,
    cardIds: r.card_ids.map(Number),
    bundleVersion: r.bundle_version,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

// ── 판(board)이 더 쓰는 묶음 함수. listOpenBundles의 반환 모양(Bundle)은 그대로 둬요. ──

/** 되돌리지 않은 합치기를 따라 위로 올라가 묶음 대표(뿌리) 카드 ID를 찾아요. 카드가 없으면 null이에요. */
export async function findBundleRoot(q: Queryable, cardId: number): Promise<number | null> {
  const { rows } = await q.query<{ id: number }>(
    `with recursive up(id, depth) as (
       select id, 0 from pantry_cards where id = $1
       union all
       select m.representative_card_id, up.depth + 1
         from pantry_merges m join up on m.merged_card_id = up.id
        where m.reverted_at is null and up.depth < 1000
     )
     select id from up order by depth desc limit 1`,
    [cardId],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** 묶음(뿌리) 안 카드 ID들. 뿌리 자신을 포함해요. */
export async function bundleMemberIds(q: Queryable, rootId: number): Promise<number[]> {
  const { rows } = await q.query<{ id: number }>(
    `with recursive down(id) as (
       select $1::bigint
       union all
       select m.merged_card_id from pantry_merges m join down on m.representative_card_id = down.id where m.reverted_at is null
     )
     select id from down order by id`,
    [rootId],
  );
  return rows.map((r) => Number(r.id));
}

/** 카드 → 묶음 뿌리. 열림·주문됨 카드 모두예요. floor가 있으면 그 층 뿌리만이에요. */
export async function cardRoots(q: Queryable, floor?: string): Promise<Map<number, number>> {
  const { rows } = await q.query<{ card_id: number; root: number }>(
    `with recursive edges as (
       select merged_card_id as card_id, representative_card_id as parent from pantry_merges where reverted_at is null
     ),
     roots as (
       select c.id as card_id, c.id as root from pantry_cards c
        where not exists (select 1 from edges e where e.card_id = c.id) and ($1::text is null or c.floor = $1)
       union all
       select e.card_id, r.root from edges e join roots r on e.parent = r.card_id
     )
     select card_id, root from roots`,
    [floor ?? null],
  );
  return new Map(rows.map((r) => [Number(r.card_id), Number(r.root)]));
}

/** 열린 묶음 중 이 사람 표가 있는 묶음 수(R14 상한). 넘어온 표·작성자 표도 들어가요. 모든 층을 세요. */
export async function countVotedOpenBundles(q: Queryable, pseudonymId: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `with recursive edges as (
       select merged_card_id as card_id, representative_card_id as parent from pantry_merges where reverted_at is null
     ),
     roots as (
       select c.id as card_id, c.id as root from pantry_cards c
        where c.state = 'open' and not exists (select 1 from edges e where e.card_id = c.id)
       union all
       select e.card_id, r.root from edges e join roots r on e.parent = r.card_id
     )
     select count(distinct r.root)::int as n
       from roots r
       join pantry_cards member on member.id = r.card_id and member.state = 'open'
       join pantry_votes v on v.card_id = r.card_id
      where v.pseudonym_id = $1`,
    [pseudonymId],
  );
  return rows[0]?.n ?? 0;
}
