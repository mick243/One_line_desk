import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { fakeNotices, fakeRooms } from './fixtures/fake-services';
import {
  authorize,
  BASE,
  callTool,
  connect,
  MCP_URL,
  mcpRequest,
  pkce,
  REDIRECT_URI,
  refresh,
  ROOMS_ARGS,
  setupMcp,
  type TestApp,
  tokenRequest,
} from './fixtures/oauth-flow';
import { DEMO_CLIENT } from './index';
import * as repo from './repo';
import { hashClientSecret, TokenKit } from './tokens';

// MCP 인가 서버 시험(ADR-15). 이름 앞 [MCP-n]은 PRD "MCP 읽기 채널" 완료 기준 n번째 줄, [MCP 요구 n]은 세부 요구 n번이에요.

// 시험마다 새 PGlite를 띄우고 인가 흐름을 한 바퀴 돌아서, 파일 첫 시험(WASM 준비)이 5초를 넘을 수 있어요.
vi.setConfig({ testTimeout: 20_000 });

const opened: TestApp[] = [];
async function setup(opts: { mcp?: boolean } = {}) {
  const t = await createTestApp();
  opened.push(t);
  t.ctx.services.rooms = fakeRooms().service;
  t.ctx.services.notices = fakeNotices().service;
  await setupMcp(t, opts);
  return t;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const grantsOf = async (t: TestApp) => (await t.db.query('select * from mcp_grants')).rows;

describe('메타데이터', () => {
  it('[ADR-15 시험] 보호 자원 메타데이터는 MCP 주소·우리 발급자·범위 둘을 알려요(RFC 9728)', async () => {
    const t = await setup();
    for (const url of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ resource: MCP_URL, authorization_servers: [BASE], scopes_supported: ['rooms.read', 'notices.read'] });
    }
  });

  it('[ADR-15 시험] 인가 서버 메타데이터는 S256만 알리고 동적 등록·CIMD를 광고하지 않아요(RFC 8414)', async () => {
    const t = await setup();
    const meta = (await t.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(meta).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
    });
    expect(meta).not.toHaveProperty('registration_endpoint');
    expect(meta).not.toHaveProperty('client_id_metadata_document_supported');
  });

  it('[MCP-4] 동적 등록 시도는 404예요', async () => {
    const t = await setup();
    for (const url of ['/oauth/register', '/register']) {
      const res = await t.app.inject({ method: 'POST', url, payload: { redirect_uris: ['https://evil.example.com/cb'], client_name: '아무 앱' } });
      expect(res.statusCode, url).toBe(404);
    }
    expect((await t.db.query('select count(*)::int as n from mcp_clients')).rows[0]).toEqual({ n: 1 });
  });
});

