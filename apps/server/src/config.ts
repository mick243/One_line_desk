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
  /** 비어 있는 DB에 가상 자료(등급 0)를 넣을지 */
  seedDemo: boolean;
  production: boolean;
  /** 모의 로그인(가상 직원 고르기)을 열지. 개발은 늘 열고, 운영은 시연 배포에서 DESK_MOCK_LOGIN=true일 때만 열어요. */
  mockLogin: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const secret = (name: string, devDefault: string) => {
    const value = env[name];
    if (production && !value) throw new Error(`운영 환경에서는 ${name}을 꼭 넣어야 해요`);
    return value ?? devDefault;
  };
  return {
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
    seedDemo: env.DESK_SEED_DEMO !== 'false',
    production,
    mockLogin: !production || env.DESK_MOCK_LOGIN === 'true',
  };
}
