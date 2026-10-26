// 임시 IdP(Keycloak)로 개발 서버를 띄워요. 먼저 `npm run idp:up`으로 IdP를 켜 두세요(http://localhost:8180).
// 로그인·직원 명단이 IdP로 가고, 그룹웨어 캘린더·Slack은 그대로 모의예요(SLACK_BOT_TOKEN을 넣으면 실제 Slack).
import { spawn } from 'node:child_process';

const child = spawn('npm', ['run', 'dev'], { stdio: 'inherit', shell: true, env: { ...process.env, DESK_IDP: 'keycloak' } });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
