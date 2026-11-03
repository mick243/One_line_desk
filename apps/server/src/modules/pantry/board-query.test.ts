import { afterEach, describe, expect, it } from 'vitest';
import type { Db, Queryable } from '../../core/db/types';
import { createTestApp } from '../../testing';
import { countVotedOpenBundles, listOpenBundles, bundleRootsOf } from './bundles';
import { createBoardService } from './service';
import { fakeUser } from './test-kit';

// 판 조회 줄이기(11/03): 재귀 시작 행에 층 조건, 루트 계산은 필요한 카드만, 표 상한 셈은 그 사람 표에서 위로.
// 묶음 셈(ADR-07 I1)과 판 응답이 바꾸기 전과 같아야 해요. 바꾸기 전 SQL을 아래에 그대로 두고 견줘요.
// 가상 자료(등급 0)만 써요. 품목 이름·가명 ID는 지어낸 것이에요.

type Test = Awaited<ReturnType<typeof createTestApp>>;

const opened: Test[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

// ── 바꾸기 전 SQL(f2b737d bundles.ts) ─────────────────────────────────────────

async function legacyListOpenBundles(q: Queryable, floor?: string) {
  const { rows } = await q.query<{ bundle_id: number; floor: string; name: string; votes: number; card_ids: number[]; bundle_version: number }>(
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
  return rows.map((r) => ({ bundleId: Number(r.bundle_id), floor: r.floor, name: r.name, votes: r.votes, cardIds: r.card_ids.map(Number) }));
}

/** 카드 → 묶음 뿌리(층 전체). 바꾼 뒤에는 rootsOf가 필요한 카드만 구해요. */
async function legacyCardRoots(q: Queryable, floor?: string): Promise<Map<number, number>> {
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

async function legacyCountVoted(q: Queryable, pseudonymId: string): Promise<number> {
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

// ── 가상 판: 여러 층, 두 단 합치기, 되돌린 합치기, 주문된 묶음, 주문된 대표에 묶인 열린 카드, 다른 층 카드가 묶인 묶음 ──

const SCENE = `
  update pantry_cycles set state = 'closed' where floor = '3층';
  insert into pantry_cycles (floor, cycle_no, state, per_person_limit) values ('3층', 2, 'open', 5);
  insert into pantry_cards (id, floor, item_name, catalog_item_id, author_pseudonym_id, state, posted_cycle_no, created_at, ordered_batch_at) values
    (101, '3층', '코카콜라 제로 355', 'cat-coke-zero', 'p_a', 'open', 1, '2026-11-02T01:00:00Z', null),
    (102, '3층', '제로 콜라 캔', 'cat-coke-zero', 'p_b', 'open', 2, '2026-11-02T01:01:00Z', null),
    (103, '3층', '콜라 제로', null, 'p_c', 'open', 2, '2026-11-02T01:02:00Z', null),
    (104, '3층', '녹차 티백', 'cat-green-tea', 'p_d', 'open', 2, '2026-11-02T01:03:00Z', null),
    (105, '3층', '녹차', null, 'p_e', 'open', 2, '2026-11-02T01:04:00Z', null),
    (106, '3층', '탄산수', 'cat-sparkling', 'p_f', 'open', 2, '2026-11-02T01:05:00Z', null),
    (107, '3층', '우유', 'cat-milk', 'p_a', 'ordered', 1, '2026-11-01T01:00:00Z', '2026-11-01T09:00:00Z'),
    (108, '3층', '흰 우유', 'cat-milk', 'p_b', 'ordered', 1, '2026-11-01T02:00:00Z', '2026-11-02T00:00:00Z'),
    (109, '3층', '우유 큰 팩', null, 'p_c', 'ordered', 1, '2026-11-01T02:01:00Z', '2026-11-02T00:00:00Z'),
    (110, '3층', '사이다', 'cat-cider', 'p_d', 'ordered', 1, '2026-11-01T02:02:00Z', '2026-11-02T00:00:00Z'),
    (111, '3층', '사이다 제로', null, 'p_e', 'open', 2, '2026-11-02T01:06:00Z', null),
    (112, '3층', '바나나', 'cat-banana', 'p_f', 'open', 2, '2026-11-02T01:07:00Z', null),
    (201, '5층', '원두', 'cat-coffee-beans', 'p_g', 'open', 1, '2026-11-02T02:00:00Z', null),
    (202, '5층', '커피믹스', 'cat-coffee-mix', 'p_h', 'open', 1, '2026-11-02T02:01:00Z', null),
    (203, '5층', '종이컵', 'cat-paper-cup', 'p_g', 'ordered', 1, '2026-11-01T03:00:00Z', '2026-11-02T00:30:00Z'),
    (204, '5층', '탄산수 큰 병', null, 'p_h', 'open', 1, '2026-11-02T02:02:00Z', null),
    (301, '2층', '종이컵', 'cat-paper-cup', 'p_i', 'open', 1, '2026-11-02T03:00:00Z', null);
  select setval(pg_get_serial_sequence('pantry_cards', 'id'), 400);
  insert into pantry_merges (merged_card_id, representative_card_id, facilities_pseudonym_id, merged_at, reverted_at) values
    (102, 101, 'p_fac', '2026-11-02T04:00:00Z', null),
    (103, 102, 'p_fac', '2026-11-02T04:01:00Z', null),
    (105, 104, 'p_fac', '2026-11-02T04:02:00Z', '2026-11-02T04:03:00Z'),
    (109, 108, 'p_fac', '2026-11-01T05:00:00Z', null),
    (111, 110, 'p_fac', '2026-11-02T04:04:00Z', null),
    (202, 201, 'p_fac', '2026-11-02T04:05:00Z', null),
    (204, 106, 'p_fac', '2026-11-02T04:06:00Z', null);
  insert into pantry_similar_flags (card_a, card_b, source, state) values
    (104, 105, 'rule', 'showing'),
    (101, 106, 'ai', 'showing'),
    (106, 112, 'rule', 'kept-apart'),
    (201, 202, 'rule', 'merged');
  insert into pantry_votes (pseudonym_id, card_id) values
    ('p_a', 101), ('p_b', 102), ('p_c', 103), ('p_a', 103), ('p_test_me', 101), ('p_test_me', 103),
    ('p_d', 104), ('p_e', 105), ('p_test_me', 105),
    ('p_f', 106), ('p_h', 204), ('p_f', 204),
    ('p_a', 107), ('p_b', 108), ('p_c', 109), ('p_d', 110), ('p_e', 111), ('p_test_me', 111),
    ('p_f', 112),
    ('p_g', 201), ('p_h', 202), ('p_test_me', 202), ('p_test_five', 201), ('p_test_five', 202),
    ('p_g', 203), ('p_i', 301);
`;

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  const svc = createBoardService(t.ctx);
  await svc.seed({ demoCards: false });
  await t.db.exec(SCENE);
  return { t, svc };
}

/** 트랜잭션 안에서 부른 SQL 수를 세요(begin·commit 빼고). */
function countQueries(db: Db) {
  const real = db.tx.bind(db);
  const counter = { n: 0, recursive: 0 };
  (db as { tx: Db['tx'] }).tx = (fn) =>
    real((q) =>
      fn({
        query: (sql, params) => {
          counter.n += 1;
          if (/with recursive/i.test(sql)) counter.recursive += 1;
          return q.query(sql, params);
        },
      }),
    );
  return counter;
}

const me = fakeUser('me');
const five = fakeUser('five', { floor: '5층' });
const fac = fakeUser('fac', { facilities: true });

describe('판 조회 줄이기: 묶음 셈과 판 응답은 그대로예요', () => {
  it('[ADR-07 시험] 층을 거른 listOpenBundles = 바꾸기 전 SQL(여러 층·두 단 합치기·되돌린 합치기·주문된 대표)', async () => {
    const { t } = await setup();
    for (const floor of [undefined, '2층', '3층', '4층', '5층']) {
      const now = (await listOpenBundles(t.db, floor)).map((b) => ({ bundleId: b.bundleId, floor: b.floor, name: b.name, votes: b.votes, cardIds: b.cardIds }));
      expect(now, String(floor)).toEqual(await legacyListOpenBundles(t.db, floor));
    }
    // 주문된 대표(110)에 묶인 열린 카드(111)는 열린 묶음이 아니에요. 다른 층 카드(204)가 묶인 106은 3층 묶음이에요.
    const third = await listOpenBundles(t.db, '3층');
    expect(third.map((b) => b.bundleId)).not.toContain(111);
    expect(third.find((b) => b.bundleId === 106)?.cardIds).toEqual([106, 204]);
  });

  it('[ADR-07 시험·R14] 표 상한 셈(countVotedOpenBundles) = 바꾸기 전 SQL, 모든 가명 ID', async () => {
    const { t } = await setup();
    const people = (await t.db.query<{ p: string }>('select distinct pseudonym_id as p from pantry_votes order by 1')).rows.map((r) => r.p);
    for (const p of [...people, 'p_nobody']) expect(await countVotedOpenBundles(t.db, p), p).toBe(await legacyCountVoted(t.db, p));
    expect(await countVotedOpenBundles(t.db, 'p_test_me')).toBe(3);
  });

  it('[ADR-07 시험] bundleRootsOf(필요한 카드만) = 예전 cardRoots(층 전체)에서 같은 카드를 고른 값', async () => {
    const { t } = await setup();
    const ids = (await t.db.query<{ id: number }>('select id from pantry_cards order by id')).rows.map((r) => Number(r.id));
    for (const floor of [undefined, '3층', '5층']) {
      const all = await legacyCardRoots(t.db, floor);
      const some = await bundleRootsOf(t.db, ids, floor);
      expect(
        [...some.entries()].sort((a, b) => a[0] - b[0]),
        String(floor),
      ).toEqual(ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)!] as [number, number]));
    }
    expect(await bundleRootsOf(t.db, [], '3층')).toEqual(new Map());
  });

  it('[ADR-07 시험] 판 응답이 바꾸기 전과 같아요(직원 3층·5층, 총무가 2·3·5층을 봐요)', async () => {
    const { svc } = await setup();
    const boards = {
      me: await svc.board(me),
      five: await svc.board(five),
      fac3: await svc.board(fac),
      fac5: await svc.board(fac, '5층'),
      fac2: await svc.board(fac, '2층'),
    };
    // 바꾸기 전 코드(f2b737d)에서 만든 응답이에요. 묶음 셈·이름·지난 주기 결과가 그대로여야 해요.
    expect(boards).toMatchInlineSnapshot(`
      {
        "fac2": {
          "canVote": false,
          "cycleNote": "매주 금요일 오후 3시에 마감해요",
          "floor": "2층",
          "floors": [
            "2층",
            "3층",
            "4층",
            "5층",
          ],
          "items": [
            {
              "bundleId": 301,
              "bundleVersion": 0,
              "carriedOver": false,
              "catalogName": "종이컵 1000개",
              "mergedNames": [],
              "myVote": false,
              "name": "종이컵",
              "similarByAi": false,
              "similarTo": [],
              "votes": 1,
            },
          ],
          "lastCycle": {
            "carriedOver": 0,
            "ordered": [],
          },
          "limit": 5,
          "myBundleCount": 0,
        },
        "fac3": {
          "canVote": true,
          "cycleNote": "매주 금요일 오후 3시에 마감해요",
          "floor": "3층",
          "floors": [
            "2층",
            "3층",
            "4층",
            "5층",
          ],
          "items": [
            {
              "bundleId": 101,
              "bundleVersion": 0,
              "carriedOver": true,
              "catalogName": "코카콜라 제로 355",
              "mergedNames": [
                "제로 콜라 캔",
                "콜라 제로",
              ],
              "myVote": false,
              "name": "코카콜라 제로 355",
              "similarByAi": true,
              "similarTo": [
                "탄산수",
              ],
              "votes": 4,
            },
            {
              "bundleId": 106,
              "bundleVersion": 0,
              "carriedOver": true,
              "catalogName": "탄산수 500mL",
              "mergedNames": [
                "탄산수 큰 병",
              ],
              "myVote": false,
              "name": "탄산수",
              "similarByAi": true,
              "similarTo": [
                "코카콜라 제로 355",
              ],
              "votes": 2,
            },
            {
              "bundleId": 105,
              "bundleVersion": 0,
              "carriedOver": false,
              "catalogName": null,
              "mergedNames": [],
              "myVote": false,
              "name": "녹차",
              "similarByAi": false,
              "similarTo": [
                "녹차 티백",
              ],
              "votes": 2,
            },
            {
              "bundleId": 112,
              "bundleVersion": 0,
              "carriedOver": false,
              "catalogName": "바나나 1송이",
              "mergedNames": [],
              "myVote": false,
              "name": "바나나",
              "similarByAi": false,
              "similarTo": [],
              "votes": 1,
            },
            {
              "bundleId": 104,
              "bundleVersion": 0,
              "carriedOver": false,
              "catalogName": "녹차 티백 100개입",
              "mergedNames": [],
              "myVote": false,
              "name": "녹차 티백",
              "similarByAi": false,
              "similarTo": [
                "녹차",
              ],
              "votes": 1,
            },
          ],
          "lastCycle": {
            "carriedOver": 2,
            "ordered": [
              "흰 우유",
              "사이다",
            ],
          },
          "limit": 5,
          "myBundleCount": 0,
        },
        "fac5": {
          "canVote": false,
          "cycleNote": "매주 금요일 오후 3시에 마감해요",
          "floor": "5층",
          "floors": [
            "2층",
            "3층",
            "4층",
            "5층",
          ],
          "items": [
            {
              "bundleId": 201,
              "bundleVersion": 0,
              "carriedOver": false,
              "catalogName": "원두 1kg",
              "mergedNames": [
                "커피믹스",
              ],
              "myVote": false,
              "name": "원두",
              "similarByAi": false,
              "similarTo": [],
              "votes": 4,
            },
          ],
          "lastCycle": {
            "carriedOver": 0,
            "ordered": [
              "종이컵",
            ],
          },
          "limit": 5,
          "myBundleCount": 0,
        },
        "five": {
          "canVote": true,
          "cycleNote": "매주 금요일 오후 3시에 마감해요",
          "floor": "5층",
          "floors": [
            "5층",
          ],
          "items": [
            {
              "bundleId": 201,
              "bundleVersion": 0,
              "carriedOver": false,
              "catalogName": "원두 1kg",
              "mergedNames": [
                "커피믹스",
              ],
              "myVote": true,
              "name": "원두",
              "similarByAi": false,
              "similarTo": [],
              "votes": 4,
            },
          ],
          "lastCycle": {
            "carriedOver": 0,
            "ordered": [
              "종이컵",
            ],
          },
          "limit": 5,
          "myBundleCount": 1,
        },
        "me": {
          "canVote": true,
          "cycleNote": "매주 금요일 오후 3시에 마감해요",
          "floor": "3층",
          "floors": [
            "3층",
          ],
          "items": [
            {
              "bundleId": 101,
              "bundleVersion": 0,
              "carriedOver": true,
              "catalogName": "코카콜라 제로 355",
              "mergedNames": [
                "제로 콜라 캔",
                "콜라 제로",
              ],
              "myVote": true,
              "name": "코카콜라 제로 355",
              "similarByAi": true,
              "similarTo": [
                "탄산수",
              ],
              "votes": 4,
            },
            {
              "bundleId": 106,
              "bundleVersion": 0,
              "carriedOver": true,
              "catalogName": "탄산수 500mL",
              "mergedNames": [
                "탄산수 큰 병",
              ],
              "myVote": false,
              "name": "탄산수",
              "similarByAi": true,
              "similarTo": [
                "코카콜라 제로 355",
              ],
              "votes": 2,
            },
            {
              "bundleId": 105,
              "bundleVersion": 0,
              "carriedOver": false,
              "catalogName": null,
              "mergedNames": [],
              "myVote": true,
              "name": "녹차",
              "similarByAi": false,
              "similarTo": [
                "녹차 티백",
              ],
              "votes": 2,
            },
            {
              "bundleId": 112,
              "bundleVersion": 0,
              "carriedOver": false,
              "catalogName": "바나나 1송이",
              "mergedNames": [],
              "myVote": false,
              "name": "바나나",
              "similarByAi": false,
              "similarTo": [],
              "votes": 1,
            },
            {
              "bundleId": 104,
              "bundleVersion": 0,
              "carriedOver": false,
              "catalogName": "녹차 티백 100개입",
              "mergedNames": [],
              "myVote": false,
              "name": "녹차 티백",
              "similarByAi": false,
              "similarTo": [
                "녹차",
              ],
              "votes": 1,
            },
          ],
          "lastCycle": {
            "carriedOver": 2,
            "ordered": [
              "흰 우유",
              "사이다",
            ],
          },
          "limit": 5,
          "myBundleCount": 3,
        },
      }
    `);
  });

  it('[판 조회 줄이기] 판 응답 한 번에 부르는 SQL 수(직원·총무)', async () => {
    const { t, svc } = await setup();
    const counter = countQueries(t.db);
    await svc.board(me);
    const staff = { ...counter };
    counter.n = 0;
    counter.recursive = 0;
    await svc.board(fac, '5층');
    const facilities = { ...counter };
    // 바꾸기 전(f2b737d): 직원 11개·총무 12개(재귀 3번, 층 전체·모든 층을 돌았어요). begin·commit은 빼고 세요.
    // 바꾼 뒤: 재귀 3번은 이 층 뿌리·지난 주기 카드·내 표에서만 돌아요. 내 표와 상한 셈, 층 설정과 열린 주기를 한 번에 읽어요.
    expect(staff).toEqual({ n: 9, recursive: 3 });
    expect(facilities).toEqual({ n: 10, recursive: 3 });
  });
});

describe('보관 지우기 인덱스(470)', () => {
  it('[ADR-21 시험] 주문안 줄의 bundle_id와 합치기 기록의 두 카드 칸(되돌린 기록 포함)에 인덱스가 있어요', async () => {
    const t = await createTestApp();
    opened.push(t);
    const { rows } = await t.db.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where tablename in ('pantry_order_lines', 'pantry_merges') order by indexname",
    );
    const defs = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.get('pantry_order_lines_bundle')).toMatch(/\(bundle_id\)$/);
    expect(defs.get('pantry_merges_merged')).toMatch(/\(merged_card_id\)$/);
    expect(defs.get('pantry_merges_rep')).toMatch(/\(representative_card_id\)$/);
  });
});
