import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { app } = await buildApp({ config, logger: { level: config.production ? 'info' : 'debug' } });
await app.listen({ port: config.port, host: config.host });

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
