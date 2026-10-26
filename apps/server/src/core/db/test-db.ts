import { applyMigrations } from './migrate';
import { createPgliteDb } from './pglite';
import type { Db } from './types';

/** 시험 파일마다 새 메모리 DB를 띄우고 마이그레이션을 모두 적용해요. */
export async function createTestDb(): Promise<Db> {
  const db = await createPgliteDb();
  await applyMigrations(db);
  return db;
}
