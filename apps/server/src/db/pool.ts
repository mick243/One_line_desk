import pg from 'pg';

export type DbStatus = 'none' | 'connected' | 'error';

export function createPool(databaseUrl: string | undefined): pg.Pool | undefined {
  return databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 5 }) : undefined;
}

export async function dbStatus(pool: pg.Pool | undefined): Promise<DbStatus> {
  if (!pool) return 'none';
  try {
    await pool.query('select 1');
    return 'connected';
  } catch {
    return 'error';
  }
}
