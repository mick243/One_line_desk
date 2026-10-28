import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export interface ServerConfig {
  port: number;
  /** 웹 앱 주소. MCP 앱 확인 링크와 인가 리디렉트에 써요. */
  publicBaseUrl: string;
  sessionSecret: string;
  pseudonymSecret: string;
  proposalSecret: string;
  /** MCP 접근·갱신 토큰을 봉인하는 비밀 값. 세션 비밀과 따로 둬요. */
  mcpTokenSecret: string;
  databaseUrl: string | undefined;
  noRetentionContractConfirmed: boolean;
  aiProvider: 'fake' | 'anthropic';
  aiModel: string;
  /** 비어 있는 DB에 가상 자료(등급 0)를 넣을지. 시연에서만 기본으로 켜요. */
  seedDemo: boolean;
  production: boolean;
  /**
   * 시연 배포인지(mock 판정 한 곳, L-16). 참이면 모의 로그인(가상 직원 고르기)·가상 자료·모의 바깥 어댑터·시연 MCP 클라이언트를 열어요.
   * 개발은 늘 참이고, 운영(NODE_ENV=production)은 DESK_MOCK_LOGIN=true를 넣은 시연 배포일 때만 참이에요.
   */
  demo: boolean;
  /** 서버가 뜰 때 마이그레이션을 적용할지(L-22). 시연은 켜고, 운영은 꺼서 앱 계정에 표 만들기 권한이 없어도 떠요(먼저 npm run db:migrate). */
  migrateOnStart: boolean;
  /** 서버가 듣는 주소. 개발은 localhost, 운영(컨테이너)은 0.0.0.0이에요. */
  host: string;
  /** 앞단 프록시를 믿을지(Fastify trustProxy). true 또는 믿을 프록시 주소 목록(쉼표)이에요. 없으면 믿지 않아요. */
  trustProxy: boolean | string;
  /** 로그인·직원 명단. mock = 앱 안 가상 직원, keycloak = 임시 IdP(npm run idp:up) 또는 같은 방식의 OIDC IdP */
  idp:
    { kind: 'mock' } | { kind: 'keycloak'; issuer: string; clientId: string; clientSecret: string; directoryClientId: string; directoryClientSecret: string };
  /** 넣으면 Slack DM을 실제로 보내요(봇 권한 users:read.email·im:write·chat:write). 없으면 모의 Slack이에요. */
  slackBotToken: string | undefined;
  /**
   * 앱이 회사 IdP 로그인의 MFA 근거를 확인할지(ADR-20). off = IdP 조건부 접근에 맡겨요(기본), always = 근거가 없으면 세션을 만들지 않아요.
   * 근거는 ID 토큰의 amr(mfaAmr 중 하나) 또는 acr(mfaAcr 중 하나)이에요. IdP마다 값이 달라서 설정으로 받아요.
   */
  requireMfa: 'off' | 'always';
  mfaAmr: string[];
  mfaAcr: string[];
  /** 로그인 요청에 넣을 acr_values(선택). IdP가 이 값으로 MFA를 요구해요. */
  acrValues: string | undefined;
}

/** 실행 환경(시험에서 바꿔 넣어요) */
export interface Runtime {
  node: string;
  execArgv: string[];
}

const NODE_ENVS = ['production', 'development', 'test'];
const MFA_POLICIES = ['off', 'always'] as const;
/** RFC 8176 값 중 두 번째 요소로 볼 것. SMS·전화는 넣지 않아요(정보보안팀). */
const DEFAULT_MFA_AMR = ['mfa', 'otp', 'hwk', 'swk'];
const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** 운영에서 받는 모델(BE-3). 목록 밖 값으로는 뜨지 않아요. */
export const ALLOWED_AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

const SECRET_MIN = 32;

/**
 * 운영 설정이 실수하면 닫혀요(L-15). 값 하나만 빠지거나 개발용이어도 이유를 모두 말하고 뜨지 않아요.
 * 시연 배포(DESK_MOCK_LOGIN=true)는 회사 IdP·PostgreSQL 없이도 뜨지만, 비밀 값·주소 검사는 같아요.
 */
