import pg from 'pg';
import type { Db, Queryable } from './types';

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10, options: '-c timezone=Asia/Seoul' });
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
