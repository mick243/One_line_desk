import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPgDb } from './pg';
import { createPgliteDb } from './pglite';
import type { Db } from './types';

export type { Db, Queryable } from './types';
export { applyMigrations, pendingMigrations } from './migrate';

export const DEV_DATA_DIR = fileURLToPath(new URL('../../../../../.data/pglite', import.meta.url));

/** DATABASE_URL이 있으면 PostgreSQL, 없으면 저장소 안 .data/pglite에 PGlite로 열어요. */
export async function openDb(databaseUrl: string | undefined): Promise<Db> {
  if (databaseUrl) return createPgDb(databaseUrl);
  mkdirSync(DEV_DATA_DIR, { recursive: true });
  return createPgliteDb(DEV_DATA_DIR);
}
