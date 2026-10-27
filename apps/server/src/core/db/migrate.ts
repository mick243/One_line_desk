import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, Queryable } from './types';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../../db/migrations', import.meta.url));

const MIGRATION_LOCK = 'one-line-desk:migrations';

const migrationFiles = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

const appliedNames = async (q: Queryable) => new Set((await q.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));

/**
 * db/migrations/*.sql을 이름 순서대로 한 번씩만 적용해요. 적용한 파일 이름을 돌려줘요.
 * PostgreSQL은 한 트랜잭션 안에서 잠금(advisory lock)을 잡고 적용해서, 잡을 두 번(동시에) 돌려도 한 번만 들어가요(L-22).
 * 하나라도 실패하면 이번에 적용한 것 모두 되돌려요.
 */
export async function applyMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  if (db.kind === 'pg') {
    return db.tx(async (q) => {
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [MIGRATION_LOCK]);
      const done = await appliedNames(q);
      const applied: string[] = [];
      for (const name of migrationFiles(dir)) {
        if (done.has(name)) continue;
        // 매개변수 없는 query는 여러 문장을 한 번에 보낼 수 있어요(pg 단순 질의).
        await q.query(readFileSync(join(dir, name), 'utf8'));
        await q.query('insert into schema_migrations (name) values ($1)', [name]);
        applied.push(name);
      }
      return applied;
    });
  }
  // PGlite(개발·시험)는 한 프로세스만 열 수 있어서 잠금이 필요 없어요.
  const done = await appliedNames(db);
  const applied: string[] = [];
  for (const name of migrationFiles(dir)) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), 'utf8');
    await db.exec(`begin;\n${sql}\n;insert into schema_migrations (name) values ('${name.replaceAll("'", "''")}');\ncommit;`);
    applied.push(name);
  }
  return applied;
}

/** 아직 적용하지 않은 마이그레이션. 앱 시작 적용을 끈 운영에서 서버가 뜨기 전에 봐요. 표가 없으면 전부예요. */
export async function pendingMigrations(db: Queryable, dir = MIGRATIONS_DIR): Promise<string[]> {
  const exists = (await db.query<{ t: string | null }>("select to_regclass('schema_migrations')::text as t")).rows[0]?.t;
  const done = exists ? await appliedNames(db) : new Set<string>();
  return migrationFiles(dir).filter((name) => !done.has(name));
}
