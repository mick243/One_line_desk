// DB 접근은 이 인터페이스로만 해요. 운영은 PostgreSQL(pg), 개발·시험은 PGlite예요.
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite';
  /** 여러 문장을 한 번에 실행해요(마이그레이션용). 매개변수는 못 써요. */
  exec(sql: string): Promise<void>;
  /** fn이 던지면 되돌려요. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