describe('authorize와 동의 시트', () => {
  it('[MCP 요구 5] 등록된 시연 클라이언트는 동의 시트로 가고, 시트에는 앱 이름·돌아갈 곳·도구가 나와요', async () => {
    const t = await setup();
    const user = await t.loginAs(MOCK.staff);
    const auth = await authorize(t);
    expect(auth.status).toBe(302);
    expect(`${auth.location.origin}${auth.location.pathname}`).toBe(`${BASE}/oauth/consent`);
    const info = await user.call('GET', `/api/mcp/consent?req=${auth.location.searchParams.get('req')}`);
    expect(info.body).toEqual({ status: 'ready', appName: 'Claude', redirectHost: 'claude.ai', tools: ['rooms.read', 'notices.read'], roomsWrite: true });
  });

  it('[MCP-4] 미등록 클라이언트는 동의 시트 대신 "허락하지 않은 앱"으로 멈추고, 리디렉트 주소로 보내지 않아요', async () => {
    const t = await setup();
    const auth = await authorize(t, { client_id: 'unknown-client-123', redirect_uri: 'https://evil.example.com/cb' });
    expect(auth.status).toBe(302);
    expect(auth.location.host).toBe('localhost:5190');
    expect(auth.location.searchParams.get('error')).toBe('not-allowed');
    expect(auth.location.searchParams.has('req')).toBe(false);
  });

  it('[ADR-15 시험] 리디렉트 URI가 정확히 같지 않으면 그 주소로 보내지 않아요', async () => {
    const t = await setup();
    for (const redirect_uri of ['https://claude.ai/api/mcp/auth_callback/', 'https://claude.ai/api/mcp/auth_callback?x=1', 'https://evil.example.com/cb']) {
      const auth = await authorize(t, { redirect_uri });
      expect(auth.location.host, redirect_uri).toBe('localhost:5190');
      expect(auth.location.searchParams.get('error')).toBe('invalid-request');
    }
  });

  it('[MCP 요구 4] 등록됐어도 보안팀 승인도 시연용도 아닌 클라이언트는 허용 목록 밖이에요', async () => {
    const t = await setup();
    await repo.insertClient(t.db, {
      clientId: 'unapproved-client',
      secretHash: hashClientSecret('s'.repeat(40)),
      appName: '승인 안 된 앱',
      redirectUris: ['https://app.example.com/cb'],
      securityApproved: false,
      demoOnly: false,
    });
    const auth = await authorize(t, { client_id: 'unapproved-client', redirect_uri: 'https://app.example.com/cb' });
    expect(auth.location.searchParams.get('error')).toBe('not-allowed');
  });

  it('[MCP-4] PKCE가 없거나 plain이면 클라이언트로 invalid_request를 돌려줘요', async () => {
    const t = await setup();
    for (const overrides of [{ code_challenge: undefined }, { code_challenge_method: undefined }, { code_challenge_method: 'plain' }]) {
      const auth = await authorize(t, overrides);
      expect(`${auth.location.origin}${auth.location.pathname}`).toBe(REDIRECT_URI);
      expect(auth.location.searchParams.get('error')).toBe('invalid_request');
      expect(auth.location.searchParams.get('state')).toBe('state-xyz');
    }
  });

  it('[ADR-15 시험] resource가 없거나 다른 주소면 거부하고, 모르는 범위도 거부해요', async () => {
    const t = await setup();
    expect((await authorize(t, { resource: undefined })).location.searchParams.get('error')).toBe('invalid_request');
    expect((await authorize(t, { resource: 'https://other.example.com/mcp' })).location.searchParams.get('error')).toBe('invalid_target');
    expect((await authorize(t, { scope: 'rooms.write' })).location.searchParams.get('error')).toBe('invalid_scope');
    expect((await authorize(t, { response_type: 'token' })).location.searchParams.get('error')).toBe('unsupported_response_type');
  });

  it('[MCP 요구 5] [허락하지 않기]면 access_denied로 돌아가고 승인이 생기지 않아요', async () => {
    const t = await setup();
    const user = await t.loginAs(MOCK.staff);
    const req = (await authorize(t)).location.searchParams.get('req')!;
    const res = await user.call('POST', '/api/mcp/consent', { req, decision: 'deny' });
    const back = new URL(res.body.redirectTo);
    expect(res.body.result).toBe('denied');
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.has('code')).toBe(false);
    expect(await grantsOf(t)).toEqual([]);
  });

  it('[ADR-13] 동의 경로는 로그인과 CSRF 토큰이 있어야 해요', async () => {
    const t = await setup();
    const req = (await authorize(t)).location.searchParams.get('req')!;
    expect((await t.app.inject({ method: 'GET', url: `/api/mcp/consent?req=${req}` })).statusCode).toBe(401);
    const user = await t.loginAs(MOCK.staff);
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/mcp/consent', headers: { cookie: user.cookie }, payload: { req, decision: 'allow' } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('[MCP 요구 5] 고친 동의 요청이나 오래된 요청은 열리지 않아요', async () => {
    const t = await setup();
    const user = await t.loginAs(MOCK.staff);
    const req = (await authorize(t)).location.searchParams.get('req')!;
    const tampered = req.slice(0, -4) + (req.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect((await user.call('GET', `/api/mcp/consent?req=${tampered}`)).body).toEqual({ status: 'invalid' });
    t.advance(11 * 60 * 1000);
    const fresh = await t.loginAs(MOCK.staff);
    expect((await fresh.call('GET', `/api/mcp/consent?req=${req}`)).body).toEqual({ status: 'expired' });
    expect((await fresh.call('POST', '/api/mcp/consent', { req, decision: 'allow' })).status).toBe(409);
  });

  it('[MCP-7] MCP를 끄거나 회의실·공지가 모두 빠지면 동의 시트 대신 "도구가 없어요"예요', async () => {
    const t = await setup({ mcp: false });
    const user = await t.loginAs(MOCK.staff);
    const req = (await authorize(t)).location.searchParams.get('req')!;
    expect((await user.call('GET', `/api/mcp/consent?req=${req}`)).body).toEqual({ status: 'no-tools' });
    expect((await user.call('POST', '/api/mcp/consent', { req, decision: 'allow' })).status).toBe(409);

    await t.ctx.ops.setFlag('p_op', 'mcp', true);
    await t.ctx.ops.setModule('p_op', 'rooms', 'link');
    expect((await user.call('GET', `/api/mcp/consent?req=${req}`)).body).toMatchObject({ status: 'ready', tools: ['notices.read'] });
    await t.ctx.ops.setModule('p_op', 'notices', 'off');
    expect((await user.call('GET', `/api/mcp/consent?req=${req}`)).body).toEqual({ status: 'no-tools' });
  });
});

