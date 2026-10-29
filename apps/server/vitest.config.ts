import { defineConfig } from 'vitest/config';

// 시험 파일마다 PGlite를 따로 띄워서 동시에 돌면 느려져요. 시간 제한을 넉넉히 둬요.
// 시험 DB는 globalSetup이 골라요: 기본 PGlite, TEST_DATABASE_URL이 있으면 실제 PostgreSQL(npm run test:pg).
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: ['./src/core/db/test-global-setup.ts'],
  },
});
