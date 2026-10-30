import { randomBytes } from 'node:crypto';
import { relative, resolve, isAbsolute } from 'node:path';
import { loadConfig } from '../src/config';

// 회사별 분리(ADR-23): 회사마다 앱을 한 벌씩 따로 띄워요(서버·DB·로그인·비밀 값·주소가 따로).
// 이 파일은 한 벌을 만들고 검사하는 데 쓰는 순수 함수예요. 명령은 tenant.ts(npm run tenant)예요.
// - 회사는 이름 대신 ID(t-xxxxxx)로만 가리켜요. 앱 이름·폴더·DB 이름 어디에도 회사 이름을 쓰지 않아요.
// - 회사 목록·설정·비밀 값은 저장소 밖 비공개 폴더에만 둬요. 이 저장소에는 틀만 있어요.

/** 회사 ID. 회사 이름이 드러나지 않게 무작위 글자예요. */
export const TENANT_ID = /^t-[a-z0-9]{6}$/;
/** 아직 채우지 않은 값 표시. 검사가 이 표시가 남은 값을 찾아 멈춰요. */
export const PLACEHOLDER = '__FILL_ME__';
const SECRET_NAMES = ['SESSION_SECRET', 'PSEUDONYM_SECRET', 'PROPOSAL_SECRET', 'MCP_TOKEN_SECRET'] as const;

export function newTenantId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `t-${[...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join('')}`;
}

/** Fly 앱 이름(= 기본 주소 <이름>.fly.dev). 회사 ID에서만 만들어요. */
export const tenantAppName = (id: string) => `desk-${id}`;

/** 회사마다 새로 만드는 비밀 값 넷. 회사끼리 같은 값을 쓰지 않아요(가명 ID·세션이 회사마다 달라요). */
export function tenantSecrets(): Record<(typeof SECRET_NAMES)[number], string> {
  return Object.fromEntries(SECRET_NAMES.map((name) => [name, randomBytes(36).toString('base64url')])) as Record<(typeof SECRET_NAMES)[number], string>;
}

/**
 * 회사 한 벌의 설정 파일(tenant.env) 틀. 운영(NODE_ENV=production) 값이고, 채울 곳은 PLACEHOLDER예요.
 * 이 파일 그대로 `fly secrets import`로 그 회사 앱에만 넣어요.
 */
export function tenantEnvTemplate(id: string, secrets = tenantSecrets()): string {
  if (!TENANT_ID.test(id)) throw new Error(`회사 ID는 t-와 영문 소문자·숫자 6자예요(${id})`);
  return [
    `# 한 줄 데스크 회사 한 벌 설정(ADR-23) · 회사 ID ${id}`,
    '# 이 파일은 저장소 밖 비공개 폴더에만 둬요. 파일·폴더 이름과 값에 회사 이름을 쓰지 않아요.',
    `# 채울 곳은 ${PLACEHOLDER}예요. npm run tenant -- check 로 빠진 값을 확인해요.`,
    'NODE_ENV=production',
    '# 회사 자기 도메인 아래 주소(https, 경로 없이). 예: https://desk.회사도메인',
    `PUBLIC_BASE_URL=https://${PLACEHOLDER}`,
    '# 이 회사 전용 PostgreSQL 17. 다른 회사와 같은 DB를 쓰지 않아요.',
    `DATABASE_URL=postgres://${PLACEHOLDER}`,
    '# 앞단 관문 주소(/24보다 좁게). 관문 없이 직접 받으면 none.',
    `TRUST_PROXY=${PLACEHOLDER}`,
    '# 이 회사 IdP(OIDC). 직원 명단·재직 확인도 여기서 와요.',
    'DESK_IDP=keycloak',
    `DESK_IDP_ISSUER=https://${PLACEHOLDER}`,
    'DESK_IDP_CLIENT_ID=one-line-desk-web',
    `DESK_IDP_CLIENT_SECRET=${PLACEHOLDER}`,
    'DESK_IDP_DIRECTORY_CLIENT_ID=one-line-desk-directory',
    `DESK_IDP_DIRECTORY_CLIENT_SECRET=${PLACEHOLDER}`,
    '# AI는 이 회사와 무보관 계약을 확인하기 전까지 규칙만 써요(fake).',
    'DESK_AI_PROVIDER=fake',
    '# 이 회사만의 비밀 값(자동으로 만들었어요). 다른 회사와 나누지 않아요.',
    ...SECRET_NAMES.map((name) => `${name}=${secrets[name]}`),
    '',
  ].join('\n');
}

