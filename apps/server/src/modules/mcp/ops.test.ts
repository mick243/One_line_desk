import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pseudonymize } from '../../core/pseudonym';
import { createTestApp, MOCK } from '../../testing';
import * as admin from './admin';
import { fakeNotices, fakeRooms } from './fixtures/fake-services';
import { authorize, callTool, connect, MCP_URL, mcpRequest, pkce, refresh, ROOMS_ARGS, setupMcp, type TestApp, tokenRequest } from './fixtures/oauth-flow';
import { DEMO_CLIENT } from './index';

// MCP 관리 평면(11/3, MCP 통합 회의 1단계): 운영자 API·명령 도구 함수·보고.
// 운영자 웹 화면은 없어요(R7). 감사 로그에는 동작·클라이언트 ID·결과만, 접속기록에는 끊은 사람의 가명 ID만 남아요.

vi.setConfig({ testTimeout: 30_000 });

const opened: TestApp[] = [];
async function setup(opts: { demoWide?: boolean } = {}) {
  const t = await createTestApp();
  opened.push(t);
  if (opts.demoWide) t.ctx.config.demoWide = true;
  t.ctx.services.rooms = fakeRooms().service;
  t.ctx.services.notices = fakeNotices().service;
  await setupMcp(t);
  return t;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const CHATGPT_REDIRECT = 'https://chatgpt.example.test/connector/oauth/callback';

/** 등록한 기밀 클라이언트로 authorize → 동의 → token까지 */
async function connectWith(t: TestApp, client: { id: string; secret: string; redirect: string }, idpSubject = MOCK.staff) {
  const user = await t.loginAs(idpSubject);
  const { verifier, challenge } = pkce();
  const auth = await authorize(t, { client_id: client.id, redirect_uri: client.redirect }, challenge);
  expect(auth.location.pathname).toBe('/oauth/consent');
  const decision = await user.call('POST', '/api/mcp/consent', { req: auth.location.searchParams.get('req'), decision: 'allow' });
  const code = new URL(decision.body.redirectTo).searchParams.get('code')!;
  const res = await tokenRequest(
    t,
    { grant_type: 'authorization_code', code, redirect_uri: client.redirect, code_verifier: verifier, resource: MCP_URL },
    { id: client.id, secret: client.secret },
  );
  expect(res.statusCode).toBe(200);
  return res.json() as { access_token: string; refresh_token: string };
}

describe('운영자만 써요', () => {
  it('[MCP 1단계] 운영자가 아니면 목록·등록·승인·끊기·회수·사람별 끊기·보고가 모두 403이에요', async () => {
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const id = DEMO_CLIENT.clientId;
    for (const [method, url, body] of [
      ['GET', '/api/ops/mcp/clients'],
      ['POST', '/api/ops/mcp/clients', { appName: 'X', kind: 'public', redirectUris: ['http://localhost/callback'] }],
      ['PUT', `/api/ops/mcp/clients/${id}/approval`, { approved: true }],
      ['POST', `/api/ops/mcp/clients/${id}/disconnect`],
      ['DELETE', `/api/ops/mcp/clients/${id}`],
      ['GET', '/api/ops/mcp/report'],
      ['GET', '/api/ops/mcp/report?month=2026-10'],
      ['POST', '/api/ops/mcp/people/disconnect', { ref: 'pr_x' }],
    ] as const) {
      expect((await staff.call(method, url, body)).status, `${method} ${url}`).toBe(403);
    }
    expect((await t.db.query('select client_id from mcp_clients where security_approved')).rows).toEqual([]);
    expect((await t.app.inject({ method: 'GET', url: '/api/ops/mcp/clients' })).statusCode).toBe(401);
  });

  it('[MCP 1단계] 넓게 연 시연에서는 운영자도 바꾸지 못하고 읽기만 해요', async () => {
    const t = await setup({ demoWide: true });
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('GET', '/api/ops/mcp/clients')).status).toBe(200);
    const res = await op.call('POST', '/api/ops/mcp/clients', { appName: 'X', kind: 'public', redirectUris: ['http://localhost/callback'] });
    expect(res).toMatchObject({ status: 403, body: { error: 'demo-locked' } });
  });

  it('[MCP 1단계] 목록에는 연결한 사람·기기 수만 있고 이름·가명 ID·비밀 해시는 없어요', async () => {
    const t = await setup();
    const { user } = await connect(t, MOCK.staff);
    await connect(t, MOCK.dev);
    const op = await t.loginAs(MOCK.operator);
    const list = (await op.call('GET', '/api/ops/mcp/clients')).body as { clientId: string; people: number; devices: number }[];
    expect(list.find((c) => c.clientId === DEMO_CLIENT.clientId)).toMatchObject({
      appName: 'Claude',
      kind: 'confidential',
      demoOnly: true,
      securityApproved: false,
      redirectUris: [...DEMO_CLIENT.redirectUris],
      people: 2,
      devices: 2,
    });
    const text = JSON.stringify(list);
    const people = (await t.db.query<{ pseudonym_id: string }>('select pseudonym_id from mcp_grants')).rows.map((r) => r.pseudonym_id);
    for (const p of people) expect(text).not.toContain(p);
    expect(text).not.toContain(user.me.displayName);
    expect(text).not.toMatch(/secret|hash/i);
  });
});

