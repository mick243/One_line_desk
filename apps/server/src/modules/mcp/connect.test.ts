import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import type { TokenResponse } from './auth-service';
import { fakeNotices, fakeRooms } from './fixtures/fake-services';
import { authorize, BASE, connect, MCP_URL, mcpRequest, pkce, refresh, setupMcp, type TestApp, tokenRequest } from './fixtures/oauth-flow';
import { DEMO_CLI_CLIENTS, DEMO_CLIENT } from './index';
import { redirectMatches } from './policy';
import { MAX_DEVICES_PER_APP } from './repo';

// CLI 연결(11/2, ADR-15 개정): 미리 등록한 공개 클라이언트, 루프백 포트 자유, 기기별 승인(MCP_UX_TEST U1~U3·U6).

vi.setConfig({ testTimeout: 20_000 });

const CLAUDE_CODE = DEMO_CLI_CLIENTS[0];
const CODEX = DEMO_CLI_CLIENTS[1];

const opened: TestApp[] = [];
async function setup(opts: { mcp?: boolean } = {}) {
  const t = await createTestApp({ start: Date.parse('2026-11-02T09:00:00+09:00') });
  opened.push(t);
  t.ctx.services.rooms = fakeRooms().service;
  t.ctx.services.notices = fakeNotices().service;
  await setupMcp(t, opts);
  return t;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

/** 비밀 없이 client_id만 보내는 token·revoke 요청(token_endpoint_auth_method none). */
function publicRequest(t: TestApp, clientId: string, params: Record<string, string>, url = '/oauth/token') {
  return t.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ ...params, client_id: clientId }).toString(),
  });
}

/** Claude Code처럼: 무작위 포트의 localhost 콜백으로 authorize → [연결 허락] → 비밀 없이 코드 교환. */
async function connectCli(t: TestApp, idpSubject: string, client: { clientId: string } = CLAUDE_CODE, redirectUri = 'http://localhost:53682/callback') {
  const user = await t.loginAs(idpSubject);
  const { verifier, challenge } = pkce();
  const auth = await authorize(t, { client_id: client.clientId, redirect_uri: redirectUri }, challenge);
  expect(auth.location.pathname).toBe('/oauth/consent');
  const decision = await user.call('POST', '/api/mcp/consent', { req: auth.location.searchParams.get('req')!, decision: 'allow' });
  expect(decision.status).toBe(200);
  const back = new URL(decision.body.redirectTo);
  expect(`${back.origin}${back.pathname}`).toBe(new URL(redirectUri).origin + new URL(redirectUri).pathname);
  const res = await publicRequest(t, client.clientId, {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code')!,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: MCP_URL,
  });
  expect(res.statusCode).toBe(200);
  return { user, tokens: res.json() as TokenResponse };
}

const grantCount = async (t: TestApp) => (await t.db.query<{ n: number }>('select count(*)::int as n from mcp_grants')).rows[0]!.n;

