import { loadConfig } from '../src/config';
import { applyMigrations, openDb } from '../src/core/db';

// npm run db:migrate. DATABASE_URL이 없으면 개발용 PGlite(.data/pglite)에 적용해요.
// 운영은 마이그레이션 전용 주소(DESK_MIGRATE_DATABASE_URL, 표 주인 계정)가 있으면 그걸로 적용해요(11/11 QA Q5). 앱은 앱 계정(DATABASE_URL)으로만 붙어요.
const config = loadConfig();
if (config.migrateDatabaseUrl) console.log('마이그레이션 전용 계정(DESK_MIGRATE_DATABASE_URL)으로 적용해요');
const db = await openDb(config.migrateDatabaseUrl ?? config.databaseUrl);
try {
  const applied = await applyMigrations(db);
  console.log(applied.length ? `적용: ${applied.join(', ')}` : '새로 적용할 마이그레이션이 없어요');
} finally {
  await db.close();
}
