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
  // claims: ID 토큰에 더 넣을 값(amr·acr·auth_time). down: IdP에 닿지 못하는 상황(망 막힘).
  const state = { nonce: '', calls: [] as string[], claims: {} as Record<string, unknown>, down: false };
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
    if (state.down) throw new TypeError('fetch failed');
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
            // max_age를 받은 IdP는 인증 시각(auth_time)을 꼭 넣어요(OIDC Core). 기본은 방금 인증한 것으로 둬요.
            auth_time: NOW / 1000,
            ...state.claims,
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
      profile: {
        idpSubject: 'kc|u-doyun',
        displayName: '가상 직원 도윤',
        department: '개발팀',
        floor: '5층',
        groups: ['facilities'],
        email: 'doyun@corp.example',
      },
      evidence: { amr: [], authTime: NOW },
    });
    state.claims = { amr: ['pwd', 'otp'], acr: 'gold', auth_time: NOW / 1000 - 30 };
    expect((await adapter.finishLogin({ ...p, code: 'good' }))?.evidence).toEqual({ amr: ['pwd', 'otp'], acr: 'gold', authTime: NOW - 30_000 });
    state.claims = {};
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

  type T = Awaited<ReturnType<typeof setup>>['t'];
  type IdpState = Awaited<ReturnType<typeof setup>>['state'];

  /** 시작 → IdP 주소와 그 브라우저에 묶인 쿠키(state·nonce·검증 값) */
  async function start(t: T, state: IdpState, query = '') {
    const res = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/start${query}` });
    expect(res.statusCode).toBe(302);
    const auth = new URL(String(res.headers.location));
    state.nonce = auth.searchParams.get('nonce') ?? '';
    const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0]!;
    return { auth, cookie, state: auth.searchParams.get('state') ?? '' };
  }

  /** IdP에서 돌아오기. cookie가 없으면 다른 브라우저에서 돌아온 거예요. */
  const callback = (t: T, s: string, cookie?: string, code = 'good') =>
    t.app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=${code}&state=${s}`, headers: cookie ? { cookie } : {} });

  const sessionCookie = (res: { headers: Record<string, unknown> }) =>
    String(res.headers['set-cookie'] ?? '')
      .split(/,(?=\s*\w+=)/)
      .map((c) => c.trim().split(';')[0]!)
      .find((c) => c.startsWith('desk_sid='));

  it('시작하면 state·nonce·S256 검증 값을 붙여 IdP로 보내고, 돌아오면 세션을 열고 원래 화면으로 가요', async () => {
    const { t, state } = await setup();
    const s = await start(t, state, '?return=%2Foauth%2Fconsent%3Freq%3Dabc');
    expect(s.auth.origin + s.auth.pathname).toBe(`${ISSUER}/auth`);
    expect(s.auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(s.auth.searchParams.get('redirect_uri')).toBe('http://localhost:5190/api/auth/oidc/callback');
    expect(s.auth.searchParams.get('prompt')).toBeNull();
    // 진행 값은 서명 쿠키에만 있어요(HttpOnly·SameSite=Lax·10분).
    expect(s.cookie).toMatch(/^desk_oidc_[\w-]{8}=/);

    const back = await callback(t, s.state, s.cookie);
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('/oauth/consent?req=abc');
    const cookie = sessionCookie(back)!;
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    expect(me).toMatchObject({ displayName: '가상 직원 도윤', department: '개발팀', floor: '5층', roles: expect.arrayContaining(['facilities']) });
    expect((await t.ctx.audit.recent(1))[0]).toMatchObject({ channel: 'auth', action: 'login', result: 'ok' });

    // 같은 쿠키·state는 한 번만 써요.
    expect((await callback(t, s.state, s.cookie)).headers.location).toBe('/?login=failed');
  });

  it('남이 시작한 로그인은 내 브라우저로 끝낼 수 없고, 시작을 아무리 많이 불러도 다른 사람 로그인은 지워지지 않아요(C-5)', async () => {
    const { t, state } = await setup();
    const mine = await start(t, state);
    // 로그인 CSRF: 쿠키 없는 브라우저(남의 링크를 누른 사람)로 돌아오면 세션을 만들지 않아요.
    const csrf = await callback(t, mine.state);
    expect(csrf.headers.location).toBe('/?login=failed');
    expect(sessionCookie(csrf)).toBeUndefined();

    const real = await start(t, state);
    for (let i = 0; i < 1001; i += 1) await t.app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    state.nonce = real.auth.searchParams.get('nonce')!;
    const back = await callback(t, real.state, real.cookie);
    expect(back.headers.location).toBe('/');
    expect(sessionCookie(back)).toBeDefined();

    // 10분이 지나면 쿠키가 있어도 받지 않아요.
    const late = await start(t, state);
    t.advance(11 * 60_000);
    expect((await callback(t, late.state, late.cookie)).headers.location).toBe('/?login=failed');
  });

  it('IdP 오류와 IdP에 닿지 못할 때는 JSON 대신 로그인 화면으로 이유를 들고 가요(C-5)', async () => {
    const { t, state } = await setup();
    const s = await start(t, state);
    const denied = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/callback?error=access_denied&state=${s.state}`, headers: { cookie: s.cookie } });
    expect(denied.headers.location).toBe('/?login=denied');
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/oidc/callback?error=temporarily_unavailable&state=x' })).headers.location).toBe(
      '/?login=idp-unreachable',
    );

    // 시작한 뒤 IdP가 막히면 돌아오기(토큰 교환)에서 알아요.
    const before = await start(t, state);
    state.down = true;
    expect((await callback(t, before.state, before.cookie)).headers.location).toBe('/?login=idp-unreachable');

    // 서버가 뜬 뒤 한 번도 IdP 설정을 받지 못했으면 시작에서 알아요.
    const fresh = await setup();
    fresh.state.down = true;
    const startDown = await fresh.t.app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    expect(startDown.statusCode).toBe(302);
    expect(startDown.headers.location).toBe('/?login=idp-unreachable');
  });

  it('MFA 정책이 always면 ID 토큰에 MFA 근거가 있을 때만 세션을 열어요(C-6)', async () => {
    const { t, state } = await setup();
    t.ctx.config.requireMfa = 'always';
    state.claims = { amr: ['pwd'] };
    let s = await start(t, state);
    const weak = await callback(t, s.state, s.cookie);
    expect(weak.headers.location).toBe('/?login=mfa-required');
    expect(sessionCookie(weak)).toBeUndefined();
    expect((await t.ctx.audit.recent(1))[0]).toMatchObject({ channel: 'auth', action: 'login', result: 'mfa-required' });

    state.claims = { amr: ['pwd', 'otp'] };
    s = await start(t, state);
    expect(sessionCookie(await callback(t, s.state, s.cookie))).toBeDefined();
    expect((await t.ctx.audit.recent(1))[0]).toMatchObject({ action: 'login', result: 'ok-mfa' });

    // acr로도 받아요. 설정한 값만이에요.
    t.ctx.config.mfaAcr = ['gold'];
    state.claims = { amr: ['pwd'], acr: 'gold' };
    s = await start(t, state);
    expect(sessionCookie(await callback(t, s.state, s.cookie))).toBeDefined();
  });

  it('쉬는 시간 뒤 다시 로그인은 IdP에 지금 다시 인증을 요청하고, 오래된 인증이면 받지 않아요(C-1)', async () => {
    const { t, state } = await setup();
    let s = await start(t, state, '?reauth=idle');
    expect(s.auth.searchParams.get('prompt')).toBe('login');
    expect(s.auth.searchParams.get('max_age')).toBe('0');
    state.claims = { auth_time: (NOW - 2 * 3_600_000) / 1000 };
    expect((await callback(t, s.state, s.cookie)).headers.location).toBe('/?login=failed');
    state.claims = { auth_time: undefined };
    s = await start(t, state, '?reauth=idle');
    expect((await callback(t, s.state, s.cookie)).headers.location).toBe('/?login=failed');

    state.claims = { auth_time: NOW / 1000 };
    s = await start(t, state, '?reauth=idle');
    const back = await callback(t, s.state, s.cookie);
    expect(back.headers.location).toBe('/');
    expect(sessionCookie(back)).toBeDefined();
  });

  it('쉬어서 끊긴 뒤에는 화면 깃발 없이 새로 고치거나 시작 주소를 바로 열어도 다시 인증을 요청해요(10/29 회의 A5)', async () => {
    const { t, state } = await setup();
    const cookieOf = (res: { headers: Record<string, unknown> }, name: string) =>
      ([res.headers['set-cookie'] ?? []].flat() as string[]).map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`));
    const get = (url: string, ...cookies: (string | undefined)[]) =>
      t.app.inject({ method: 'GET', url, headers: { cookie: cookies.filter(Boolean).join('; ') } });
    const login = async () => {
      state.claims = { auth_time: t.now() / 1000 };
      const s = await start(t, state);
      return sessionCookie(await callback(t, s.state, s.cookie))!;
    };

    // ① 새로 고침: 끊긴 뒤 화면은 깃발을 잊지만, 서버 표시로 같은 이유를 다시 알려 주고 다시 인증을 요청해요.
    let sid = await login();
    t.advance(181 * 60_000);
    const ended = await get('/api/me', sid);
    expect(ended.json()).toMatchObject({ reason: 'idle' });
    const mark = cookieOf(ended, 'desk_reauth')!;
    expect(mark).toBeDefined();
    expect((await get('/api/me', mark)).json()).toMatchObject({ error: 'login-required', reason: 'idle' });
    const again = await get('/api/auth/oidc/start', mark);
    const auth = new URL(String(again.headers.location));
    expect(auth.searchParams.get('prompt')).toBe('login');
    expect(auth.searchParams.get('max_age')).toBe('0');
    state.nonce = auth.searchParams.get('nonce') ?? '';
    const pending = cookieOf(again, 'desk_oidc_' + auth.searchParams.get('state')!.slice(0, 8))!;
    // 오래된 인증(SSO)으로는 들어오지 못하고, 지금 다시 인증하면 들어와요. 들어오면 표시를 지워요.
    state.claims = { auth_time: (t.now() - 2 * 3_600_000) / 1000 };
    expect((await get(`/api/auth/oidc/callback?code=good&state=${auth.searchParams.get('state')}`, pending, mark)).headers.location).toBe('/?login=failed');
    const retry = await get('/api/auth/oidc/start', mark);
    const retryAuth = new URL(String(retry.headers.location));
    state.nonce = retryAuth.searchParams.get('nonce') ?? '';
    state.claims = { auth_time: t.now() / 1000 };
    const back = await get(
      `/api/auth/oidc/callback?code=good&state=${retryAuth.searchParams.get('state')}`,
      cookieOf(retry, 'desk_oidc_' + retryAuth.searchParams.get('state')!.slice(0, 8)),
      mark,
    );
    expect(back.headers.location).toBe('/');
    expect(sessionCookie(back)).toBeDefined();
    expect(cookieOf(back, 'desk_reauth')).toBe('desk_reauth=');

    // ② 쉰 세션이 남은 채로 시작 주소를 바로 열어도 다시 인증이에요. 그 자리에서 세션을 끊고 표시를 남겨요.
    sid = await login();
    t.advance(181 * 60_000);
    const direct = await get('/api/auth/oidc/start', sid);
    expect(new URL(String(direct.headers.location)).searchParams.get('prompt')).toBe('login');
    expect(cookieOf(direct, 'desk_reauth')).toMatch(/^desk_reauth=.+/);
    expect((await get('/api/me', sid)).statusCode).toBe(401);

    // ③ 쉬기 직전에 시작한 로그인을 끊긴 뒤에 마치면(진행 쿠키 10분 안), 다시 인증을 요청하며 처음부터 해요.
    sid = await login();
    t.advance(175 * 60_000);
    const early = await start(t, state);
    t.advance(6 * 60_000);
    const mark2 = cookieOf(await get('/api/me', sid), 'desk_reauth');
    const late = await get(`/api/auth/oidc/callback?code=good&state=${early.state}`, early.cookie, mark2);
    expect(late.headers.location).toBe('/api/auth/oidc/start?reauth=idle&return=%2F');
    expect(sessionCookie(late)).toBeUndefined();
  });

  it('모든 로그인에 max_age(쉬는 시간)를 붙이고, 마지막 인증이 그보다 오래됐으면 지금 다시 인증을 요청해요(배포 준비 회의 B3)', async () => {
    const { t, state } = await setup();
    const s = await start(t, state);
    expect(s.auth.searchParams.get('max_age')).toBe(String(180 * 60));
    expect(s.auth.searchParams.get('prompt')).toBeNull();
    // 재시작·8시간 만료로 세션이 사라져도, SSO에 남은 오래된 인증으로는 쉼 판정을 건너뛰지 못해요.
    state.claims = { auth_time: (NOW - 4 * 3_600_000) / 1000 };
    const stale = await callback(t, s.state, s.cookie);
    expect(stale.headers.location).toBe('/api/auth/oidc/start?reauth=stale&return=%2F');
    expect(sessionCookie(stale)).toBeUndefined();
    const again = await start(t, state, '?reauth=stale');
    expect(again.auth.searchParams.get('prompt')).toBe('login');
    expect(again.auth.searchParams.get('max_age')).toBe('0');
    state.claims = { auth_time: NOW / 1000 };
    expect(sessionCookie(await callback(t, again.state, again.cookie))).toBeDefined();

    // max_age를 받고도 인증 시각을 주지 않는 IdP는 받지 않아요(로그에 idp-no-auth-time을 남겨요).
    state.claims = { auth_time: undefined };
    const bare = await start(t, state);
    expect((await callback(t, bare.state, bare.cookie)).headers.location).toBe('/?login=failed');
  });

  it('로그아웃한 브라우저의 다음 회사 로그인은 지금 다시 인증을 요청해요(공용 PC, 배포 준비 회의 B2)', async () => {
    const { t, state } = await setup();
    const cookiesOf = (res: { headers: Record<string, unknown> }) => ([res.headers['set-cookie'] ?? []].flat() as string[]).map((c) => c.split(';')[0]!);
    const s = await start(t, state);
    const sid = sessionCookie(await callback(t, s.state, s.cookie))!;
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: sid } })).json();
    const out = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: sid, 'x-csrf-token': me.csrfToken } });
    expect(out.statusCode).toBe(200);
    expect(cookiesOf(out)).toContain('desk_sid=');
    const mark = cookiesOf(out).find((c) => /^desk_reauth=.+/.test(c))!;
    expect(mark).toBeDefined();

    // 로그아웃 뒤에는 "오래 쉬어서"가 아니라 그냥 로그인 필요예요.
    const after = (await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: mark } })).json();
    expect(after).toMatchObject({ error: 'login-required' });
    expect(after.reason).toBeUndefined();
    const next = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/start', headers: { cookie: mark } });
    const auth = new URL(String(next.headers.location));
    expect(auth.searchParams.get('prompt')).toBe('login');
    expect(auth.searchParams.get('max_age')).toBe('0');
  });

  it('다른 사이트로는 돌려보내지 않고, 모의 로그인은 닫혀 있어요', async () => {
    const { t, state } = await setup();
    // QA-1: tab·줄바꿈·`\`·인코딩한 `/`·전각 `／`·`..`로 돌아 나가는 주소도 앱 첫 화면으로 보내요. 콜백은 500이 나지 않아요.
    const bads = ['//evil.example/x', 'https://evil.example', '/\\evil', '/api/me', '/\t/evil.example', '/\n/evil.example', '/\r/evil.example'];
    bads.push('/%5cevil', '/%2fevil.example', '/%2F%2Fevil', '/／evil.example', '/./api/me', '/a/../api/me', '/..//evil.example', '/ x');
    for (const bad of bads) {
      const s = await start(t, state, `?return=${encodeURIComponent(bad)}`);
      const back = await callback(t, s.state, s.cookie);
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
