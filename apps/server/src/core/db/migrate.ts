import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './types';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../../db/migrations', import.meta.url));

/** db/migrations/*.sql을 이름 순서대로 한 번씩만 적용해요. 적용한 파일 이름을 돌려줘요. */
export async function applyMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), 'utf8');
    await db.exec(`begin;\n${sql}\n;insert into schema_migrations (name) values ('${name.replaceAll("'", "''")}');\ncommit;`);
    applied.push(name);
  }
  return applied;
}