describe('token', () => {
  it('[MCP 시연] 동의 → 코드 교환으로 짧은 접근 토큰과 갱신 토큰을 받고, 승인 표에는 해시만 남아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 150, scope: 'rooms.read notices.read' });
    expect(tokens.expires_in).toBeLessThanOrEqual(t.ctx.ops.get().values.employmentRecheckSeconds);
    const grants = await grantsOf(t);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ client_id: DEMO_CLIENT.clientId, scopes: ['rooms.read', 'notices.read'] });
    expect(JSON.stringify(grants)).not.toContain(tokens.refresh_token);
    expect(JSON.stringify(grants)).not.toContain(MOCK.staff);
  });

  it('[ADR-15 시험] client_secret_basic으로도 교환할 수 있어요', async () => {
    const t = await setup();
    const user = await t.loginAs(MOCK.staff);
    const { verifier, challenge } = pkce();
    const req = (await authorize(t, {}, challenge)).location.searchParams.get('req')!;
    const code = new URL((await user.call('POST', '/api/mcp/consent', { req, decision: 'allow' })).body.redirectTo).searchParams.get('code')!;
    const res = await tokenRequest(
      t,
      { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier, resource: MCP_URL },
      undefined,
      'basic',
    );
    expect(res.statusCode).toBe(200);
  });

  async function freshCode(t: TestApp) {
    const user = await t.loginAs(MOCK.staff);
    const { verifier, challenge } = pkce();
    const req = (await authorize(t, {}, challenge)).location.searchParams.get('req')!;
    const code = new URL((await user.call('POST', '/api/mcp/consent', { req, decision: 'allow' })).body.redirectTo).searchParams.get('code')!;
    return { code, verifier };
  }

  it('[MCP-4] code_verifier가 없거나 틀리면 거부하고, 한 번 본 코드는 다시 쓸 수 없어요', async () => {
    const t = await setup();
    const a = await freshCode(t);
    const noVerifier = await tokenRequest(t, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT_URI, resource: MCP_URL });
    expect(noVerifier.json().error).toBe('invalid_request');
    const reused = await tokenRequest(t, {
      grant_type: 'authorization_code',
      code: a.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: a.verifier,
      resource: MCP_URL,
    });
    expect(reused.json().error).toBe('invalid_grant');

    const b = await freshCode(t);
    const wrong = await tokenRequest(t, {
      grant_type: 'authorization_code',
      code: b.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce().verifier,
      resource: MCP_URL,
    });
    expect(wrong.json().error).toBe('invalid_grant');
    expect(await grantsOf(t)).toEqual([]);
  });

  it('[ADR-15 시험] token 요청에 resource가 없거나 다르면 거부해요', async () => {
    const t = await setup();
    const a = await freshCode(t);
    expect(
      (await tokenRequest(t, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT_URI, code_verifier: a.verifier })).json().error,
    ).toBe('invalid_request');
    const b = await freshCode(t);
    expect(
      (
        await tokenRequest(t, {
          grant_type: 'authorization_code',
          code: b.code,
          redirect_uri: REDIRECT_URI,
          code_verifier: b.verifier,
          resource: 'https://other.example.com/mcp',
        })
      ).json().error,
    ).toBe('invalid_target');
  });

  it('[MCP-4] 미등록 클라이언트·틀린 비밀은 invalid_client(401)예요', async () => {
    const t = await setup();
    const a = await freshCode(t);
    const params = { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT_URI, code_verifier: a.verifier, resource: MCP_URL };
    const unknown = await tokenRequest(t, params, { id: 'unknown-client-123', secret: 'x'.repeat(40) });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe('invalid_client');
    const wrongSecret = await tokenRequest(t, params, { id: DEMO_CLIENT.clientId, secret: 'wrong-secret-0000000000' });
    expect(wrongSecret.statusCode).toBe(401);
    expect(await grantsOf(t)).toEqual([]);
  });

  it('[ADR-15 시험] 코드는 60초가 지나면 쓸 수 없어요', async () => {
    const t = await setup();
    const a = await freshCode(t);
    t.advance(61_000);
    const res = await tokenRequest(t, {
      grant_type: 'authorization_code',
      code: a.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: a.verifier,
      resource: MCP_URL,
    });
    expect(res.json().error).toBe('invalid_grant');
  });

  it('[ADR-15 시험] 갱신 토큰은 쓸 때마다 바뀌고, 옛 갱신 토큰은 거부돼요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const first = await refresh(t, tokens.refresh_token);
    expect(first.statusCode).toBe(200);
    expect(first.json().refresh_token).not.toBe(tokens.refresh_token);
    const again = await refresh(t, tokens.refresh_token);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('invalid_grant');
    expect((await refresh(t, first.json().refresh_token)).statusCode).toBe(200);
  });

  it('[ADR-15 시험] 갱신 토큰을 접근 토큰 자리에 쓰거나 다른 클라이언트로 쓰면 거부돼요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    expect((await mcpRequest(t, tokens.refresh_token, 'tools/list')).statusCode).toBe(401);
    await repo.insertClient(t.db, {
      clientId: 'other-approved-client',
      secretHash: hashClientSecret('o'.repeat(40)),
      appName: '다른 앱',
      redirectUris: ['https://other.example.com/cb'],
      securityApproved: true,
      demoOnly: false,
    });
    const res = await tokenRequest(
      t,
      { grant_type: 'refresh_token', refresh_token: tokens.refresh_token },
      { id: 'other-approved-client', secret: 'o'.repeat(40) },
    );
    expect(res.json().error).toBe('invalid_grant');
  });

  it('[ADR-15 시험] JSON 본문이나 같은 매개변수 두 번은 받지 않아요', async () => {
    const t = await setup();
    const json = await t.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: 'x' } });
    expect(json.json().error).toBe('invalid_request');
    const dup = await t.app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'grant_type=refresh_token&grant_type=authorization_code',
    });
    expect(dup.json().error).toBe('invalid_request');
  });
});

