// Vercel에서 웹 화면만 만들어요(10/30 Vercel 배포 회의). vercel.json의 buildCommand예요.
// 화면 판(DESK_BUILD)은 커밋 전체 SHA예요. 시연 서버 이미지도 같은 커밋의 전체 SHA로 만들어야 판이 같아요.
// 판이 비거나 dev면 멈춰요. 그대로 올리면 새 버전 띠는 안 뜨는데 회의실 채팅 바로 실행만 조용히 막혀요(rooms/routes.ts).
import { spawnSync } from 'node:child_process';

const build = process.env.DESK_BUILD || process.env.VERCEL_GIT_COMMIT_SHA || '';
if (!/^[0-9a-f]{40}$/.test(build)) {
  console.error(
    `화면 판을 정하지 못했어요(DESK_BUILD·VERCEL_GIT_COMMIT_SHA: "${build}"). 커밋 전체 SHA(40자)가 있어야 해요. Git 연결 배포로 올리거나 DESK_BUILD를 넣어 주세요`,
  );
  process.exit(1);
}
const result = spawnSync('npm', ['run', 'build', '-w', '@one-line-desk/web'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DESK_BUILD: build },
});
process.exit(result.status ?? 1);
