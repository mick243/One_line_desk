import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import type { Db, Queryable } from './types';

/** dataDir가 없으면 메모리에만 둬요(시험용). */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const pg = await PGlite.create({ ...(dataDir ? { dataDir } : {}), extensions: { btree_gist } });
  await pg.exec("set time zone 'Asia/Seoul'");
  return {
    kind: 'pglite',
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pg.query<T>(sql, params);
      return { rows: res.rows };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      return pg.transaction(async (t) =>
        fn({
          async query<R>(sql: string, params?: unknown[]) {
            const res = await t.query<R>(sql, params);
            return { rows: res.rows };
          },
        }),
      );
    },
    async close() {
      await pg.close();
    },
  };
}
