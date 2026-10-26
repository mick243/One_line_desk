import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../core/db';
import { createTestDb } from '../../core/db/test-db';
import { listOpenBundles } from './bundles';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`
    insert into pantry_catalog (id, name, unit_price, pack_unit) values ('cat-coke-zero', '코카콜라 제로 355', 900, 24);
    insert into pantry_cards (id, floor, item_name, catalog_item_id, author_pseudonym_id) values
      (1, '3층', '제로콜라', null, 'p_a'),
      (2, '3층', '코카콜라 제로 355', 'cat-coke-zero', 'p_b'),
      (3, '3층', '녹차 티백', null, 'p_c'),
      (4, '5층', '제로콜라', null, 'p_d');
    insert into pantry_votes (pseudonym_id, card_id) values ('p_a', 1), ('p_b', 2), ('p_a', 2), ('p_x', 1), ('p_c', 3), ('p_d', 4);
  `);
});
afterAll(async () => {
  await db.close();
});

describe('묶음과 표 셈(ADR-07)', () => {
  it('합치기 전에는 카드마다 따로 세요', async () => {
    const bundles = await listOpenBundles(db, '3층');
    expect(bundles.map((b) => [b.name, b.votes])).toEqual([
      ['코카콜라 제로 355', 2],
      ['제로콜라', 2],
      ['녹차 티백', 1],
    ]);
  });

  it('[I1] 합치면 묶음 안 서로 다른 사람 수로 세고, 되돌리면 그대로예요', async () => {
    await db.query("insert into pantry_merges (id, merged_card_id, representative_card_id, facilities_pseudonym_id) values (1, 1, 2, 'p_f')");
    const merged = await listOpenBundles(db, '3층');
    expect(merged[0]).toMatchObject({ bundleId: 2, name: '코카콜라 제로 355', votes: 3, cardIds: [1, 2], unitPrice: 900, packUnit: 24 });

    await db.query('update pantry_merges set reverted_at = now() where id = 1');
    const reverted = await listOpenBundles(db, '3층');
    expect(reverted.find((b) => b.bundleId === 1)?.votes).toBe(2);
    expect(reverted.find((b) => b.bundleId === 2)?.votes).toBe(2);
  });

  it('층을 넘지 않아요', async () => {
    expect((await listOpenBundles(db, '5층')).map((b) => b.bundleId)).toEqual([4]);
    expect(await listOpenBundles(db)).toHaveLength(4);
  });
});
