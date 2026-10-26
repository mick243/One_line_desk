import { loadConfig } from '../src/config';
import { applyMigrations, openDb } from '../src/core/db';

// npm run db:migrate. DATABASE_URL이 없으면 개발용 PGlite(.data/pglite)에 적용해요.
const config = loadConfig();
const db = await openDb(config.databaseUrl);
try {
  const applied = await applyMigrations(db);
  console.log(applied.length ? `적용: ${applied.join(', ')}` : '새로 적용할 마이그레이션이 없어요');
} finally {
  await db.close();
}
