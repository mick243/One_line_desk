import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export interface ServerConfig {
  port: number;
  sessionSecret: string;
  pseudonymSecret: string;
  databaseUrl: string | undefined;
  noRetentionContractConfirmed: boolean;
  production: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const sessionSecret = env.SESSION_SECRET ?? 'dev-only-session-secret-change-me-0000';
  const pseudonymSecret = env.PSEUDONYM_SECRET ?? 'dev-only-pseudonym-secret-change-me-00';
  if (production && (!env.SESSION_SECRET || !env.PSEUDONYM_SECRET)) {
    throw new Error('운영 환경에서는 SESSION_SECRET과 PSEUDONYM_SECRET을 꼭 넣어야 해요');
  }
  return {
    // PORT는 미리보기 도구·호스팅이 웹 포트로 넘기는 경우가 있어서 서버는 SERVER_PORT를 따로 써요.
    port: Number(env.SERVER_PORT ?? 3190),
    sessionSecret,
    pseudonymSecret,
    databaseUrl: env.DATABASE_URL || undefined,
    noRetentionContractConfirmed: env.NO_RETENTION_CONTRACT_CONFIRMED === 'true',
    production,
  };
}