describe('등록', () => {
  it('[MCP 1단계] 기밀 클라이언트 비밀은 등록 응답에서 한 번만 보이고, DB에는 해시만 남아요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/ops/mcp/clients',
      headers: { cookie: op.cookie, 'x-csrf-token': op.csrf },
      payload: { appName: 'ChatGPT', kind: 'confidential', redirectUris: [CHATGPT_REDIRECT] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.client).toMatchObject({ appName: 'ChatGPT', kind: 'confidential', securityApproved: false, demoOnly: false, people: 0, devices: 0 });
    expect(body.client.clientId).toMatch(/^mcp-[0-9a-f]{16}$/);
    const secret = body.clientSecret as string;
    expect(secret.length).toBeGreaterThanOrEqual(40);

    const row = (await t.db.query<{ client_secret_hash: string }>('select client_secret_hash from mcp_clients where client_id = $1', [body.client.clientId]))
      .rows[0]!;
    expect(row.client_secret_hash).toBe(createHash('sha256').update(secret).digest('hex'));
    // 다시 볼 길이 없어요: 목록에도, DB 어디에도(감사 로그 포함) 비밀 그대로는 없어요.
    expect(JSON.stringify((await op.call('GET', '/api/ops/mcp/clients')).body)).not.toContain(secret);
    const { rows: tables } = await t.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'");
    for (const { table_name } of tables) expect(JSON.stringify((await t.db.query(`select * from ${table_name}`)).rows), table_name).not.toContain(secret);
  });

  it('[MCP 1단계] 공개 클라이언트는 비밀이 없고 루프백 주소만 받아요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    const bad = await op.call('POST', '/api/ops/mcp/clients', { appName: 'CLI', kind: 'public', redirectUris: ['https://evil.example.test/cb'] });
    expect(bad).toMatchObject({ status: 400, body: { error: 'bad-request' } });
    const ok = await op.call('POST', '/api/ops/mcp/clients', { appName: 'Gemini CLI', kind: 'public', redirectUris: ['http://localhost/callback'] });
    expect(ok.status).toBe(200);
    expect(ok.body.clientSecret).toBeUndefined();
    expect(ok.body.client).toMatchObject({ kind: 'public', redirectUris: ['http://localhost/callback'] });
    const row = (await t.db.query('select client_secret_hash, public_client from mcp_clients where client_id = $1', [ok.body.client.clientId])).rows[0];
    expect(row).toEqual({ client_secret_hash: null, public_client: true });
    // 기밀 클라이언트도 http 바깥 주소는 받지 않아요.
    const http = await op.call('POST', '/api/ops/mcp/clients', { appName: 'X', kind: 'confidential', redirectUris: ['http://example.test/cb'] });
    expect(http.status).toBe(400);
  });

  it('[MCP 1단계] 등록 → 보안팀 승인 → 연결 → 승인 끄면 막히고 → 다시 켜면 이어져요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    const created = (await op.call('POST', '/api/ops/mcp/clients', { appName: 'ChatGPT', kind: 'confidential', redirectUris: [CHATGPT_REDIRECT] })).body;
    const client = { id: created.client.clientId as string, secret: created.clientSecret as string, redirect: CHATGPT_REDIRECT };

    // 승인 전에는 허용 목록 밖이라 동의 시트까지 가지 못해요.
    expect((await authorize(t, { client_id: client.id, redirect_uri: client.redirect })).location.searchParams.get('error')).toBe('not-allowed');
    expect((await op.call('PUT', `/api/ops/mcp/clients/${client.id}/approval`, { approved: true })).body).toMatchObject({ securityApproved: true });
    const tokens = await connectWith(t, client);
    expect((await callTool(t, tokens.access_token, 'rooms_find_free', ROOMS_ARGS)).statusCode).toBe(200);

    await op.call('PUT', `/api/ops/mcp/clients/${client.id}/approval`, { approved: false });
    expect((await mcpRequest(t, tokens.access_token, 'tools/list')).statusCode).toBe(401);
    await op.call('PUT', `/api/ops/mcp/clients/${client.id}/approval`, { approved: true });
    expect((await mcpRequest(t, tokens.access_token, 'tools/list')).statusCode).toBe(200);
  });
});

