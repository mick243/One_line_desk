import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { createTestApp, MOCK } from '../testing';

// 시연 떼기(10/29 배포 준비 회의 A8·D8·쟁점 5). 시연은 모의 로그인이라 여러 사람이 같은 가상 직원으로 들어와요.

describe('시연 배포(배포 준비 회의 A8·쟁점 5)', () => {
  it('시연(모의 로그인)의 응답은 검색에 걸리지 않게 noindex예요', async () => {
    const t = await createTestApp();
    try {
      const res = await t.app.inject({ method: 'GET', url: '/api/config/public' });
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    } finally {
      await t.close();
    }
  });

  it('명단 밖으로 넓힌 시연(DESK_DEMO_WIDE)은 문의를 저장하지 않고, 운영 설정을 바꾸지 못해요. 운영 설정 보기는 돼요', async () => {
    const t = await createTestApp();
    try {
      t.ctx.config.demoWide = true;
      const me = await t.loginAs(MOCK.staff);
      const inquiry = await me.call('POST', '/api/navi/inquiries', {
        rowId: null,
        question: '가상 질문이에요',
        reason: '시연 확인',
        requestId: 'req-demo-0001',
      });
      expect(inquiry).toEqual({ status: 409, body: { error: 'demo-locked', message: '시연에서는 보내지 않아요' } });
      const { rows } = await t.db.query<{ n: number }>('select count(*)::int as n from navi_inquiries');
      expect(rows[0]!.n).toBe(0);

      const op = await t.loginAs(MOCK.operator);
      expect((await op.call('GET', '/api/ops/settings')).status).toBe(200);
      for (const [path, body] of [
        ['/api/ops/flag', { flag: 'roomsWrite', value: false }],
        ['/api/ops/switch', { module: 'notices', value: 'off' }],
        ['/api/ops/values', { rateLimitPerMinute: 10 }],
      ] as const) {
        expect(await op.call('PUT', path, body), path).toEqual({
          status: 403,
          body: { error: 'demo-locked', message: '넓게 연 시연에서는 운영 설정을 바꾸지 않아요' },
        });
      }
    } finally {
      await t.close();
    }
  });

  it('DESK_DEMO_WIDE는 시연에만 뜻이 있고, 운영 배포에 섞이면 뜨지 않아요', () => {
    const secrets = { SESSION_SECRET: 's'.repeat(40), PSEUDONYM_SECRET: 'p'.repeat(40), PROPOSAL_SECRET: 'q'.repeat(40), MCP_TOKEN_SECRET: 'm'.repeat(40) };
    const demo = { NODE_ENV: 'production', DESK_MOCK_LOGIN: 'true', PUBLIC_BASE_URL: 'https://demo.example.com', ...secrets };
    expect(loadConfig(demo).demoWide).toBe(false);
    expect(loadConfig({ ...demo, DESK_DEMO_WIDE: 'true' }).demoWide).toBe(true);
    const prod = {
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://desk.example.com',
      DATABASE_URL: 'postgres://desk@db.example.com/desk',
      TRUST_PROXY: '10.0.3.11',
      DESK_IDP: 'keycloak',
      DESK_IDP_ISSUER: 'https://idp.example.com/realms/desk',
      DESK_IDP_CLIENT_SECRET: 'c'.repeat(40),
      DESK_IDP_DIRECTORY_CLIENT_SECRET: 'd'.repeat(40),
      ...secrets,
    };
    expect(() => loadConfig({ ...prod, DESK_DEMO_WIDE: 'true' })).toThrow(/DESK_DEMO_WIDE는 시연 배포에만/);
  });
});
