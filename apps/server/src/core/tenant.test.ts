import { describe, expect, it } from 'vitest';
import {
  checkTenantEnv,
  insideDir,
  newTenantId,
  parseEnvFile,
  PLACEHOLDER,
  TENANT_ID,
  tenantAppName,
  tenantEnvTemplate,
  tenantFlyToml,
  tenantSecrets,
} from '../../scripts/tenant-lib';

// 회사별 분리(ADR-23): 회사마다 앱 한 벌. 이름 대신 ID, 회사마다 다른 비밀 값, 저장소 밖 비공개 폴더, 채우지 않으면 배포하지 않아요.

/** 틀을 실제 값으로 채운 회사 한 벌 */
function filled(id = 't-abc123'): Record<string, string> {
  const env = parseEnvFile(tenantEnvTemplate(id));
  return {
    ...env,
    PUBLIC_BASE_URL: 'https://desk.example-corp.test',
    DATABASE_URL: 'postgres://desk@db.internal/desk',
    TRUST_PROXY: '10.0.3.11',
    DESK_IDP_ISSUER: 'https://idp.example-corp.test/realms/desk',
    DESK_IDP_CLIENT_SECRET: 'c'.repeat(40),
    DESK_IDP_DIRECTORY_CLIENT_SECRET: 'd'.repeat(40),
  };
}

describe('회사 한 벌(ADR-23)', () => {
  it('회사 ID는 무작위 t-xxxxxx이고, 앱 이름도 ID에서만 만들어요', () => {
    const ids = new Set(Array.from({ length: 50 }, newTenantId));
    expect([...ids].every((id) => TENANT_ID.test(id))).toBe(true);
    expect(ids.size).toBe(50);
    expect(tenantAppName('t-abc123')).toBe('desk-t-abc123');
    expect(() => tenantEnvTemplate('acme-corp')).toThrow('회사 ID는');
    expect(() => tenantFlyToml('t-ACME')).toThrow('회사 ID는');
  });

  it('비밀 값은 회사마다 새로 만들고, 서로 다르고, 운영 검사(32자 이상)를 지나요', () => {
    const a = tenantSecrets();
    const b = tenantSecrets();
    expect(Object.values(a).every((v) => v.length >= 32)).toBe(true);
    expect(new Set(Object.values(a)).size).toBe(4);
    expect(Object.values(a).some((v) => Object.values(b).includes(v))).toBe(false);
  });

  it('채우지 않은 값이 있으면 이름만 말하고 멈춰요. 값은 돌려주지 않아요', () => {
    const env = parseEnvFile(tenantEnvTemplate('t-abc123'));
    const problems = checkTenantEnv(env);
    expect(problems).toEqual(
      expect.arrayContaining(['PUBLIC_BASE_URL 값을 채워 주세요', 'DATABASE_URL 값을 채워 주세요', 'DESK_IDP_CLIENT_SECRET 값을 채워 주세요']),
    );
    expect(problems.join('\n')).not.toContain(env.SESSION_SECRET!);
    expect(problems.join('\n')).not.toContain(PLACEHOLDER);
  });

  it('다 채우면 운영 설정 검사를 지나요. 시연 깃발·개발 모드는 회사 한 벌에 넣지 못해요', () => {
    expect(checkTenantEnv(filled())).toEqual([]);
    expect(checkTenantEnv({ ...filled(), DESK_MOCK_LOGIN: 'true' })).toContain('회사 한 벌에는 DESK_MOCK_LOGIN을 넣지 않아요(시연 배포가 아니에요)');
    expect(checkTenantEnv({ ...filled(), NODE_ENV: 'development' })).toContain('회사 한 벌은 NODE_ENV=production이어야 해요');
    // 운영 검사(config.ts)에 걸리는 것도 그대로 알려요.
    expect(checkTenantEnv({ ...filled(), TRUST_PROXY: '10.0.0.0/8' }).join('\n')).toContain('너무 넓어요');
  });

  it('틀과 fly.toml에는 회사 이름 자리가 없고, 운영은 늘 켜진 한 대·배포 전 마이그레이션이에요', () => {
    const toml = tenantFlyToml('t-abc123');
    expect(toml).toContain('app = "desk-t-abc123"');
    expect(toml).toContain('release_command = "node --import tsx apps/server/scripts/migrate.ts"');
    expect(toml).toContain('auto_stop_machines = "off"');
    expect(toml).toContain('min_machines_running = 1');
    const env = parseEnvFile(tenantEnvTemplate('t-abc123'));
    expect(env).toMatchObject({ NODE_ENV: 'production', DESK_IDP: 'keycloak', DESK_AI_PROVIDER: 'fake' });
    expect(env.DESK_MOCK_LOGIN).toBeUndefined();
  });

  it('회사 폴더는 저장소 밖이어야 해요(커밋되면 고객 목록이 드러나요)', () => {
    expect(insideDir('/repo/tenants', '/repo')).toBe(true);
    expect(insideDir('/repo', '/repo')).toBe(true);
    expect(insideDir('/private/desk-tenants', '/repo')).toBe(false);
    expect(insideDir('/repo-tenants', '/repo')).toBe(false);
  });

  it('설정 파일은 # 주석·빈 줄을 건너뛰고 따옴표를 벗겨요', () => {
    expect(parseEnvFile('# 주석\n\nA=1\nB="두 글자"\nC=\'x=y\'\n')).toEqual({ A: '1', B: '두 글자', C: 'x=y' });
  });
});
