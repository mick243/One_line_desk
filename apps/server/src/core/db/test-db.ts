import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inject } from 'vitest';
import { applyMigrations } from './migrate';
import { createPgDb } from './pg';
import { createPgliteDb } from './pglite';
import type { Db } from './types';

let snapshot: Buffer | null = null;

/**
 * 시험 파일마다 새 DB를 띄우고 마이그레이션을 모두 적용해요.
 * PGlite는 globalSetup이 마이그레이션까지 끝내 떠 둔 묶음(pgliteSnapshot)에서 띄워요(11/2). 마이그레이션은 다시 불러도 "모두 적용됨"만 확인해요.
 * 기본은 메모리 PGlite예요. TEST_DATABASE_URL로 시작하면(npm run test:pg) 실제 PostgreSQL에 새 스키마를 만들고, 닫을 때 지워요.
 */
export async function createTestDb(): Promise<Db> {
  const url = inject('testDatabaseUrl');
  const snapshotPath = inject('pgliteSnapshot');
  if (!url && snapshotPath && !snapshot) snapshot = readFileSync(snapshotPath);
  const db = url
    ? await createSchemaDb(url, `${inject('testSchemaPrefix')}_${randomBytes(4).toString('hex')}`)
    : await createPgliteDb(undefined, snapshot ? { loadDataDir: new Blob([new Uint8Array(snapshot)]) } : {});
  await applyMigrations(db);
  return db;
}

async function createSchemaDb(url: string, schema: string): Promise<Db> {
  const db = createPgDb(url, { schema });
  await db.exec(`create schema "${schema}"`);
  return {
    ...db,
    async close() {
      await db.exec(`drop schema "${schema}" cascade`);
      await db.close();
    },
  };
}