describe('끊기·회수', () => {
  it('[MCP 1단계] 회수하면 그 앱의 모든 연결이 끊겨 토큰·갱신이 거부되고 다시 붙지 못해요', async () => {
    const t = await setup();
    const a = await connect(t, MOCK.staff);
    const b = await connect(t, MOCK.dev);
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('DELETE', `/api/ops/mcp/clients/${DEMO_CLIENT.clientId}`)).body).toEqual({ removed: 2 });
    for (const tokens of [a.tokens, b.tokens]) {
      expect((await mcpRequest(t, tokens.access_token, 'tools/list')).statusCode).toBe(401);
      expect((await refresh(t, tokens.refresh_token)).statusCode).toBe(401);
    }
    expect((await t.db.query('select * from mcp_grants')).rows).toEqual([]);
    expect((await authorize(t)).location.searchParams.get('error')).toBe('not-allowed');
    expect((await op.call('DELETE', `/api/ops/mcp/clients/${DEMO_CLIENT.clientId}`)).status).toBe(404);
  });

  it('[MCP 1단계] 앱별 강제 끊기는 그 앱의 모든 사람·기기를 끊고, 등록은 남아 다시 연결할 수 있어요', async () => {
    const t = await setup();
    const a = await connect(t, MOCK.staff);
    await connect(t, MOCK.staff);
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('POST', `/api/ops/mcp/clients/${DEMO_CLIENT.clientId}/disconnect`)).body).toEqual({ removed: 2 });
    expect((await mcpRequest(t, a.tokens.access_token, 'tools/list')).statusCode).toBe(401);
    expect((await t.db.query('select client_id from mcp_clients where client_id = $1', [DEMO_CLIENT.clientId])).rows).toHaveLength(1);
    const again = await connect(t, MOCK.staff);
    expect((await mcpRequest(t, again.tokens.access_token, 'tools/list')).statusCode).toBe(200);
  });

  it('[MCP 1단계·ADR-20] 감사 로그에는 동작·클라이언트 ID·결과만, 접속기록에는 끊긴 사람의 가명 ID만 남아요', async () => {
    const t = await setup();
    await connect(t, MOCK.staff);
    const op = await t.loginAs(MOCK.operator);
    const created = (await op.call('POST', '/api/ops/mcp/clients', { appName: '카나리앱이름', kind: 'confidential', redirectUris: [CHATGPT_REDIRECT] })).body;
    await op.call('PUT', `/api/ops/mcp/clients/${created.client.clientId}/approval`, { approved: true });
    await op.call('POST', `/api/ops/mcp/clients/${DEMO_CLIENT.clientId}/disconnect`);
    await op.call('DELETE', `/api/ops/mcp/clients/${created.client.clientId}`);

    const audit = (
      await t.db.query<{
        pseudonym_id: string;
        module: string | null;
        action: string;
        tool: string | null;
        client_id: string;
        plan_id: string | null;
        result: string;
      }>("select pseudonym_id, module, action, tool, client_id, plan_id, result from audit_log where channel = 'ops' and action like 'mcpClient.%' order by id")
    ).rows;
    expect(audit.map((r) => [r.action, r.client_id, r.result])).toEqual([
      ['mcpClient.add', created.client.clientId, 'confidential'],
      ['mcpClient.approve', created.client.clientId, 'done'],
      ['mcpClient.disconnect', DEMO_CLIENT.clientId, 'done'],
      ['mcpClient.revoke', created.client.clientId, 'done'],
    ]);
    expect(audit.every((r) => r.pseudonym_id === pseudonymize(t.ctx.config.pseudonymSecret, MOCK.operator))).toBe(true);
    expect(audit.every((r) => r.module === null && r.tool === null && r.plan_id === null)).toBe(true);
    const dump = JSON.stringify((await t.db.query('select * from audit_log')).rows);
    expect(dump).not.toContain('카나리앱이름');
    expect(dump).not.toContain(CHATGPT_REDIRECT);

    const staffId = pseudonymize(t.ctx.config.pseudonymSecret, MOCK.staff);
    const access = (await t.db.query<{ action: string; subject_refs: string[] }>("select action, subject_refs from access_log where action = 'mcp.disconnect'"))
      .rows;
    // 회수한 앱은 연결이 없었어요. 앱별 끊기 한 줄에 끊긴 사람 표시만 있어요.
    expect(access).toEqual([{ action: 'mcp.disconnect', subject_refs: [`person:${staffId}`] }]);
  });

  it('[MCP 1단계] 명령 도구 함수는 감사 로그의 "누가"를 고정 값 cli로 남겨요', async () => {
    const t = await setup();
    const deps = { db: t.db, audit: t.ctx.audit, access: t.ctx.access, now: t.now };
    const created = await admin.addClient(deps, admin.CLI_ACTOR, { appName: 'Claude Code', kind: 'public', redirectUris: ['http://127.0.0.1/callback'] });
    await admin.setApproval(deps, admin.CLI_ACTOR, created.client.clientId, true);
    expect((await admin.listClients(t.db)).find((c) => c.clientId === created.client.clientId)).toMatchObject({ securityApproved: true });
    const who = (await t.db.query<{ pseudonym_id: string }>("select distinct pseudonym_id from audit_log where channel = 'ops' and action like 'mcpClient.%'"))
      .rows;
    expect(who).toEqual([{ pseudonym_id: 'cli' }]);
    await expect(admin.setApproval(deps, admin.CLI_ACTOR, 'mcp-not-here-0000', true)).rejects.toMatchObject({ status: 404 });
  });
});

