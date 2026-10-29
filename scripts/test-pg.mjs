// 서버 시험을 실제 PostgreSQL에서 돌려요. 먼저 `npm run db:test:up`으로 시험 전용 DB를 켜 두세요(5434, 끄면 자료가 사라져요).
// 다른 DB를 쓰려면 TEST_DATABASE_URL을 넣어요. DB 이름은 _test로 끝나야 해요(apps/server/src/core/db/test-global-setup.ts).
// 일부만 돌리려면 뒤에 붙여요: npm run test:pg -- src/modules/pantry
import { spawn } from 'node:child_process';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://desk:desk@localhost:5434/one_line_desk_test';
// 셸에 명령 한 줄로 넘겨요(인자 배열 + shell은 Node가 DEP0190 경고를 내요). 뒤에 붙인 값은 시험 파일 거르기용이에요.
const child = spawn(['npm test -w @one-line-desk/server --', ...process.argv.slice(2)].join(' '), {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, TEST_DATABASE_URL },
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
