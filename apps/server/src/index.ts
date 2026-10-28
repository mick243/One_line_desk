import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { app } = await buildApp({ config, logger: { level: config.production ? 'info' : 'debug' } });
await app.listen({ port: config.port, host: config.host });
// 시연 배포는 모의 로그인이 열려서 망이 유일한 문이에요. 운영 로그에서 바로 보이게 한 줄 남겨요(QA-47).
if (config.production && config.demo) app.log.warn({ msg: 'demo-deploy', note: '시연 배포(DESK_MOCK_LOGIN=true)예요. 모의 로그인이 열려 있어요' });

// 배포가 바꿔 끼울 때(SIGTERM) 새 요청은 503으로 돌리고, 받던 요청을 끝낸 뒤 DB를 닫고 나가요(L-17).
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ msg: 'shutting-down', signal });
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
