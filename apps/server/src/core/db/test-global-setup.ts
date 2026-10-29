import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

// 시험 DB 고르기(vitest globalSetup). 시험을 시작한 셸에 TEST_DATABASE_URL이 있으면 서버 시험을 실제 PostgreSQL에서 돌려요(npm run test:pg).
// .env는 보지 않아요(.env에 넣어 두어 npm test가 몰래 바뀌지 않게). 없으면 지금처럼 시험 파일마다 메모리 PGlite예요.

declare module 'vitest' {
  export interface ProvidedContext {
    /** 비어 있으면 PGlite예요. */
    testDatabaseUrl: string;
    /** 이번 실행이 만드는 스키마 이름 앞머리. 끝날 때 이 앞머리만 지워요. */
    testSchemaPrefix: string;
  }
}

export default async function setup(project: TestProject) {
  const url = process.env.TEST_DATABASE_URL ?? '';
  const prefix = `desk_t_${randomBytes(4).toString('hex')}`;
  project.provide('testDatabaseUrl', url);
  project.provide('testSchemaPrefix', prefix);
  if (!url) return;

  // 개발·운영 DB에서 시험을 돌리지 않게 이름으로 막아요.
  // 던지면 vite가 오류 위치를 찾다 다른 오류(code.charCodeAt)로 덮어서, 문구를 직접 찍고 끝내요. 시험은 아직 하나도 시작하지 않았어요.
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!dbName.endsWith('_test')) {
    console.error(`TEST_DATABASE_URL의 DB 이름은 _test로 끝나야 해요(지금: ${dbName || '없음'}). 개발·운영 DB에서 시험을 돌리지 않게 막아요`);
    process.exit(1);
  }

  const run = async (fn: (c: pg.Client) => Promise<void>) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await fn(client);
    } finally {
      await client.end();
    }
  };
  // 확장은 DB에 하나라 여기서 한 번만 public에 만들어요. 시험 스키마마다 만들면 동시에 부딪히고, 스키마를 지울 때 같이 사라져요.
  await run((c) => c.query('create extension if not exists btree_gist with schema public').then(() => undefined));

  return async () => {
    // 닫지 못한 시험 스키마(실패·중단)는 이번 실행 것만 지워요. 같은 DB를 쓰는 다른 실행은 건드리지 않아요.
    await run(async (c) => {
      const { rows } = await c.query<{ name: string }>('select nspname as name from pg_namespace where starts_with(nspname, $1)', [`${prefix}_`]);
      for (const r of rows) await c.query(`drop schema "${r.name}" cascade`);
    });
  };
}