describe('토큰 검사(자원 서버)', () => {
  it('[MCP-4] 토큰이 없으면 401 + WWW-Authenticate에 resource_metadata를 알려요', async () => {
    const t = await setup();
    const res = await mcpRequest(t, undefined, 'tools/list');
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('[MCP-4] aud가 다른 토큰·위조 토큰은 거부돼요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    expect((await mcpRequest(t, tokens.access_token, 'tools/list')).statusCode).toBe(200);

    // 같은 서버 키로 칸 하나씩만 바꾼 토큰을 만들어 봐요.
    const grant = (await t.db.query<{ pseudonym_id: string; grant_id: string }>('select pseudonym_id, grant_id from mcp_grants')).rows[0]!;
    const kit = new TokenKit(t.ctx.config.mcpTokenSecret);
    const base = {
      iss: BASE,
      aud: MCP_URL,
      sub: grant.pseudonym_id,
      cid: DEMO_CLIENT.clientId,
      scope: ['rooms.read'],
      gid: grant.grant_id,
      iat: t.now(),
      exp: t.now() + 60_000,
    };
    expect((await mcpRequest(t, kit.seal('access', base), 'tools/list')).statusCode).toBe(200);
    const variants = [
      { aud: 'https://other.example.com/mcp' },
      { aud: BASE },
      { iss: 'https://evil.example.com' },
      { exp: t.now() - 1 },
      { gid: '00000000-0000-0000-0000-000000000000' },
      { cid: 'unknown-client-123' },
    ];
    for (const bad of variants) {
      const res = await mcpRequest(t, kit.seal('access', { ...base, ...bad }), 'tools/list');
      expect(res.statusCode, JSON.stringify(bad)).toBe(401);
    }
    expect((await mcpRequest(t, new TokenKit('another-server-secret-000000000000').seal('access', base), 'tools/list')).statusCode).toBe(401);

    const forged = tokens.access_token.slice(0, -6) + (tokens.access_token.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA');
    const res = await mcpRequest(t, forged, 'tools/list');
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('[MCP-4] 만료된 접근 토큰은 거부되고, 갱신하면 다시 돼요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    t.advance(tokens.expires_in * 1000);
    expect((await mcpRequest(t, tokens.access_token, 'tools/list')).statusCode).toBe(401);
    const renewed = await refresh(t, tokens.refresh_token);
    expect((await mcpRequest(t, renewed.json().access_token, 'tools/list')).statusCode).toBe(200);
  });
});

describe('퇴사·끊기·모든 기기 로그아웃', () => {
  /**
   * 재직을 확인한 직후(t = 0) 1초 뒤 모의 IdP에서 계정을 끄고, Claude처럼 접근 토큰이 끝나면 갱신하며 5초마다 도구를 불러요.
   * earlyRefreshAt을 주면 그 시각에 한 번 미리 갱신해요(재확인 결과 재사용 창 끝 직전 = 가장 늦은 경우).
   * 호출과 갱신이 모두 막힌 시각까지 걸린 시간을 돌려줘요.
   */
  async function measureCutoff(t: TestApp, earlyRefreshAt?: (reuseMs: number) => number) {
    const recheckMs = t.ctx.ops.get().values.employmentRecheckSeconds * 1000;
    let { tokens } = await connect(t, MOCK.staff);
    const checkedAt = t.now();
    let expiresAt = checkedAt + tokens.expires_in * 1000;
    const reuseMs = recheckMs - tokens.expires_in * 1000;
    t.advance(1_000);
    t.adapters.employees.setActive(MOCK.staff, false);
    const offAt = t.now();

    const renew = async () => {
      const res = await refresh(t, tokens.refresh_token);
      if (res.statusCode !== 200) return false;
      tokens = res.json();
      expiresAt = t.now() + tokens.expires_in * 1000;
      return true;
    };
    if (earlyRefreshAt) {
      t.advance(checkedAt + earlyRefreshAt(reuseMs) - t.now());
      expect(await renew()).toBe(true); // 재사용 창 안이라 이번 갱신은 통과해요.
    }
    let refusedAt: number | null = null;
    for (let i = 0; i < 200 && refusedAt === null; i += 1) {
      t.advance(5_000);
      if (t.now() >= expiresAt) await renew();
      const call = await callTool(t, tokens.access_token, 'rooms_find_free', ROOMS_ARGS);
      if (call.statusCode === 401) refusedAt = t.now();
    }
    expect(refusedAt).not.toBeNull();
    expect((await refresh(t, tokens.refresh_token)).json().error).toBe('invalid_grant');
    expect(await grantsOf(t)).toEqual([]);
    return { elapsed: refusedAt! - offAt, recheckMs };
  }

  it('[MCP-5] 모의 IdP에서 계정을 끄면 재확인 간격 안에 MCP 호출과 갱신이 모두 거부돼요(보통: 만료 때 갱신)', async () => {
    const t = await setup();
    const { elapsed, recheckMs } = await measureCutoff(t);
    console.info(`[MCP-5] 보통 경우: 계정을 끈 뒤 호출·갱신이 모두 막히기까지 ${elapsed / 1000}초(재확인 간격 ${recheckMs / 1000}초)`);
    expect(elapsed).toBeLessThanOrEqual(recheckMs);
    const ended = (await t.db.query("select result from audit_log where action = 'employment.recheck'")).rows;
    expect(ended).toEqual([{ result: 'ended' }]);
  });

  it('[MCP-5] 가장 늦은 경우(재확인 결과 재사용 창이 끝나기 1초 전에 갱신)에도 재확인 간격 안에 막혀요', async () => {
    const t = await setup();
    const { elapsed, recheckMs } = await measureCutoff(t, (reuseMs) => reuseMs - 1_000);
    console.info(`[MCP-5] 가장 늦은 경우: 계정을 끈 뒤 호출·갱신이 모두 막히기까지 ${elapsed / 1000}초(재확인 간격 ${recheckMs / 1000}초)`);
    expect(elapsed).toBeGreaterThan(recheckMs / 2);
    expect(elapsed).toBeLessThanOrEqual(recheckMs);
  });

  it('[MCP-5] 웹 요청에서 퇴사가 먼저 확인돼도 MCP 승인이 같이 지워져요', async () => {
    const t = await setup();
    const { user, tokens } = await connect(t, MOCK.staff);
    t.adapters.employees.setActive(MOCK.staff, false);
    t.advance(t.ctx.ops.get().values.employmentRecheckSeconds * 1000);
    expect((await user.call('GET', '/api/me')).status).toBe(401);
    expect(await grantsOf(t)).toEqual([]);
    expect((await refresh(t, tokens.refresh_token)).json().error).toBe('invalid_grant');
  });

  it('[MCP-5] [끊기] 뒤에는 갱신도, 남은 접근 토큰도 거부돼요', async () => {
    const t = await setup();
    const { user, tokens } = await connect(t, MOCK.staff);
    const res = await user.call('DELETE', `/api/mcp/connections/${DEMO_CLIENT.clientId}`);
    expect(res).toEqual({ status: 200, body: { ok: true, removed: 1 } });
    expect((await refresh(t, tokens.refresh_token)).json().error).toBe('invalid_grant');
    expect((await mcpRequest(t, tokens.access_token, 'tools/list')).statusCode).toBe(401);
  });

  it('[MCP-5] 모든 기기 로그아웃 뒤에는 갱신도, 남은 접근 토큰도 거부돼요', async () => {
    const t = await setup();
    const { user, tokens } = await connect(t, MOCK.staff);
    const res = await user.call('POST', '/api/auth/logout-all');
    expect(res.body).toMatchObject({ ok: true, grants: 1 });
    expect((await refresh(t, tokens.refresh_token)).json().error).toBe('invalid_grant');
    expect((await mcpRequest(t, tokens.access_token, 'tools/list')).statusCode).toBe(401);
  });

  it('[ADR-15 시험] 클라이언트가 토큰을 폐기(RFC 7009)하면 승인이 지워져요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const res = await tokenRequest(t, { token: tokens.refresh_token }, undefined, 'post', '/oauth/revoke');
    expect(res.statusCode).toBe(200);
    expect(await grantsOf(t)).toEqual([]);
    expect((await mcpRequest(t, tokens.access_token, 'tools/list')).statusCode).toBe(401);
  });

  it('[MCP-4] 다른 사람의 연결은 끊을 수 없어요', async () => {
    const t = await setup();
    await connect(t, MOCK.staff);
    const other = await t.loginAs(MOCK.dev);
    expect((await other.call('DELETE', `/api/mcp/connections/${DEMO_CLIENT.clientId}`)).body).toEqual({ ok: true, removed: 0 });
    expect(await grantsOf(t)).toHaveLength(1);
  });
});

describe('계약 전 잠금(허용 두 겹)', () => {
  it('[MCP 요구 4] 실제 어댑터가 켜지면 시연용 클라이언트는 허용 목록 밖이라 연결·호출·갱신이 모두 막혀요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const realAdapters = () => [{ name: 'real-idp', label: '사내 IdP', mock: false }];
    t.ctx.adapters.all = realAdapters;
    expect((await authorize(t)).location.searchParams.get('error')).toBe('not-allowed');
    expect((await mcpRequest(t, tokens.access_token, 'tools/list')).statusCode).toBe(401);
    expect((await refresh(t, tokens.refresh_token)).json().error).toBe('invalid_grant');
  });

  it('[MCP 요구 4] 모의 어댑터여도 회의실 결과가 실제 데이터면 승인 안 된 클라이언트에는 보내지 않아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    t.ctx.services.rooms = fakeRooms({ mock: false }).service;
    const res = await callTool(t, tokens.access_token, 'rooms_find_free', ROOMS_ARGS);
    expect(res.json().result.isError).toBe(true);
    expect(res.body).not.toContain('가상 회의실');
  });
});
