import { describe, expect, it } from 'vitest';
import { createMockAdapters, type Adapters } from './adapters';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createTestDb } from './core/db/test-db';

// 운영 설정이 실수하면 닫히게(L-15)와 mock 판정 한 곳(L-16). 비밀 값은 시험용 가짜 값이에요.

const SECRETS = { SESSION_SECRET: 's'.repeat(40), PSEUDONYM_SECRET: 'p'.repeat(40), PROPOSAL_SECRET: 'q'.repeat(40), MCP_TOKEN_SECRET: 'm'.repeat(40) };
const IDP = {
  DESK_IDP: 'keycloak',
  DESK_IDP_ISSUER: 'https://idp.example.com/realms/desk',
  DESK_IDP_CLIENT_SECRET: 'c'.repeat(40),
  DESK_IDP_DIRECTORY_CLIENT_SECRET: 'd'.repeat(40),
};
/** 실제 운영에 필요한 값을 모두 넣은 환경 */
const PROD = { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://desk.example.com', DATABASE_URL: 'postgres://desk@db.example.com/desk', ...SECRETS, ...IDP };

const problemsOf = (env: NodeJS.ProcessEnv): string => {
  try {
    loadConfig(env);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};

describe('운영 설정이 실수하면 닫혀요(L-15)', () => {
  it('값을 모두 넣으면 뜨고, 가상 자료는 넣지 않아요', () => {
    const config = loadConfig(PROD);
    expect(config).toMatchObject({ production: true, demo: false, seedDemo: false });
  });

  it.each([
    ['DATABASE_URL', 'DATABASE_URL이 없어요'],
    ['PUBLIC_BASE_URL', 'PUBLIC_BASE_URL은 https 주소여야 해요'],
    ['SESSION_SECRET', 'SESSION_SECRET이 없어요'],
    ['MCP_TOKEN_SECRET', 'MCP_TOKEN_SECRET이 없어요'],
    ['DESK_IDP', 'DESK_IDP가 없어요'],
    ['DESK_IDP_DIRECTORY_CLIENT_SECRET', 'DESK_IDP_DIRECTORY_CLIENT_SECRET이 없어요'],
  ])('%s 하나만 빠져도 이유를 말하고 뜨지 않아요', (name, reason) => {
    const env: NodeJS.ProcessEnv = { ...PROD };
    delete env[name];
    expect(problemsOf(env)).toContain(reason);
  });

  it.each([
    [{ SESSION_SECRET: 'dev-only-session-secret-change-me-0000' }, 'SESSION_SECRET이 개발용 값이에요'],
    [{ PROPOSAL_SECRET: 'short' }, 'PROPOSAL_SECRET은 32자 이상이어야 해요'],
    [{ PROPOSAL_SECRET: 's'.repeat(40) }, '비밀 값끼리는 서로 달라야 해요'],
    [{ PUBLIC_BASE_URL: 'http://desk.example.com' }, 'PUBLIC_BASE_URL은 https 주소여야 해요'],
    [{ DESK_IDP_ISSUER: 'http://localhost:8180/realms/one-line-desk' }, 'DESK_IDP_ISSUER는 https 주소여야 해요'],
    [{ ANTHROPIC_LOG: 'debug' }, 'ANTHROPIC_LOG를 지워 주세요'],
    [{ DESK_AI_PROVIDER: 'anthropic', DESK_AI_MODEL: 'some-other-model' }, 'DESK_AI_MODEL은'],
    [{ DESK_SEED_DEMO: 'true' }, '운영에는 가상 자료를 넣지 않아요'],
  ])('잘못된 값 %o → 뜨지 않아요', (patch, reason) => {
    expect(problemsOf({ ...PROD, ...patch })).toContain(reason);
  });

  it('빈 운영 환경은 빠진 값을 한 번에 모두 알려 줘요', () => {
    const message = problemsOf({ NODE_ENV: 'production' });
    for (const reason of ['SESSION_SECRET이 없어요', 'PSEUDONYM_SECRET이 없어요', 'PUBLIC_BASE_URL', 'DATABASE_URL', 'DESK_IDP가 없어요'])
      expect(message).toContain(reason);
  });

  it('시연 배포(DESK_MOCK_LOGIN=true)는 IdP·PostgreSQL 없이 뜨고 가상 자료를 넣어요. 비밀 값 검사는 같아요', () => {
    const demo = { NODE_ENV: 'production', DESK_MOCK_LOGIN: 'true', PUBLIC_BASE_URL: 'https://demo.example.com', ...SECRETS };
    expect(loadConfig(demo)).toMatchObject({ production: true, demo: true, seedDemo: true });
    expect(problemsOf({ ...demo, SESSION_SECRET: 'change-me-session-secret-at-least-32-chars' })).toContain('개발용 값');
  });

  it('개발은 개발용 값으로 떠요', () => {
    expect(loadConfig({})).toMatchObject({ production: false, demo: true, seedDemo: true });
  });
});

describe('mock 판정 한 곳(L-16)', () => {
  /** 모의 직원 명단을 쓰되 고르기 목록이 없는 IdP(운영처럼 리디렉트 로그인만 있다고 쳐요). */
  function realLikeAdapters(): Adapters {
    const mock = createMockAdapters();
    const idp = {
      capabilities: { name: 'company-idp', label: '회사 IdP(시험)', mock: false },
      authenticate: (s: string) => mock.employees.authenticate(s),
      isActive: (s: string) => mock.employees.isActive(s),
    };
    return { idp, directory: mock.employees, all: () => [idp.capabilities] };
  }

  it('운영에서는 모의 바깥 어댑터와 시연 MCP 클라이언트가 0개이고, MCP를 켤 수 없어요', async () => {
    const db = await createTestDb();
    try {
      const prod = await buildApp({ config: loadConfig(PROD), db, adapters: realLikeAdapters(), seed: true });
      const pub = (await prod.app.inject({ method: 'GET', url: '/api/config/public' })).json();
      expect(pub.demoData).not.toEqual(expect.arrayContaining(['그룹웨어 캘린더(모의)', 'Slack(모의)']));
      expect(pub.inviteChannels).toEqual({ calendar: '그룹웨어 캘린더(연결 안 함)', slack: 'Slack(연결 안 함)' });
      expect((await db.query('select * from mcp_clients')).rows).toEqual([]);
      expect(await prod.ctx.services.mcp!.canEnable()).toBe(false);
      await prod.app.close();

      // 같은 DB에 시연 클라이언트가 남아 있어도(시연 → 운영) 허용 목록에 들지 않아요.
      const demo = await buildApp({
        config: loadConfig({ NODE_ENV: 'production', DESK_MOCK_LOGIN: 'true', PUBLIC_BASE_URL: 'https://demo.example.com', ...SECRETS }),
        db,
        seed: true,
      });
      expect((await db.query('select * from mcp_clients')).rows).toHaveLength(1);
      expect(await demo.ctx.services.mcp!.canEnable()).toBe(true);
      await demo.app.close();
      const again = await buildApp({ config: loadConfig(PROD), db, adapters: realLikeAdapters(), seed: false });
      expect(await again.ctx.services.mcp!.canEnable()).toBe(false);
      await again.app.close();
    } finally {
      await db.close();
    }
  });
});
