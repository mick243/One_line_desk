import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import type { Db, Queryable } from './types';

/**
 * dataDir가 없으면 메모리에만 둬요(시험용).
 * loadDataDir: 마이그레이션까지 끝낸 DB를 떠 둔 묶음(시험 globalSetup이 한 번 만들어요). 새로 initdb를 하지 않아 몇 배 빨리 떠요.
 */
export async function createPgliteDb(dataDir?: string, opts: { loadDataDir?: Blob } = {}): Promise<Db> {
  const pg = await PGlite.create({
    ...(dataDir ? { dataDir } : {}),
    ...(opts.loadDataDir ? { loadDataDir: opts.loadDataDir } : {}),
    extensions: { btree_gist },
  });
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
    async dumpDataDir() {
      return pg.dumpDataDir('none');
    },
  };
}
