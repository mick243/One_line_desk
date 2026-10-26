import { defineConfig } from 'vitest/config';

// 시험 파일마다 PGlite를 따로 띄워서 동시에 돌면 느려져요. 시간 제한을 넉넉히 둬요.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
