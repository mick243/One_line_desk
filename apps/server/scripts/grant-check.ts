import { openDb } from '../src/core/db';
import { GRANT_CHECK_SQL, type GrantCheckRow, grantProblems } from './tenant-lib';

// 앱 계정 권한 확인(11/25). DATABASE_URL(앱 계정)로 붙어 권한을 읽기만 하고, db/roles/app-grants.sql과 다르면 까닭을 찍고 실패해요.
// CI의 두 계정 DB 연습과 손 확인에 써요(회사 배포 전 확인은 npm run tenant -- deploy가 같은 검사를 해요). 주소·비밀번호는 찍지 않아요.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL(앱 계정)을 넣어 주세요');
  process.exit(1);
}
const db = await openDb(url);
try {
  const problems = grantProblems((await db.query<GrantCheckRow>(GRANT_CHECK_SQL)).rows[0]!);
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length) process.exitCode = 1;
  else console.log('✓ 앱 계정 권한이 db/roles/app-grants.sql대로예요');
} finally {
  await db.close();
}
