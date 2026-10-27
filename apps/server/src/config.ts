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
}

/** 운영에서 받는 모델(BE-3). 목록 밖 값으로는 뜨지 않아요. */
export const ALLOWED_AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

const SECRET_MIN = 32;

/**
 * 운영 설정이 실수하면 닫혀요(L-15). 값 하나만 빠지거나 개발용이어도 이유를 모두 말하고 뜨지 않아요.
 * 시연 배포(DESK_MOCK_LOGIN=true)는 회사 IdP·PostgreSQL 없이도 뜨지만, 비밀 값·주소 검사는 같아요.
 */
function productionProblems(env: NodeJS.ProcessEnv, config: ServerConfig): string[] {
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
  if (!config.demo) {
    if (!config.databaseUrl) problems.push('DATABASE_URL이 없어요(운영은 PostgreSQL만 써요)');
    if (config.idp.kind !== 'keycloak') problems.push('DESK_IDP가 없어요(운영은 회사 IdP로만 로그인해요)');
    else if (!config.idp.issuer.startsWith('https://')) problems.push('DESK_IDP_ISSUER는 https 주소여야 해요');
    if (env.DESK_SEED_DEMO === 'true') problems.push('운영에는 가상 자료를 넣지 않아요. DESK_SEED_DEMO를 지워 주세요');
  }
  return problems;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
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
  };
  if (production) {
    const problems = productionProblems(env, config);
    if (problems.length) throw new Error(`운영 설정을 확인해 주세요:\n- ${problems.join('\n- ')}`);
  }
  return config;
}
