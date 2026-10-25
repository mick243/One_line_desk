import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../config';

// db/migrations/*.sql을 이름 순서대로 한 번씩만 적용해요.
const dir = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

async function main() {
  const { databaseUrl } = loadConfig();
  if (!databaseUrl) throw new Error('DATABASE_URL이 없어요. .env를 확인해 주세요');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(join(dir, name), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
        console.log(`적용: ${name}`);
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
    }
    console.log('마이그레이션 끝');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
