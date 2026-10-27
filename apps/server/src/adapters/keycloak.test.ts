import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { safeReturnPath } from '../routes/auth';
import { createTestApp } from '../testing';
import { KeycloakAdapter, profileFromGroups } from './keycloak';
import { SlackMessenger } from './slack';
import type { Adapters } from '.';

// 임시 IdP(Keycloak) 어댑터와 IdP 로그인 경로 시험(10/26). 진짜 Keycloak 대신 같은 모양으로 답하는 가짜 IdP를 써요.

const ISSUER = 'http://idp.test/realms/one-line-desk';
const CFG = { issuer: ISSUER, clientId: 'web', clientSecret: 'web-secret', directoryClientId: 'dir', directoryClientSecret: 'dir-secret' };
const NOW = Date.parse('2026-10-26T09:00:00+09:00');

const USERS = [
  {
    id: 'u-doyun',
    username: 'doyun',
    firstName: '도윤',
    lastName: '가상 직원',
    email: 'doyun@corp.example',
    enabled: true,
    groups: ['/부서/개발팀', '/층/5층', '/역할/facilities'],
  },
  {
    id: 'u-seojun',
    username: 'seojun',
    firstName: '서준',
    lastName: '가상 직원',
    email: 'seojun@corp.example',
    enabled: true,
    groups: ['/부서/개발팀', '/층/5층'],
  },
  { id: 'u-left', username: 'left', firstName: '퇴사', lastName: '가상 직원', email: 'left@corp.example', enabled: false, groups: ['/부서/개발팀'] },
  { id: 'u-svc', username: 'service-account-dir', enabled: true, groups: [] },
];

