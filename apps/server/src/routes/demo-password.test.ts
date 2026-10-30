import { describe, expect, it } from 'vitest';
import { createMockAdapters } from '../adapters';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { createTestDb } from '../core/db/test-db';
import { MOCK } from '../testing';
import { DEMO_PASSWORD_TRIES } from './auth';

// 시연 비밀번호(10/30 Vercel 배포 회의). 웹 화면이 공개 주소(Vercel)에 있어서 모의 로그인을 비밀번호 뒤에 둬요.

const PASSWORD = 'desk-demo-password-1030';
const SECRETS = { SESSION_SECRET: 's'.repeat(40), PSEUDONYM_SECRET: 'p'.repeat(40), PROPOSAL_SECRET: 'q'.repeat(40), MCP_TOKEN_SECRET: 'm'.repeat(40) };

async function withApp(
  demoPassword: string | undefined,
  run: (app: Awaited<ReturnType<typeof buildApp>>['app'], advance: (ms: number) => void) => Promise<void>,
) {
  let clock = Date.parse('2026-10-30T09:00:00+09:00');
  const db = await createTestDb();
  const built = await buildApp({
    config: { ...loadConfig({}), databaseUrl: undefined, demoPassword },
    db,
    adapters: createMockAdapters(),
    now: () => clock,
    seed: false,
    retentionTimer: false,
  });
  try {
    await run(built.app, (ms) => (clock += ms));
  } finally {
    await built.app.close();
    await db.close();
  }
}

describe('시연 비밀번호', () => {
  it('넣으면 비밀번호가 맞아야 모의 로그인이 돼요. 공개 설정은 받아야 하는지만 알려 주고 값은 내보내지 않아요', async () => {
    await withApp(PASSWORD, async (app) => {
      const config = (await app.inject({ method: 'GET', url: '/api/config/public' })).json();
      expect(config.login).toEqual({ kind: 'mock', password: true });
      expect(JSON.stringify(config)).not.toContain(PASSWORD);

      const login = (payload: object) => app.inject({ method: 'POST', url: '/api/auth/login', payload });
      const none = await login({ idpSubject: MOCK.staff });
      expect(none.statusCode).toBe(401);
      expect(none.json()).toEqual({ error: 'demo-password', message: '시연 비밀번호가 맞지 않아요' });
      expect(none.headers['set-cookie']).toBeUndefined();
      expect((await login({ idpSubject: MOCK.staff, password: 'wrong' })).statusCode).toBe(401);
      expect((await login({ idpSubject: MOCK.staff, password: PASSWORD })).statusCode).toBe(200);
    });
  });

  it('1분에 정한 횟수보다 많이 틀리면 맞는 비밀번호도 잠시 받지 않아요', async () => {
    await withApp(PASSWORD, async (app, advance) => {
      const login = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { idpSubject: MOCK.staff, password } });
      for (let i = 0; i < DEMO_PASSWORD_TRIES; i++) expect((await login(`wrong-${i}`)).statusCode).toBe(401);
      const locked = await login(PASSWORD);
      expect(locked.statusCode).toBe(429);
      expect(locked.json().error).toBe('demo-password-locked');
      advance(60_001);
      expect((await login(PASSWORD)).statusCode).toBe(200);
    });
  });

  it('넣지 않으면 지금처럼 고르기만 하면 들어와요', async () => {
    await withApp(undefined, async (app) => {
      expect((await app.inject({ method: 'GET', url: '/api/config/public' })).json().login).toEqual({ kind: 'mock', password: false });
      expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { idpSubject: MOCK.staff } })).statusCode).toBe(200);
    });
  });

  it('운영 설정: 시연 배포에서는 12자 이상이어야 하고, 운영 배포에는 넣지 못해요', () => {
    const demo = { NODE_ENV: 'production', DESK_MOCK_LOGIN: 'true', PUBLIC_BASE_URL: 'https://demo.example.com', ...SECRETS };
    expect(loadConfig({ ...demo, DESK_DEMO_PASSWORD: PASSWORD }).demoPassword).toBe(PASSWORD);
    expect(() => loadConfig({ ...demo, DESK_DEMO_PASSWORD: 'short' })).toThrow('DESK_DEMO_PASSWORD는 12자 이상이어야 해요');
    const prod = {
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://desk.example.com',
      DATABASE_URL: 'postgres://desk@db.example.com/desk',
      TRUST_PROXY: '10.0.3.11',
      DESK_IDP: 'keycloak',
      DESK_IDP_ISSUER: 'https://idp.example.com/realms/desk',
      DESK_IDP_CLIENT_SECRET: 'c'.repeat(40),
      DESK_IDP_DIRECTORY_CLIENT_SECRET: 'd'.repeat(40),
      ...SECRETS,
    };
    expect(() => loadConfig({ ...prod, DESK_DEMO_PASSWORD: PASSWORD })).toThrow('DESK_DEMO_PASSWORD는 시연 배포에만 넣어요');
  });
});
