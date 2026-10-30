import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, Queryable } from './types';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../../db/migrations', import.meta.url));

const MIGRATION_LOCK = 'one-line-desk:migrations';

interface MigrationFile {
  name: string;
  sql: string;
  /** 내용 확인값. 줄 끝(CRLF·LF)은 같게 보고 세요. */
  sha256: string;
}

const migrationFiles = (dir: string): MigrationFile[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, sha256: createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex') };
    });

/**
 * 이미 적용한 기록이 지금 폴더와 맞는지 보고, 적용한 이름을 돌려줘요. 맞지 않으면 멈춰요(10/30 백엔드 점검).
 * - 폴더에 없는 이름이 적혀 있으면: 마이그레이션을 합치기 전의 옛 DB예요. 그대로 두면 새 파일을 다시 적용하다 깨지거나,
 *   일부만 적용된 DB를 "다 적용됨"으로 잘못 볼 수 있어요.
 * - 내용 확인값이 다르면: 이미 적용한 파일을 고친 거예요. 고친 내용은 그 DB에 들어가지 않아요. 새 파일을 더해야 해요.
 */
async function checkedApplied(q: Queryable, files: MigrationFile[]): Promise<Set<string>> {
  const columns = (
    await q.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'schema_migrations' and table_schema = current_schema()",
    )
  ).rows.map((r) => r.column_name);
  if (!columns.length) return new Set();
  const hasSha = columns.includes('sha256');
  const rows = (await q.query<{ name: string; sha256: string | null }>(`select name, ${hasSha ? 'sha256' : 'null as sha256'} from schema_migrations`)).rows;
  const byName = new Map(files.map((f) => [f.name, f]));
  const unknown = rows.filter((r) => !byName.has(r.name)).map((r) => r.name);
  if (unknown.length || !hasSha) {
    throw new Error(
      `DB에 지금 폴더에 없는 마이그레이션 기록이 있어요(${unknown.join(', ') || '확인값 없는 옛 기록'}). 마이그레이션을 합치기 전의 옛 DB예요. ` +
        '개발 DB면 서버를 끄고 .data/pglite를 지우거나 docker compose down -v 뒤 다시 띄워 주세요. 운영 DB면 멈추고 리드에게 알려 주세요',
    );
  }
  const changed = rows.filter((r) => r.sha256 !== byName.get(r.name)!.sha256).map((r) => r.name);
  if (changed.length) {
    throw new Error(`이미 적용한 마이그레이션 파일이 바뀌었어요(${changed.join(', ')}). 적용한 파일은 고치지 말고 새 파일을 더해 주세요`);
  }
  return new Set(rows.map((r) => r.name));
}

const CREATE_TABLE =
  'create table if not exists schema_migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now())';

/**
 * db/migrations/*.sql을 이름 순서대로 한 번씩만 적용해요. 적용한 파일 이름을 돌려줘요.
 * 적용한 파일의 이름과 내용 확인값(sha256)을 남기고, 다음에 기록과 폴더가 맞지 않으면 멈춰요(checkedApplied).
 * PostgreSQL은 한 트랜잭션 안에서 잠금(advisory lock)을 잡고 적용해서, 잡을 두 번(동시에) 돌려도 한 번만 들어가요(L-22).
 * 잠금은 스키마마다 따로예요. 시험(npm run test:pg)은 스키마를 나눠 동시에 적용해서, DB 하나에 잠금 하나면 줄을 서다 문장 제한(10초)에 걸려요.
 * 하나라도 실패하면 이번에 적용한 것 모두 되돌려요.
 */
export async function applyMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = migrationFiles(dir);
  if (db.kind === 'pg') {
    return db.tx(async (q) => {
      await q.query("select pg_advisory_xact_lock(hashtext($1 || ':' || current_schema()))", [MIGRATION_LOCK]);
      const done = await checkedApplied(q, files);
      await q.query(CREATE_TABLE);
      const applied: string[] = [];
      for (const file of files) {
        if (done.has(file.name)) continue;
        // 매개변수 없는 query는 여러 문장을 한 번에 보낼 수 있어요(pg 단순 질의).
        await q.query(file.sql);
        await q.query('insert into schema_migrations (name, sha256) values ($1, $2)', [file.name, file.sha256]);
        applied.push(file.name);
      }
      return applied;
    });
  }
  // PGlite(개발·시험)는 한 프로세스만 열 수 있어서 잠금이 필요 없어요.
  const done = await checkedApplied(db, files);
  await db.exec(CREATE_TABLE);
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file.name)) continue;
    const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
    await db.exec(`begin;\n${file.sql}\n;insert into schema_migrations (name, sha256) values (${quote(file.name)}, ${quote(file.sha256)});\ncommit;`);
    applied.push(file.name);
  }
  return applied;
}

/**
 * 아직 적용하지 않은 마이그레이션. 앱 시작 적용을 끈 운영에서 서버가 뜨기 전에 봐요. 표가 없으면 전부예요.
 * 기록이 폴더와 맞지 않으면(옛 이름·고친 파일) 던져서 서버가 뜨지 않아요.
 */
export async function pendingMigrations(db: Queryable, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = migrationFiles(dir);
  const done = await checkedApplied(db, files);
  return files.map((f) => f.name).filter((name) => !done.has(name));
}
