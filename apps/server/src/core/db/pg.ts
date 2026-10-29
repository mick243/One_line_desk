import pg from 'pg';
import type { Db, Queryable } from './types';

/** schema는 시험용이에요: 그 스키마를 먼저 찾고(search_path), 확장(btree_gist)은 public에서 찾아요. 운영은 넣지 않아요. */
export interface PgDbOptions {
  schema?: string;
}

export function createPgDb(connectionString: string, opts: PgDbOptions = {}): Db {
  // 시간 제한(L-17): 연결 5초, 문장 10초. 쉬던 연결이 끊겨도 풀 오류로 서버가 죽지 않게 받아서 남겨요(글은 빼고 코드만).
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    options: `-c timezone=Asia/Seoul -c statement_timeout=10000${opts.schema ? ` -c search_path=${opts.schema},public` : ''}`,
  });
  pool.on('error', (err: Error & { code?: string }) => {
    console.error(JSON.stringify({ level: 'error', msg: 'db-pool-error', code: err.code ?? err.name }));
  });
  return {
    kind: 'pg',
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn({
          async query<R>(sql: string, params?: unknown[]) {
            const res = await client.query(sql, params);
            return { rows: res.rows as R[] };
          },
        });
        await client.query('commit');
        return result;
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