describe('공개 클라이언트(CLI)', () => {
  it('[ADR-15 개정] 메타데이터는 비밀 없는 방식(none)을 알리지만, 동적 등록·CIMD는 여전히 없어요', async () => {
    const t = await setup();
    const meta = (await t.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(meta.token_endpoint_auth_methods_supported).toEqual(['client_secret_basic', 'client_secret_post', 'none']);
    expect(meta).not.toHaveProperty('registration_endpoint');
    expect(meta).not.toHaveProperty('client_id_metadata_document_supported');
    expect((await t.app.inject({ method: 'POST', url: '/oauth/register', payload: {} })).statusCode).toBe(404);
  });

  it('[U1·U3] Claude Code는 비밀 없이 PKCE만으로 연결하고 도구를 불러요', async () => {
    const t = await setup();
    const { tokens } = await connectCli(t, MOCK.staff);
    expect(tokens.refresh_token).toMatch(/^mrt_/);
    const list = await mcpRequest(t, tokens.access_token, 'tools/list');
    expect(list.statusCode).toBe(200);
    expect(
      list
        .json()
        .result.tools.map((x: { name: string }) => x.name)
        .sort(),
    ).toEqual(['notices_search', 'rooms_find_free']);
    const renewed = await publicRequest(t, CLAUDE_CODE.clientId, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: MCP_URL });
    expect(renewed.statusCode).toBe(200);
  });

  it('[U2] Codex는 127.0.0.1의 아무 포트로 돌아와도 돼요', async () => {
    const t = await setup();
    const { tokens } = await connectCli(t, MOCK.staff, CODEX, 'http://127.0.0.1:1455/callback');
    expect((await mcpRequest(t, tokens.access_token, 'tools/list')).statusCode).toBe(200);
  });

  it('[ADR-15 개정] 공개 클라이언트가 비밀을 보내거나, 기밀 클라이언트가 비밀을 빼면 invalid_client예요', async () => {
    const t = await setup();
    const withSecret = await tokenRequest(t, { grant_type: 'refresh_token', refresh_token: 'mrt_x' }, { id: CLAUDE_CODE.clientId, secret: 'anything-at-all' });
    expect(withSecret.statusCode).toBe(401);
    const noSecret = await publicRequest(t, DEMO_CLIENT.clientId, { grant_type: 'refresh_token', refresh_token: 'mrt_x' });
    expect(noSecret.statusCode).toBe(401);
    expect(noSecret.json().error).toBe('invalid_client');
    const unknown = await publicRequest(t, 'not-registered-cli', { grant_type: 'refresh_token', refresh_token: 'mrt_x' });
    expect(unknown.statusCode).toBe(401);
  });

  it('[ADR-15 개정] 공개 클라이언트의 코드를 다른 공개 클라이언트로 바꿀 수 없어요', async () => {
    const t = await setup();
    const user = await t.loginAs(MOCK.staff);
    const { verifier, challenge } = pkce();
    const auth = await authorize(t, { client_id: CLAUDE_CODE.clientId, redirect_uri: 'http://localhost:4000/callback' }, challenge);
    const decision = await user.call('POST', '/api/mcp/consent', { req: auth.location.searchParams.get('req')!, decision: 'allow' });
    const code = new URL(decision.body.redirectTo).searchParams.get('code')!;
    const res = await publicRequest(t, CODEX.clientId, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://localhost:4000/callback',
      code_verifier: verifier,
      resource: MCP_URL,
    });
    expect(res.json().error).toBe('invalid_grant');
    expect(await grantCount(t)).toBe(0);
  });

  it('[U2] 루프백이 아니거나 경로가 다르면 그 주소로 보내지 않아요', async () => {
    const t = await setup();
    for (const redirect_uri of [
      'https://evil.example.com/callback',
      'http://localhost.evil.example.com/callback',
      'http://localhost:4000/other',
      'http://localhost:4000/callback?x=1',
      'https://localhost:4000/callback',
      'http://user@localhost:4000/callback',
    ]) {
      const auth = await authorize(t, { client_id: CLAUDE_CODE.clientId, redirect_uri });
      expect(auth.location.host, redirect_uri).toBe('localhost:5190');
      expect(auth.location.searchParams.get('error'), redirect_uri).toBe('invalid-request');
    }
  });

  it('[U2] 포트 자유는 포트 없이 등록한 루프백 주소에만 적용돼요', () => {
    const confidential = { redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:8080/cb'], publicClient: false };
    expect(redirectMatches(confidential, 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(false);
    expect(redirectMatches(confidential, 'http://localhost:8080/cb')).toBe(true);
    expect(redirectMatches(confidential, 'http://localhost:9090/cb')).toBe(false);
    const cli = { redirectUris: ['http://localhost/callback'], publicClient: true };
    expect(redirectMatches(cli, 'http://localhost:61234/callback')).toBe(true);
    expect(redirectMatches(cli, 'http://127.0.0.1:61234/callback')).toBe(false);
    expect(redirectMatches({ redirectUris: ['https://app.example.com/cb'], publicClient: true }, 'https://app.example.com/cb')).toBe(false);
  });

  it('[ADR-15 개정] DB도 공개 클라이언트에 비밀을, 기밀 클라이언트에 빈 비밀을 넣지 못하게 막아요', async () => {
    const t = await setup();
    await expect(
      t.db.query(
        "insert into mcp_clients (client_id, client_secret_hash, public_client, app_name, redirect_uris) values ('bad-public-1', $1, true, 'x', '{http://localhost/cb}')",
        ['a'.repeat(64)],
      ),
    ).rejects.toThrow();
    await expect(
      t.db.query(
        "insert into mcp_clients (client_id, client_secret_hash, public_client, app_name, redirect_uris) values ('bad-secret-1', null, false, 'x', '{https://x.example.com/cb}')",
      ),
    ).rejects.toThrow();
  });

  it('[MCP 요구 4] 실제 어댑터가 켜지면 시연용 CLI 클라이언트도 허용 목록 밖이에요', async () => {
    const t = await setup();
    t.ctx.adapters.all = () => [{ name: 'real-idp', label: '사내 IdP', mock: false }];
    const auth = await authorize(t, { client_id: CLAUDE_CODE.clientId, redirect_uri: 'http://localhost:4000/callback' });
    expect(auth.location.searchParams.get('error')).toBe('not-allowed');
  });
});

describe('기기별 승인(U6)', () => {
  it('같은 앱을 두 기기에서 연결해도 앞 기기가 끊기지 않고, S6에는 한 줄에 기기 2대로 보여요', async () => {
    const t = await setup();
    const first = await connectCli(t, MOCK.staff, CLAUDE_CODE, 'http://localhost:4001/callback');
    const second = await connectCli(t, MOCK.staff, CLAUDE_CODE, 'http://localhost:4002/callback');
    expect((await mcpRequest(t, first.tokens.access_token, 'tools/list')).statusCode).toBe(200);
    expect((await mcpRequest(t, second.tokens.access_token, 'tools/list')).statusCode).toBe(200);
    const res = await second.user.call('GET', '/api/mcp/connections');
    expect(res.body.apps).toEqual([
      { clientId: CLAUDE_CODE.clientId, appName: 'Claude Code', connectedOn: '2026-11-02', scopes: ['rooms.read', 'notices.read'], devices: 2 },
    ]);
  });

  it('클라이언트 폐기(RFC 7009)는 그 기기만, [끊기]는 그 앱의 모든 기기를 끊어요', async () => {
    const t = await setup();
    const a = await connectCli(t, MOCK.staff);
    const b = await connectCli(t, MOCK.staff);
    const c = await connectCli(t, MOCK.staff);
    expect((await publicRequest(t, CLAUDE_CODE.clientId, { token: a.tokens.refresh_token }, '/oauth/revoke')).statusCode).toBe(200);
    expect((await mcpRequest(t, a.tokens.access_token, 'tools/list')).statusCode).toBe(401);
    expect((await mcpRequest(t, b.tokens.access_token, 'tools/list')).statusCode).toBe(200);
    const removed = await c.user.call('DELETE', `/api/mcp/connections/${CLAUDE_CODE.clientId}`);
    expect(removed.body).toEqual({ ok: true, removed: 2 });
    expect((await mcpRequest(t, b.tokens.access_token, 'tools/list')).statusCode).toBe(401);
    expect((await mcpRequest(t, c.tokens.access_token, 'tools/list')).statusCode).toBe(401);
  });

  it('갱신 토큰 회전은 그 기기에만 적용돼요(다른 기기의 갱신 토큰은 그대로 돼요)', async () => {
    const t = await setup();
    const a = await connect(t, MOCK.staff);
    const b = await connect(t, MOCK.staff);
    expect((await refresh(t, a.tokens.refresh_token)).statusCode).toBe(200);
    expect((await refresh(t, b.tokens.refresh_token)).statusCode).toBe(200);
    expect((await refresh(t, a.tokens.refresh_token)).json().error).toBe('invalid_grant');
  });

  it(`한 사람 × 한 앱의 기기는 ${MAX_DEVICES_PER_APP}대까지이고, 넘치면 가장 먼저 연결한 기기가 끊겨요`, async () => {
    const t = await setup();
    const sessions: TokenResponse[] = [];
    for (let i = 0; i <= MAX_DEVICES_PER_APP; i += 1) {
      sessions.push((await connectCli(t, MOCK.staff)).tokens);
      t.advance(1_000);
    }
    expect(await grantCount(t)).toBe(MAX_DEVICES_PER_APP);
    expect((await mcpRequest(t, sessions[0]!.access_token, 'tools/list')).statusCode).toBe(401);
    expect((await mcpRequest(t, sessions[1]!.access_token, 'tools/list')).statusCode).toBe(200);
  });

  it('모든 기기 로그아웃은 모든 앱·모든 기기를 끊어요', async () => {
    const t = await setup();
    await connectCli(t, MOCK.staff);
    await connectCli(t, MOCK.staff, CODEX, 'http://127.0.0.1:1455/callback');
    const { user } = await connect(t, MOCK.staff);
    expect((await user.call('POST', '/api/auth/logout-all')).body).toMatchObject({ ok: true, grants: 3 });
    expect(await grantCount(t)).toBe(0);
  });
});

describe('S6 연결하는 법', () => {
  it('허용 목록 안인 CLI 앱과 MCP 주소를 알려 줘요', async () => {
    const t = await setup();
    const user = await t.loginAs(MOCK.staff);
    const res = await user.call('GET', '/api/mcp/connections');
    expect(res.body).toMatchObject({
      available: true,
      mcpUrl: `${BASE}/mcp`,
      cliApps: [
        { clientId: CLAUDE_CODE.clientId, appName: 'Claude Code' },
        { clientId: CODEX.clientId, appName: 'Codex' },
      ],
    });
  });

  it('MCP를 끄면 연결하는 법도 비어요', async () => {
    const t = await setup({ mcp: false });
    const user = await t.loginAs(MOCK.staff);
    expect((await user.call('GET', '/api/mcp/connections')).body).toMatchObject({ available: false, cliApps: [] });
  });
});