/** 회사 한 벌의 fly.toml. 회사 이름 없이 ID만 써요. 운영은 늘 켜진 한 대예요(세션이 메모리에 있어요, 10/29 배포 회의). */
export function tenantFlyToml(id: string, region = 'nrt'): string {
  if (!TENANT_ID.test(id)) throw new Error(`회사 ID는 t-와 영문 소문자·숫자 6자예요(${id})`);
  return [
    `# 한 줄 데스크 회사 한 벌(ADR-23) · 회사 ID ${id}. 저장소 밖 비공개 폴더에만 둬요.`,
    `app = "${tenantAppName(id)}"`,
    `primary_region = "${region}"`,
    'kill_signal = "SIGTERM"',
    'kill_timeout = 60',
    '',
    '[build]',
    '  # 이미지는 이 저장소의 Dockerfile 하나예요. 모든 회사가 같은 커밋을 받아요.',
    '  dockerfile = "Dockerfile"',
    '',
    '[deploy]',
    '  # 운영은 뜰 때 마이그레이션을 적용하지 않아요. 배포마다 먼저 이 회사 DB에 적용해요.',
    '  release_command = "node --import tsx apps/server/scripts/migrate.ts"',
    '',
    '[http_service]',
    '  internal_port = 3190',
    '  force_https = true',
    '  auto_stop_machines = "off"',
    '  auto_start_machines = true',
    '  min_machines_running = 1',
    '',
    '  [[http_service.checks]]',
    '    grace_period = "20s"',
    '    interval = "30s"',
    '    timeout = "3s"',
    '    method = "GET"',
    '    path = "/health/live"',
    '',
    '[[vm]]',
    '  size = "shared-cpu-1x"',
    '  memory = "1gb"',
    '',
  ].join('\n');
}

/** KEY=VALUE 줄을 읽어요. 빈 줄·# 주석은 건너뛰어요. 값의 따옴표는 벗겨요. */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/** dir가 base 안(같은 곳 포함)인지. 회사 폴더가 저장소 안에 생기지 않게 막아요(실수로 커밋하면 고객 목록이 드러나요). */
export function insideDir(dir: string, base: string): boolean {
  const rel = relative(resolve(base), resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 회사 한 벌 설정 검사. 채우지 않은 값과 운영 설정 검사(config.ts)에 걸리는 것을 모두 돌려줘요.
 * 이름만 말하고 값은 돌려주지 않아요(비밀이 로그·화면에 남지 않게).
 */
export function checkTenantEnv(env: Record<string, string>, runtime = { node: '24.18.0', execArgv: [] as string[] }): string[] {
  const problems = Object.entries(env)
    .filter(([, value]) => value.includes(PLACEHOLDER))
    .map(([name]) => `${name} 값을 채워 주세요`);
  if (env.NODE_ENV !== 'production') problems.push('회사 한 벌은 NODE_ENV=production이어야 해요');
  if (env.DESK_MOCK_LOGIN) problems.push('회사 한 벌에는 DESK_MOCK_LOGIN을 넣지 않아요(시연 배포가 아니에요)');
  if (problems.length) return problems;
  try {
    loadConfig(env, runtime);
    return [];
  } catch (e) {
    return (e as Error).message
      .split('\n')
      .map((line) => line.replace(/^- /, '').trim())
      .filter((line) => line && !line.startsWith('운영 설정을 확인해 주세요'));
  }
}
