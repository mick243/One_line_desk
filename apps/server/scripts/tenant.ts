import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTenantEnv, insideDir, newTenantId, parseEnvFile, TENANT_ID, tenantAppName, tenantEnvTemplate, tenantFlyToml } from './tenant-lib';

// 회사 한 벌 다루기(ADR-23). 회사 목록·설정은 저장소 밖 비공개 폴더(--dir)에만 둬요.
//   npm run tenant -- new --dir <비공개 폴더> [--id t-xxxxxx] [--region nrt]   새 회사 한 벌 틀 만들기
//   npm run tenant -- check --dir <비공개 폴더> [--id t-xxxxxx]                 설정 검사(값은 찍지 않아요)
//   npm run tenant -- deploy --dir <비공개 폴더> [--id t-xxxxxx]                지금 커밋을 회사마다 배포 + 연기 시험
// 배포는 Fly.io(flyctl)를 써요. 회사 호스팅이 정해지면 deploy만 바꿔요.

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const [command, ...rest] = process.argv.slice(2);
const opt = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const dir = opt('dir') ?? fail('--dir <비공개 폴더>를 넣어 주세요. 저장소 밖이어야 해요');
if (insideDir(dir, REPO)) fail('회사 폴더는 저장소 밖에 둬요. 저장소 안에 두면 커밋되어 고객 목록이 드러날 수 있어요');

const tenantIds = (): string[] => {
  const only = opt('id');
  if (only) return [only];
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && TENANT_ID.test(e.name))
    .map((e) => e.name);
};
const envOf = (id: string) => {
  const file = join(dir, id, 'tenant.env');
  if (!existsSync(file)) fail(`${id}: tenant.env가 없어요`);
  return parseEnvFile(readFileSync(file, 'utf8'));
};

function create() {
  const id = opt('id') ?? newTenantId();
  if (!TENANT_ID.test(id)) fail(`회사 ID는 t-와 영문 소문자·숫자 6자예요(${id})`);
  const folder = join(dir, id);
  if (existsSync(folder)) fail(`${id} 폴더가 이미 있어요`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'tenant.env'), tenantEnvTemplate(id), { mode: 0o600 });
  writeFileSync(join(folder, 'fly.toml'), tenantFlyToml(id, opt('region')));
  console.log(`✓ 회사 한 벌 틀을 만들었어요: ${id} (앱 이름 ${tenantAppName(id)})`);
  console.log(`  ${join(folder, 'tenant.env')}의 __FILL_ME__를 채운 뒤 check → deploy 순서로 해요.`);
  console.log('  회사 ID와 실제 회사 이름의 대응은 운영팀 비공개 문서에만 적어요.');
}

function check(): boolean {
  const ids = tenantIds();
  if (!ids.length) fail('회사 폴더(t-xxxxxx)가 없어요');
  let ok = true;
  for (const id of ids) {
    const problems = checkTenantEnv(envOf(id));
    if (problems.length) {
      ok = false;
      console.log(`✗ ${id}`);
      for (const p of problems) console.log(`  - ${p}`);
    } else console.log(`✓ ${id} 설정이 맞아요`);
  }
  return ok;
}

function deploy() {
  // 모든 회사가 같은 커밋을 받아요. 고치는 중인 파일이 있으면 판과 내용이 달라서 멈춰요.
  if (execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim()) fail('커밋하지 않은 변경이 있어요. 커밋한 뒤 배포해요');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  if (!check()) fail('설정을 먼저 고쳐 주세요');
  const fly = process.env.FLYCTL ?? 'flyctl';
  for (const id of tenantIds()) {
    const app = tenantAppName(id);
    const env = join(dir, id, 'tenant.env');
    console.log(`→ ${id}: 비밀 값 넣기 · 배포(${sha.slice(0, 7)})`);
    const run = (args: string[], input?: string) => {
      const r = spawnSync(fly, args, { cwd: REPO, stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit', input });
      if (r.status !== 0) fail(`${id}: ${args.slice(0, 2).join(' ')} 실패`);
    };
    run(['secrets', 'import', '--stage', '-a', app], readFileSync(env, 'utf8'));
    run(['deploy', '--config', join(dir, id, 'fly.toml'), '--ha=false', '--remote-only', '--build-arg', `DESK_BUILD=${sha}`, '-a', app]);
    const base = parseEnvFile(readFileSync(env, 'utf8')).PUBLIC_BASE_URL!;
    const smoke = spawnSync(process.execPath, ['scripts/smoke.mjs', base], { cwd: REPO, stdio: 'inherit', env: { ...process.env, SMOKE_BUILD: sha } });
    if (smoke.status !== 0) fail(`${id}: 연기 시험 실패. 이 회사는 앞 판으로 되돌려 주세요(fly releases·fly deploy --image)`);
    console.log(`✓ ${id} 배포·연기 시험 통과`);
  }
}

if (command === 'new') create();
else if (command === 'check') process.exit(check() ? 0 : 1);
else if (command === 'deploy') deploy();
else fail('명령은 new · check · deploy 중 하나예요');
