import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './test-db';
import type { Db } from './types';

// 공통 인덱스(11/3, 010_core·310_rooms). 회의실 채팅 영수증 찾기와 보관 지우기가 인덱스를 써요.

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

/** 줄이 적으면 늘 표 전체를 읽어서, 전체 읽기를 끄고 인덱스를 쓸 수 있는지만 봐요. */
async function plan(sql: string, params: unknown[]): Promise<string> {
  return db.tx(async (q) => {
    await q.query('set local enable_seqscan = off');
    const { rows } = await q.query<{ 'QUERY PLAN': string }>(`explain ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
}

describe('공통 인덱스', () => {
  it('보관 지우기에 쓰는 칸마다 인덱스가 있어요', async () => {
    const { rows } = await db.query<{ indexname: string }>('select indexname from pg_indexes where schemaname = current_schema()');
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'action_receipts_person',
        'action_receipts_created',
        'plans_created',
        'ai_usage_at',
        'notifications_created',
        'room_reservation_history_cancelled',
      ]),
    );
  });

  it('회의실 채팅 영수증은 가명 ID 인덱스로 찾아요', async () => {
    const text = await plan(
      'select result from action_receipts where pseudonym_id = $1 and starts_with(idempotency_key, $2) order by created_at, idempotency_key',
      ['p_a', 'auto:p_a:r1:'],
    );
    expect(text).toContain('action_receipts_person');
  });

  it.each([
    ['action_receipts', 'created_at', 'action_receipts_created'],
    ['ai_usage', 'at', 'ai_usage_at'],
    ['notifications', 'created_at', 'notifications_created'],
    ['room_reservation_history', 'cancelled_at', 'room_reservation_history_cancelled'],
  ])('%s 지우기(%s < 기준)는 %s를 써요', async (table, column, index) => {
    expect(await plan(`delete from ${table} where ${column} < $1`, [new Date().toISOString()])).toContain(index);
  });
});
