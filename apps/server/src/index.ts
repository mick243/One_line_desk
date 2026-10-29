import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
// 운영은 같은 서버가 웹 화면 파일도 줘요(10/29 배포 준비 회의 A3). 파일이 없으면 뜨지 않아요.
const { app } = await buildApp({ config, webDir: config.webDist, logger: { level: config.production ? 'info' : 'debug' } });
await app.listen({ port: config.port, host: config.host });
// 뜰 때마다 한 줄 남겨서 업무 중 재시작(= 모두 로그아웃)을 세요. 주 1회를 넘으면 세션 표를 당겨요(배포 준비 회의 쟁점 2).
app.log.info({ msg: 'server-started', build: config.build });
// 시연 배포는 모의 로그인이 열려서 망이 유일한 문이에요. 운영 로그에서 바로 보이게 한 줄 남겨요(QA-47).
if (config.production && config.demo) app.log.warn({ msg: 'demo-deploy', note: '시연 배포(DESK_MOCK_LOGIN=true)예요. 모의 로그인이 열려 있어요' });

// 배포가 바꿔 끼울 때(SIGTERM) 새 요청과 받을 준비 확인은 503으로 돌리고, 받던 요청과 돌던 보관 회차를 끝낸 뒤 DB를 닫고 나가요(L-17).
// 한 대라 넘겨받을 서버가 없어서 비우기 기다림은 두지 않아요. 요청 한도(30초)보다 길게 45초 뒤에 강제로 끝내요.
// 그래서 컨테이너 멈춤 유예는 50초 이상이어야 해요(docker stop -t 50, 10/29 배포 준비 회의 A5).
const FORCE_EXIT_MS = 45_000;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ msg: 'shutting-down', signal });
    const force = setTimeout(() => process.exit(1), FORCE_EXIT_MS);
    force.unref();
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