describe('보고', () => {
  it('[MCP 1단계·530] 달 보고는 날마다 셈 표에서 종류별·앱별 합계를, 접속기록에서 호출한 사람 수를 셈만으로 돌려줘요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    await callTool(t, tokens.access_token, 'rooms_find_free', ROOMS_ARGS);
    await callTool(t, tokens.access_token, 'rooms_find_free', { ...ROOMS_ARGS, people: 0 });
    // 등록되지 않은 앱·허락되지 않은 앱이 연결하려다 막혀요.
    await authorize(t, { client_id: 'not-registered-app' });
    const op = await t.loginAs(MOCK.operator);
    const created = (await op.call('POST', '/api/ops/mcp/clients', { appName: 'ChatGPT', kind: 'confidential', redirectUris: [CHATGPT_REDIRECT] })).body;
    await authorize(t, { client_id: created.client.clientId, redirect_uri: CHATGPT_REDIRECT });

    const report = (await op.call('GET', '/api/ops/mcp/report')).body;
    expect(report).toMatchObject({ month: '2026-10', from: '2026-09-30T15:00:00.000Z', to: '2026-10-31T15:00:00.000Z' });
    expect(report.totals).toEqual({
      'call.found': 1,
      'call.none': 0,
      'call.refused': 1,
      'call.error': 0,
      connect: 1,
      'connect.denied': 0,
      disconnect: 0,
      'disconnect.ops': 0,
      'token.refused': 0,
      'authorize.blocked': 2,
      'employment.ended': 0,
    });
    expect(report.byApp).toEqual([
      { app: '-', counts: { 'authorize.blocked': 1 } },
      { app: 'ChatGPT', counts: { 'authorize.blocked': 1 } },
      { app: 'Claude', counts: { 'call.found': 1, 'call.refused': 1, connect: 1 } },
    ]);
    expect(report.accessLog).toEqual({ connects: 1, calls: 2, callers: 1, disconnects: 0 });
    expect(report.now).toEqual({ clients: 4, approvedClients: 0, people: 1, devices: 1 });
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/p_[0-9a-f]{6}/);
    expect(text).not.toContain('not-registered-app');
    expect(text).not.toContain(DEMO_CLIENT.clientId);
    expect(text).not.toContain(created.client.clientId);
    // 등록되지 않은 클라이언트 ID(바깥 글자)는 감사 로그에도 없어요.
    expect(JSON.stringify((await t.db.query('select * from audit_log')).rows)).not.toContain('not-registered-app');

    // 다른 달은 그 달 셈만이에요. 7일이 지나 감사 로그가 지워져도(감사 로그 시각은 DB 시계라 여기서는 직접 지워요) 달 셈은 남아요.
    t.advance(10 * 24 * 60 * 60_000);
    await t.db.query('delete from audit_log');
    expect(await t.runRetention()).toEqual([]);
    const later = await t.loginAs(MOCK.operator);
    const october = (await later.call('GET', '/api/ops/mcp/report?month=2026-10')).body;
    expect(october.totals).toEqual(report.totals);
    expect(october.byApp).toEqual(report.byApp);
    const november = (await later.call('GET', '/api/ops/mcp/report?month=2026-11')).body;
    expect(november).toMatchObject({ month: '2026-11', accessLog: { connects: 0, calls: 0, callers: 0, disconnects: 0 }, byApp: [] });
    expect(Object.values(november.totals).every((n) => n === 0)).toBe(true);
  });

  it('[MCP 1단계·530] 달은 YYYY-MM 모양만 받아요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    for (const month of ['2026-13', '2026-1', '202610', 'x']) {
      expect((await op.call('GET', `/api/ops/mcp/report?month=${month}`)).status, month).toBe(400);
    }
    const deps = { db: t.db, now: t.now };
    await expect(admin.report(deps, '2026-00')).rejects.toMatchObject({ status: 400 });
    expect((await admin.report(deps, '2025-12')).month).toBe('2025-12');
  });
});
