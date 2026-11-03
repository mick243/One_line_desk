import '../src/config';
import { AccessRecorder } from '../src/core/access-record';
import { AuditLog } from '../src/core/audit';
import { openDb, pendingMigrations } from '../src/core/db';
import { DeskError } from '../src/core/errors';
import * as admin from '../src/modules/mcp/admin';

// MCP 허용 앱 관리 명령 도구(11/3, MCP 통합 회의 1단계). 운영자 웹 화면 대신 써요(R7).
// DB에 바로 붙어(DATABASE_URL, 없으면 개발용 PGlite .data/pglite) 운영자 API와 같은 함수를 쓰고, 운영 감사 로그를 남겨요.
// 감사 로그·접속기록의 "누가"는 사람 대신 고정 값 'cli'예요. 누가 돌렸는지는 서버 접속 기록(운영 계정)으로 봐요.

const HELP = `한 줄 데스크 MCP 허용 앱 관리

  npm run mcp:clients -- list
  npm run mcp:clients -- add --name <앱 이름> (--confidential | --public) --redirect <주소> [--redirect <주소>…] [--demo]
  npm run mcp:clients -- approve <클라이언트 ID>       보안팀 승인 켜기(실제 자료를 보내도 돼요)
  npm run mcp:clients -- unapprove <클라이언트 ID>     보안팀 승인 끄기(연결은 남지만 다음 요청부터 막혀요)
  npm run mcp:clients -- disconnect <클라이언트 ID>    그 앱의 모든 연결 끊기(등록은 남아요)
  npm run mcp:clients -- revoke <클라이언트 ID>        회수: 등록을 지우고 모든 연결을 끊어요
  npm run mcp:clients -- report [--month YYYY-MM]      그 달(빼면 이번 달) 종류별·앱별 셈과 호출한 사람 수

- 기밀(--confidential): 서버가 비밀을 만들어 이 화면에 한 번만 보여 줘요. DB에는 해시만 남아서 다시 볼 수 없어요.
  잃어버리면 revoke 뒤 다시 add 해요.
- 공개(--public): 비밀 없는 CLI 앱(Claude Code·Codex)용이에요. 리디렉트는 루프백 주소만 받아요(예: http://localhost/callback).
- 새 앱은 보안팀 승인이 꺼진 채로 등록돼요. 보안팀이 보관 조건·네트워크 출발지를 확인한 뒤 approve 해요.
- --demo는 시연용이에요. 데이터가 모두 모의일 때만 허용 목록 안이에요.
- 사람 하나만 끊는 명령은 없어요. 운영자 API(POST /api/ops/mcp/people/disconnect)에서 직원 검색으로 골라 끊어요.
  명령 줄에 사람 식별값(메일·가명 ID)을 넣으면 셸 기록에 남아서 두지 않아요.
- report의 종류별·앱별 셈은 날마다 셈 표(13개월 보관)에서, 호출한 사람 수는 접속기록(1년)에서 세요. 사람·클라이언트 ID는 나오지 않아요.
- 개발용 PGlite를 쓸 때는 개발 서버(npm run dev)를 끄고 돌려요. PGlite는 한 프로세스만 열 수 있어요.

예: ChatGPT(기밀 클라이언트) 등록
  1) ChatGPT 커넥터 설정 화면에서 리디렉트(콜백) 주소를 복사해요.
  2) npm run mcp:clients -- add --name ChatGPT --confidential --redirect <ChatGPT 화면에서 복사한 주소>
  3) 나온 클라이언트 ID와 비밀을 ChatGPT 커넥터 화면(OAuth 고급 설정)에 넣어요. 비밀은 이때 한 번만 보여요.
  4) 보안팀 승인 뒤: npm run mcp:clients -- approve <클라이언트 ID>
  MCP 주소는 <앱 주소>/mcp예요.`;

const [command, ...rest] = process.argv.slice(2);
const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};
const flag = (name: string) => rest.includes(`--${name}`);
const values = (name: string) => rest.flatMap((v, i) => (rest[i - 1] === `--${name}` ? [v] : []));
const idArg = () => rest.find((v) => !v.startsWith('--')) ?? fail('클라이언트 ID를 넣어 주세요');

if (!command || command === 'help' || flag('help')) {
  process.stdout.write(`${HELP}\n`);
  process.exit(command ? 0 : 1);
}

const db = await openDb(process.env.DATABASE_URL || undefined);
const out = (text: string) => process.stdout.write(`${text}\n`);
try {
  const pending = await pendingMigrations(db);
  if (pending.length) fail(`마이그레이션을 먼저 적용해 주세요(npm run db:migrate): ${pending.join(', ')}`);
  const now = () => Date.now();
  const deps: admin.AdminDeps = { db, audit: new AuditLog(db), access: new AccessRecorder(db, now), now };
  const actor = admin.CLI_ACTOR;

  switch (command) {
    case 'list': {
      const clients = await admin.listClients(db);
      if (!clients.length) out('등록된 앱이 없어요');
      for (const c of clients) {
        out(
          `${c.clientId}  ${c.appName}  ${c.kind === 'public' ? '공개' : '기밀'}${c.demoOnly ? ' · 시연용' : ''} · 보안팀 승인 ${c.securityApproved ? '켬' : '끔'} · 연결 ${c.people}명/${c.devices}대 · 등록 ${c.createdOn}`,
        );
        for (const uri of c.redirectUris) out(`    ↳ ${uri}`);
      }
      break;
    }
    case 'add': {
      const confidential = flag('confidential');
      if (confidential === flag('public')) fail('--confidential 또는 --public 하나를 골라 주세요');
      const name = values('name')[0] ?? fail('--name <앱 이름>을 넣어 주세요');
      const created = await admin.addClient(deps, actor, {
        appName: name,
        kind: confidential ? 'confidential' : 'public',
        redirectUris: values('redirect'),
        demoOnly: flag('demo'),
      });
      out(`✓ 등록했어요: ${created.client.clientId} (${created.client.appName}, 보안팀 승인 끔)`);
      if (created.clientSecret) {
        out(`  클라이언트 비밀: ${created.clientSecret}`);
        out('  비밀은 지금 한 번만 보여요. DB에는 해시만 남아요. 바로 앱 설정에 넣고 이 화면 기록을 지워 주세요.');
      }
      break;
    }
    case 'approve':
    case 'unapprove': {
      const c = await admin.setApproval(deps, actor, idArg(), command === 'approve');
      out(`✓ ${c.clientId} (${c.appName}) 보안팀 승인 ${c.securityApproved ? '켬' : '끔'}`);
      break;
    }
    case 'disconnect': {
      const { removed } = await admin.disconnectClient(deps, actor, idArg());
      out(`✓ 연결 ${removed}개를 끊었어요`);
      break;
    }
    case 'revoke': {
      const { removed } = await admin.revokeClient(deps, actor, idArg());
      out(`✓ 회수했어요. 연결 ${removed}개가 같이 끊겼어요`);
      break;
    }
    case 'report': {
      const month = values('month')[0];
      if (flag('month') && !month) fail('--month YYYY-MM을 넣어 주세요');
      out(JSON.stringify(await admin.report(deps, month), null, 2));
      break;
    }
    default:
      fail(`모르는 명령이에요: ${command}\n${HELP}`);
  }
} catch (e) {
  fail(e instanceof DeskError ? e.message : '처리하지 못했어요');
} finally {
  await db.close();
}
