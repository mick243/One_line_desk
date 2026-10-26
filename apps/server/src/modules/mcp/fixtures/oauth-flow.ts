import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import type { Db } from '../../../core/db';
import type { createTestApp } from '../../../testing';
import type { TokenResponse } from '../auth-service';
import { DEMO_CLIENT } from '../index';

// MCP 시험 도우미: Claude 커넥터가 하는 일(authorize → 동의 → token → /mcp)을 app.inject로 흉내 내요.

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export const BASE = 'http://localhost:5190';
export const MCP_URL = `${BASE}/mcp`;
export const REDIRECT_URI = DEMO_CLIENT.redirectUris[0];
export const OPERATOR_ID = 'p_test_operator';

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** 시연 클라이언트를 넣고 MCP 스위치를 켜요(운영자 동작 흉내). */
export async function setupMcp(t: TestApp, opts: { mcp?: boolean } = {}) {
  await t.modules.find((m) => m.kind === 'mcp')!.seed!();
  if (opts.mcp ?? true) await t.ctx.ops.setFlag(OPERATOR_ID, 'mcp', true);
}

export function authorizeQuery(overrides: Record<string, string | undefined> = {}, challenge = pkce().challenge): string {
  const params: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: DEMO_CLIENT.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-xyz',
    resource: MCP_URL,
    ...overrides,
  };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
  return `/oauth/authorize?${qs.toString()}`;
}

export async function authorize(t: TestApp, overrides: Record<string, string | undefined> = {}, challenge?: string) {
  const res = await t.app.inject({ method: 'GET', url: authorizeQuery(overrides, challenge) });
  return { status: res.statusCode, location: new URL(String(res.headers.location)) };
}

export async function tokenRequest(
  t: TestApp,
  params: Record<string, string | undefined>,
  client: { id: string; secret: string } = { id: DEMO_CLIENT.clientId, secret: DEMO_CLIENT.clientSecret },
  how: 'post' | 'basic' = 'post',
  url = '/oauth/token',
) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, v);
  if (how === 'post') {
    form.set('client_id', client.id);
    form.set('client_secret', client.secret);
  }
  const basic = Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString('base64');
  return t.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(how === 'basic' ? { authorization: `Basic ${basic}` } : {}) },
    payload: form.toString(),
  });
}

/** authorize → 로그인한 사람의 [연결 허락] → 코드 교환까지. */
export async function connect(t: TestApp, idpSubject: string, opts: { scope?: string } = {}) {
  const user = await t.loginAs(idpSubject);
  const { verifier, challenge } = pkce();
  const auth = await authorize(t, { scope: opts.scope }, challenge);
  expect(auth.status).toBe(302);
  expect(auth.location.pathname).toBe('/oauth/consent');
  const req = auth.location.searchParams.get('req')!;
  const decision = await user.call('POST', '/api/mcp/consent', { req, decision: 'allow' });
  expect(decision.status).toBe(200);
  const back = new URL(decision.body.redirectTo);
  expect(back.searchParams.get('state')).toBe('state-xyz');
  const code = back.searchParams.get('code')!;
  const res = await tokenRequest(t, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier, resource: MCP_URL });
  expect(res.statusCode).toBe(200);
  return { user, tokens: res.json() as TokenResponse };
}

export function refresh(t: TestApp, refreshToken: string) {
  return tokenRequest(t, { grant_type: 'refresh_token', refresh_token: refreshToken, resource: MCP_URL });
}

export function mcpRequest(
  t: TestApp,
  accessToken: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return t.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
}

export function callTool(t: TestApp, accessToken: string, name: string, args: Record<string, unknown>) {
  return mcpRequest(t, accessToken, 'tools/call', { name, arguments: args });
}

export async function toolNames(t: TestApp, accessToken: string): Promise<string[]> {
  const res = await mcpRequest(t, accessToken, 'tools/list');
  expect(res.statusCode).toBe(200);
  return (res.json().result.tools as { name: string }[]).map((x) => x.name).sort();
}

/** 감사 로그·마이그레이션 기록을 뺀 모든 표의 내용(MCP 경로 DB 쓰기 0건 확인용) */
export async function dumpTablesExceptAudit(db: Db): Promise<string> {
  const { rows } = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' order by table_name");
  const out: Record<string, unknown[]> = {};
  for (const { table_name } of rows) {
    if (table_name === 'audit_log' || table_name === 'schema_migrations') continue;
    out[table_name] = (await db.query(`select * from ${table_name}`)).rows;
  }
  return JSON.stringify(out);
}

export const ROOMS_ARGS = { date: '2026-10-27', start: '15:00', people: 6, equipment: ['화면'] };