function productionProblems(env: NodeJS.ProcessEnv, config: ServerConfig, runtime: Runtime): string[] {
  const problems: string[] = [];
  const secretNames = ['SESSION_SECRET', 'PSEUDONYM_SECRET', 'PROPOSAL_SECRET', 'MCP_TOKEN_SECRET'];
  if (config.idp.kind === 'keycloak') secretNames.push('DESK_IDP_CLIENT_SECRET', 'DESK_IDP_DIRECTORY_CLIENT_SECRET');
  const given: string[] = [];
  for (const name of secretNames) {
    const value = env[name];
    if (!value) problems.push(`${name}이 없어요`);
    else if (/dev-only|change-me/i.test(value)) problems.push(`${name}이 개발용 값이에요`);
    else if (value.length < SECRET_MIN) problems.push(`${name}은 ${SECRET_MIN}자 이상이어야 해요`);
    else given.push(value);
  }
  if (new Set(given).size !== given.length) problems.push('비밀 값끼리는 서로 달라야 해요');
  if (!env.PUBLIC_BASE_URL?.startsWith('https://')) problems.push('PUBLIC_BASE_URL은 https 주소여야 해요');
  if (env.ANTHROPIC_LOG) problems.push('ANTHROPIC_LOG를 지워 주세요(요청 본문이 로그에 남을 수 있어요)');
  if (config.aiProvider === 'anthropic' && !ALLOWED_AI_MODELS.includes(config.aiModel))
    problems.push(`DESK_AI_MODEL은 ${ALLOWED_AI_MODELS.join('·')} 중 하나여야 해요`);
  problems.push(...networkProblems(env, runtime));
  if (config.demo) {
    // 시연 깃발이 운영 배포에 섞이면 가상 자료·모의 로그인이 실제 연결과 같이 떠요(QA-47). 시연은 다른 주소·DB·비밀로 따로 띄워요(CD-34).
    const real = [env.DESK_IDP && 'DESK_IDP', env.SLACK_BOT_TOKEN && 'SLACK_BOT_TOKEN'].filter((x): x is string => Boolean(x));
    if (real.length)
      problems.push(`시연 배포(DESK_MOCK_LOGIN=true)에 실제 연결 설정이 있어요(${real.join('·')}). 운영 배포에서는 DESK_MOCK_LOGIN을 지워 주세요`);
    if (config.databaseUrl && env.DESK_DEMO_DATABASE !== 'true')
      problems.push('시연 배포가 DATABASE_URL을 써요. 시연 전용 DB가 맞으면 DESK_DEMO_DATABASE=true를 넣고, 운영 DB면 DESK_MOCK_LOGIN을 지워 주세요');
  } else {
    if (!config.databaseUrl) problems.push('DATABASE_URL이 없어요(운영은 PostgreSQL만 써요)');
    if (config.idp.kind !== 'keycloak') problems.push('DESK_IDP가 없어요(운영은 회사 IdP로만 로그인해요)');
    else if (!config.idp.issuer.startsWith('https://')) problems.push('DESK_IDP_ISSUER는 https 주소여야 해요');
    if (env.DESK_SEED_DEMO === 'true') problems.push('운영에는 가상 자료를 넣지 않아요. DESK_SEED_DEMO를 지워 주세요');
  }
  return problems;
}

/** 사내 망·관문 설정 검사(사내망·밖 접속 회의, 10/28). 틀리면 조용히 무시되거나 위조 IP를 믿는 값들이에요. */
function networkProblems(env: NodeJS.ProcessEnv, runtime: Runtime): string[] {
  const problems: string[] = [];
  // TRUST_PROXY에는 관문 주소만 넣어요. true는 위조한 X-Forwarded-For를 믿고, 숫자("1")는 0.0.0.1로 읽혀 아무도 믿지 않아요.
  const trust = list(env.TRUST_PROXY);
  if (env.TRUST_PROXY === 'true') problems.push('TRUST_PROXY=true는 위조한 접속 IP를 믿어요. 관문 주소만 넣어 주세요');
  else if (trust.some((t) => /^\d+$/.test(t))) problems.push('TRUST_PROXY에 숫자(단계 수)는 쓸 수 없어요. 관문 주소만 넣어 주세요');
  else if (trust.some((t) => ['loopback', 'linklocal', 'uniquelocal'].includes(t)))
    problems.push('TRUST_PROXY에 이름 대역은 너무 넓어요. 관문 주소만 넣어 주세요');

  // 사내 프록시로 나가야 할 때: HTTPS_PROXY만 넣으면 Node가 조용히 무시해요(NODE_USE_ENV_PROXY=1 또는 --use-env-proxy가 있어야 해요).
  const proxyVars = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].filter((name) => env[name]);
  const proxyOn = env.NODE_USE_ENV_PROXY === '1' || [...runtime.execArgv, ...list(env.NODE_OPTIONS?.replace(/\s+/g, ','))].includes('--use-env-proxy');
  if (proxyVars.length && !proxyOn && env.NODE_USE_ENV_PROXY !== '0')
    problems.push(`${proxyVars[0]}이 있지만 Node가 쓰지 않아요. NODE_USE_ENV_PROXY=1을 넣거나, 일부러 끄려면 NODE_USE_ENV_PROXY=0을 넣어 주세요`);
  if (proxyVars.length && proxyOn && !nodeSupportsEnvProxy(runtime.node))
    problems.push(`Node ${runtime.node}는 NODE_USE_ENV_PROXY가 없어요(22.21 또는 24.0 이상)`);
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') problems.push('NODE_TLS_REJECT_UNAUTHORIZED=0을 지워 주세요. 사내 인증서는 NODE_EXTRA_CA_CERTS로 믿게 해요');

  // 앱은 이 주소 뒤에 경로를 바로 이어 붙여요(OIDC 되돌아오기·MCP·링크). 주소 맨 위여야 해요.
  if (env.PUBLIC_BASE_URL?.startsWith('https://')) {
    try {
      const url = new URL(env.PUBLIC_BASE_URL);
      if (url.pathname !== '/' || env.PUBLIC_BASE_URL.endsWith('/') || url.search || url.hash)
        problems.push('PUBLIC_BASE_URL은 https://이름 모양이어야 해요(경로·끝 /·쿼리 없이)');
    } catch {
      problems.push('PUBLIC_BASE_URL을 주소로 읽지 못했어요');
    }
  }
  if (env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_BASE_URL.startsWith('https://')) problems.push('ANTHROPIC_BASE_URL은 https 주소여야 해요');
  return problems;
}