async function fakeIdp() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const state = { nonce: '', calls: [] as string[] };
  const sign = (claims: Record<string, unknown>, aud = CFG.clientId) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(aud)
      .setIssuedAt(NOW / 1000)
      .setExpirationTime(NOW / 1000 + 300)
      .sign(privateKey);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    state.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/certs` });
    }
    if (url.pathname === '/realms/one-line-desk/token') {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'client_credentials') return json({ access_token: 'svc-token', expires_in: 300 });
      if (form.get('code') === 'good') {
        return json({
          id_token: await sign({
            sub: 'u-doyun',
            nonce: state.nonce,
            given_name: '도윤',
            family_name: '가상 직원',
            email: 'doyun@corp.example',
            groups: ['/부서/개발팀', '/층/5층', '/역할/facilities'],
          }),
        });
      }
      if (form.get('code') === 'other-audience') return json({ id_token: await sign({ sub: 'u-doyun', nonce: state.nonce }, 'someone-else') });
      return json({ error: 'invalid_grant' }, 400);
    }
    if (url.pathname.startsWith('/admin/realms/one-line-desk/users')) {
      const parts = url.pathname.split('/').filter(Boolean); // admin realms one-line-desk users [id] [groups]
      if (parts.length === 4) return json(USERS.map(({ groups: _g, ...u }) => u));
      const user = USERS.find((u) => u.id === parts[4]);
      if (!user) return json({ error: 'not found' }, 404);
      if (parts[5] === 'groups') return json(user.groups.map((path) => ({ path })));
      const { groups: _g, ...rest } = user;
      return json(rest);
    }
    return json({ error: 'unknown' }, 404);
  }) as typeof fetch;
  const adapter = new KeycloakAdapter(CFG, fetchImpl, () => NOW, createLocalJWKSet({ keys: [jwk] }));
  return { adapter, state };
}

describe('임시 IdP 어댑터', () => {
  it('그룹 경로에서 부서·층·역할을 읽어요', () => {
    expect(profileFromGroups(['/부서/총무팀', '/층/2층', '/역할/facilities', '/기타/모름'])).toEqual({
      department: '총무팀',
      floor: '2층',
      groups: ['facilities'],
    });
  });

  it('ID 토큰을 검증해서 직원 정보로 바꾸고, nonce·대상이 다르면 받지 않아요', async () => {
    const { adapter, state } = await fakeIdp();
    state.nonce = 'n-1';
    const p = { codeVerifier: 'v', nonce: 'n-1', redirectUri: 'http://app.test/api/auth/oidc/callback' };
    expect(await adapter.finishLogin({ ...p, code: 'good' })).toEqual({
      idpSubject: 'kc|u-doyun',
      displayName: '가상 직원 도윤',
      department: '개발팀',
      floor: '5층',
      groups: ['facilities'],
      email: 'doyun@corp.example',
    });
    expect(await adapter.finishLogin({ ...p, code: 'good', nonce: 'other' })).toBeNull();
    expect(await adapter.finishLogin({ ...p, code: 'other-audience' })).toBeNull();
    expect(await adapter.finishLogin({ ...p, code: 'bad' })).toBeNull();
  });

  it('직원 검색은 재직자만, 서비스 계정은 빼고 줘요. 재직 확인은 IdP에 바로 물어요', async () => {
    const { adapter } = await fakeIdp();
    expect((await adapter.search('개발', 10)).map((x) => x.displayName)).toEqual(['가상 직원 도윤', '가상 직원 서준']);
    expect(await adapter.search('service', 10)).toEqual([]);
    expect(await adapter.getProfile('kc|u-left')).toMatchObject({ displayName: '가상 직원 퇴사' });
    expect(await adapter.isActive('kc|u-seojun')).toBe(true);
    expect(await adapter.isActive('kc|u-left')).toBe(false);
    expect(await adapter.isActive('kc|nobody')).toBe(false);
    expect(await adapter.isActive('mock|emp-001')).toBe(false);
  });
});

describe('IdP 로그인 경로(OIDC 인가 코드 + PKCE)', () => {
  const opened: Awaited<ReturnType<typeof createTestApp>>[] = [];
  afterEach(async () => {
    while (opened.length) await opened.pop()!.close();
  });

  async function setup() {
    const { adapter, state } = await fakeIdp();
    const adapters: Adapters = { idp: adapter, directory: adapter, all: () => [adapter.capabilities] };
    const t = await createTestApp({ adapters, start: NOW });
    opened.push(t);
    return { t, state };
  }

  it('시작하면 state·nonce·S256 검증 값을 붙여 IdP로 보내고, 돌아오면 세션을 열고 원래 화면으로 가요', async () => {
    const { t, state } = await setup();
    const start = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/start?return=%2Foauth%2Fconsent%3Freq%3Dabc' });
    expect(start.statusCode).toBe(302);
    const auth = new URL(String(start.headers.location));
    expect(auth.origin + auth.pathname).toBe(`${ISSUER}/auth`);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('redirect_uri')).toBe('http://localhost:5190/api/auth/oidc/callback');
    state.nonce = auth.searchParams.get('nonce')!;

    const back = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=good&state=${auth.searchParams.get('state')}` });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('/oauth/consent?req=abc');
    const cookie = String(back.headers['set-cookie']).split(';')[0]!;
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    expect(me).toMatchObject({ displayName: '가상 직원 도윤', department: '개발팀', floor: '5층', roles: expect.arrayContaining(['facilities']) });

    // 같은 state는 한 번만 써요.
    const replay = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=good&state=${auth.searchParams.get('state')}` });
    expect(replay.headers.location).toBe('/?login=failed');
  });

  it('다른 사이트로는 돌려보내지 않고, 모의 로그인은 닫혀 있어요', async () => {
    const { t, state } = await setup();
    // QA-1: tab·줄바꿈·`\`·인코딩한 `/`·전각 `／`·`..`로 돌아 나가는 주소도 앱 첫 화면으로 보내요. 콜백은 500이 나지 않아요.
    const bads = ['//evil.example/x', 'https://evil.example', '/\\evil', '/api/me', '/\t/evil.example', '/\n/evil.example', '/\r/evil.example'];
    bads.push('/%5cevil', '/%2fevil.example', '/%2F%2Fevil', '/／evil.example', '/./api/me', '/a/../api/me', '/..//evil.example', '/ x');
    for (const bad of bads) {
      const start = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/start?return=${encodeURIComponent(bad)}` });
      const auth = new URL(String(start.headers.location)).searchParams;
      state.nonce = auth.get('nonce')!;
      const back = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=good&state=${auth.get('state')}` });
      expect(back.statusCode, bad).toBe(302);
      expect(back.headers.location, bad).toBe('/');
    }
    for (const ok of ['/rooms#today', '/pantry?tab=board&x=%2F']) expect(safeReturnPath(ok)).toBe(ok);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/mock-users' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { idpSubject: 'kc|u-doyun' } })).statusCode).toBe(404);
    const config = (await t.app.inject({ method: 'GET', url: '/api/config/public' })).json();
    expect(config.login).toEqual({ kind: 'oidc', label: '회사 계정' });
  });
});

describe('Slack DM 어댑터(SLACK_BOT_TOKEN이 있을 때)', () => {
  function fakeSlack(found: boolean) {
    const calls: { method: string; params: Record<string, string> }[] = [];
    const http = (async (input: string | URL | Request, init?: RequestInit) => {
      const method = String(input).split('/api/')[1]!;
      calls.push({ method, params: Object.fromEntries(new URLSearchParams(String(init?.body))) });
      const reply =
        method === 'users.lookupByEmail'
          ? found
            ? { ok: true, user: { id: 'U1' } }
            : { ok: false, error: 'users_not_found' }
          : method === 'conversations.open'
            ? { ok: true, channel: { id: 'D1' } }
            : { ok: true };
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as typeof fetch;
    return { messenger: new SlackMessenger('xoxb-test', http), calls };
  }

  it('메일로 사람을 찾고, 봇 DM을 열어 글 하나를 보내요', async () => {
    const { messenger, calls } = fakeSlack(true);
    expect(await messenger.sendDirect({ toEmail: 'seojun@corp.example', text: '회의에 불렀어요' })).toBe('sent');
    expect(calls.map((c) => c.method)).toEqual(['users.lookupByEmail', 'conversations.open', 'chat.postMessage']);
    expect(calls[2]!.params).toMatchObject({ channel: 'D1', text: '회의에 불렀어요', unfurl_links: 'false' });
  });

  it('Slack에 없는 사람이면 보내지 않고 "못 찾음"이에요', async () => {
    const { messenger, calls } = fakeSlack(false);
    expect(await messenger.sendDirect({ toEmail: 'nobody@corp.example', text: 'x' })).toBe('not-found');
    expect(calls).toHaveLength(1);
  });
});