/** NODE_USE_ENV_PROXY가 fetch에 들어온 판: 22.21 이상(22.x) 또는 24.0 이상 */
export function nodeSupportsEnvProxy(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, runtime: Runtime = { node: process.versions.node, execArgv: process.execArgv }): ServerConfig {
  // "prod"·"Production" 같은 값은 개발 모드로 떠서 모의 로그인이 열려요. 정해진 셋 말고는 뜨지 않아요(QA-47).
  if (env.NODE_ENV && !NODE_ENVS.includes(env.NODE_ENV)) throw new Error(`NODE_ENV는 ${NODE_ENVS.join('·')} 중 하나여야 해요`);
  const requireMfa = env.DESK_REQUIRE_MFA ?? 'off';
  if (!(MFA_POLICIES as readonly string[]).includes(requireMfa)) throw new Error(`DESK_REQUIRE_MFA는 ${MFA_POLICIES.join('·')} 중 하나여야 해요`);
  const production = env.NODE_ENV === 'production';
  const demo = !production || env.DESK_MOCK_LOGIN === 'true';
  // 운영 검사(productionProblems)가 빠진 값·개발용 값을 막아요. 개발은 아래 개발용 값을 써요.
  const secret = (name: string, devDefault: string) => env[name] || (production ? '' : devDefault);
  const config: ServerConfig = {
    // PORT는 미리보기 도구·호스팅이 웹 포트로 넘기는 경우가 있어서 서버는 SERVER_PORT를 따로 써요.
    port: Number(env.SERVER_PORT ?? 3190),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:5190',
    sessionSecret: secret('SESSION_SECRET', 'dev-only-session-secret-change-me-0000'),
    pseudonymSecret: secret('PSEUDONYM_SECRET', 'dev-only-pseudonym-secret-change-me-00'),
    proposalSecret: secret('PROPOSAL_SECRET', 'dev-only-proposal-secret-change-me-000'),
    mcpTokenSecret: secret('MCP_TOKEN_SECRET', 'dev-only-mcp-token-secret-change-me-000'),
    databaseUrl: env.DATABASE_URL || undefined,
    noRetentionContractConfirmed: env.NO_RETENTION_CONTRACT_CONFIRMED === 'true',
    aiProvider: env.DESK_AI_PROVIDER === 'anthropic' ? 'anthropic' : 'fake',
    aiModel: env.DESK_AI_MODEL ?? 'claude-opus-5-5',
    seedDemo: env.DESK_SEED_DEMO ? env.DESK_SEED_DEMO === 'true' : demo,
    production,
    demo,
    migrateOnStart: env.DESK_MIGRATE_ON_START ? env.DESK_MIGRATE_ON_START === 'true' : demo,
    host: env.HOST || (production ? '0.0.0.0' : 'localhost'),
    trustProxy: !env.TRUST_PROXY ? false : env.TRUST_PROXY === 'true' ? true : env.TRUST_PROXY,
    idp:
      env.DESK_IDP === 'keycloak'
        ? {
            kind: 'keycloak',
            issuer: env.DESK_IDP_ISSUER ?? 'http://localhost:8180/realms/one-line-desk',
            clientId: env.DESK_IDP_CLIENT_ID ?? 'one-line-desk-web',
            clientSecret: secret('DESK_IDP_CLIENT_SECRET', 'dev-only-idp-web-secret-change-me'),
            directoryClientId: env.DESK_IDP_DIRECTORY_CLIENT_ID ?? 'one-line-desk-directory',
            directoryClientSecret: secret('DESK_IDP_DIRECTORY_CLIENT_SECRET', 'dev-only-idp-directory-secret-change-me'),
          }
        : { kind: 'mock' },
    slackBotToken: env.SLACK_BOT_TOKEN || undefined,
    requireMfa: requireMfa as ServerConfig['requireMfa'],
    mfaAmr: env.DESK_IDP_MFA_AMR ? list(env.DESK_IDP_MFA_AMR) : DEFAULT_MFA_AMR,
    mfaAcr: list(env.DESK_IDP_MFA_ACR),
    acrValues: env.DESK_IDP_ACR_VALUES || undefined,
  };
  if (production) {
    const problems = productionProblems(env, config, runtime);
    if (problems.length) throw new Error(`운영 설정을 확인해 주세요:\n- ${problems.join('\n- ')}`);
  }
  return config;
}
