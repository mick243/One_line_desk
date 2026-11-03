import type { PeopleSearchResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pseudonymize } from '../../core/pseudonym';
import { createTestApp, MOCK } from '../../testing';
import { fakeNotices, fakeRooms } from './fixtures/fake-services';
import { authorize, connect, MCP_URL, mcpRequest, pkce, REDIRECT_URI, refresh, setupMcp, type TestApp, tokenRequest } from './fixtures/oauth-flow';
import { DEMO_CLIENT, DEMO_CLI_CLIENTS } from './index';

// 사람별 강제 끊기(11/3 사용자 결정, ADR-15 관리 평면 1단계): 운영자가 초대와 같은 직원 검색으로 고른 사람의 모든 AI 앱 연결을 끊어요.
// 응답은 끊은 연결 수뿐이고, 감사 로그에는 동작·결과만, 접속기록 mcp.disconnect에는 운영자와 끊긴 사람 가명 ID(person:)만 남아요.

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

type Session = Awaited<ReturnType<TestApp['loginAs']>>;

/** 초대와 같은 직원 검색으로 하나를 골라요. */
async function pick(me: Session, query: string): Promise<PeopleSearchResponse['items'][number]> {
  const res = await me.call('POST', '/api/people/search', { query });
  expect(res.status).toBe(200);
  const items = (res.body as PeopleSearchResponse).items;
  expect(items).toHaveLength(1);
  return items[0]!;
}

/** 공개 클라이언트(Claude Code)로 연결 — 다른 앱도 같이 끊기는지 보려고요. */
async function connectCli(t: TestApp, idpSubject: string) {
  const user = await t.loginAs(idpSubject);
  const cli = DEMO_CLI_CLIENTS[0];
  const redirect = 'http://localhost:43123/callback';
  const { verifier, challenge } = pkce();
  const auth = await authorize(t, { client_id: cli.clientId, redirect_uri: redirect }, challenge);
  expect(auth.location.pathname).toBe('/oauth/consent');
  const decision = await user.call('POST', '/api/mcp/consent', { req: auth.location.searchParams.get('req'), decision: 'allow' });
  const code = new URL(decision.body.redirectTo).searchParams.get('code')!;
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource: MCP_URL,
    client_id: cli.clientId,
  });
  const res = await t.app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form.toString(),
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { access_token: string; refresh_token: string };
}

describe('운영자만 써요', () => {
  it('[MCP 사람별 끊기] 운영자가 아니면 403, 로그인 없으면 401, 넓게 연 시연에서는 운영자도 403이에요', async () => {
    const t = await setup();
    const a = await connect(t, MOCK.staff);
    // 직원 검색은 누구나 쓰지만, 그 ref로 끊는 건 운영자만이에요.
    const dev = await t.loginAs(MOCK.dev);
    const ref = (await pick(dev, '하늘')).ref;
    expect((await dev.call('POST', '/api/ops/mcp/people/disconnect', { ref })).status).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/ops/mcp/people/disconnect', payload: { ref } })).statusCode).toBe(401);
    expect((await mcpRequest(t, a.tokens.access_token, 'tools/list')).statusCode).toBe(200);

    const wide = await setup({ demoWide: true });
    await connect(wide, MOCK.staff);
    const op = await wide.loginAs(MOCK.operator);
    const res = await op.call('POST', '/api/ops/mcp/people/disconnect', { ref: (await pick(op, '하늘')).ref });
    expect(res).toMatchObject({ status: 403, body: { error: 'demo-locked' } });
    expect((await wide.db.query('select * from mcp_grants')).rows).toHaveLength(1);
  });

  it('[MCP 사람별 끊기] 직원 검색이 그 운영자에게 준 ref만 받아요(남이 받은 ref·지어낸 값·30분 지난 ref는 400)', async () => {
    const t = await setup();
    await connect(t, MOCK.staff);
    const op = await t.loginAs(MOCK.operator);
    const dev = await t.loginAs(MOCK.dev);
    const someoneElses = (await pick(dev, '하늘')).ref;
    for (const ref of [someoneElses, 'pr_made-up', 'not-a-ref']) {
      expect((await op.call('POST', '/api/ops/mcp/people/disconnect', { ref })).body, ref).toMatchObject({ error: 'bad-request' });
    }
    const mine = (await pick(op, '하늘')).ref;
    t.advance(31 * 60_000);
    const later = await t.loginAs(MOCK.operator);
    expect((await later.call('POST', '/api/ops/mcp/people/disconnect', { ref: mine })).status).toBe(400);
    expect((await t.db.query('select * from mcp_grants')).rows).toHaveLength(1);
  });
});

describe('끊기', () => {
  it('[MCP 사람별 끊기] 고른 사람의 모든 앱·기기 연결이 끊겨 접근·갱신 토큰이 거부되고, 다른 사람 연결은 그대로예요', async () => {
    const t = await setup();
    const laptop = await connect(t, MOCK.staff);
    const desktop = await connect(t, MOCK.staff);
    const cli = await connectCli(t, MOCK.staff);
    const other = await connect(t, MOCK.dev);
    const op = await t.loginAs(MOCK.operator);

    const res = await op.call('POST', '/api/ops/mcp/people/disconnect', { ref: (await pick(op, '하늘')).ref });
    expect(res).toEqual({ status: 200, body: { removed: 3 } });
    for (const tokens of [laptop.tokens, desktop.tokens, cli]) {
      expect((await mcpRequest(t, tokens.access_token, 'tools/list')).statusCode).toBe(401);
    }
    for (const tokens of [laptop.tokens, desktop.tokens]) {
      const res = await refresh(t, tokens.refresh_token);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
    }
    const cliRefresh = await t.app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cli.refresh_token,
        resource: MCP_URL,
        client_id: DEMO_CLI_CLIENTS[0].clientId,
      }).toString(),
    });
    expect(cliRefresh.statusCode).toBe(400);
    expect(cliRefresh.json().error).toBe('invalid_grant');

    expect((await mcpRequest(t, other.tokens.access_token, 'tools/list')).statusCode).toBe(200);
    expect((await refresh(t, other.tokens.refresh_token)).statusCode).toBe(200);
    const devId = pseudonymize(t.ctx.config.pseudonymSecret, MOCK.dev);
    expect((await t.db.query<{ pseudonym_id: string }>('select distinct pseudonym_id from mcp_grants')).rows).toEqual([{ pseudonym_id: devId }]);
    // 본인 S6에도 연결이 없어요.
    expect((await laptop.user.call('GET', '/api/mcp/connections')).body.apps).toEqual([]);
    // 다시 끊으면 끊을 연결이 없어요.
    expect((await op.call('POST', '/api/ops/mcp/people/disconnect', { ref: (await pick(op, '하늘')).ref })).body).toEqual({ removed: 0 });
  });

  it('[MCP 사람별 끊기] 끊기 전에 받아 둔 인가 코드로도 다시 붙지 못해요', async () => {
    const t = await setup();
    await connect(t, MOCK.staff);
    const user = await t.loginAs(MOCK.staff);
    const { verifier, challenge } = pkce();
    const auth = await authorize(t, {}, challenge);
    const decision = await user.call('POST', '/api/mcp/consent', { req: auth.location.searchParams.get('req'), decision: 'allow' });
    const code = new URL(decision.body.redirectTo).searchParams.get('code')!;

    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('POST', '/api/ops/mcp/people/disconnect', { ref: (await pick(op, '하늘')).ref })).body).toEqual({ removed: 1 });
    const res = await tokenRequest(t, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier, resource: MCP_URL });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    expect((await t.db.query('select * from mcp_grants')).rows).toEqual([]);
  });

  it('[MCP 사람별 끊기·ADR-20] 응답·감사 로그에는 이름·앱·가명 ID가 없고, 접속기록에는 운영자와 person:<가명 ID>만 남아요', async () => {
    const t = await setup();
    const { user } = await connect(t, MOCK.staff);
    const op = await t.loginAs(MOCK.operator);
    const chosen = await pick(op, '하늘');
    const res = await op.call('POST', '/api/ops/mcp/people/disconnect', { ref: chosen.ref });
    expect(res.body).toEqual({ removed: 1 });

    const staffId = pseudonymize(t.ctx.config.pseudonymSecret, MOCK.staff);
    const operatorId = pseudonymize(t.ctx.config.pseudonymSecret, MOCK.operator);
    const responseText = JSON.stringify(res.body);
    for (const leak of [staffId, MOCK.staff, chosen.name, user.me.displayName, DEMO_CLIENT.appName, DEMO_CLIENT.clientId]) {
      expect(responseText).not.toContain(leak);
    }

    const audit = (
      await t.db.query<{ pseudonym_id: string; module: string | null; tool: string | null; client_id: string | null; plan_id: string | null; result: string }>(
        "select pseudonym_id, module, tool, client_id, plan_id, result from audit_log where channel = 'ops' and action = 'mcpPerson.disconnect'",
      )
    ).rows;
    expect(audit).toEqual([{ pseudonym_id: operatorId, module: null, tool: null, client_id: null, plan_id: null, result: 'done' }]);
    const opsDump = JSON.stringify((await t.db.query("select * from audit_log where channel = 'ops'")).rows);
    for (const leak of [staffId, MOCK.staff, chosen.name, DEMO_CLIENT.appName, DEMO_CLIENT.clientId]) expect(opsDump).not.toContain(leak);

    const access = (
      await t.db.query<{ pseudonym_id: string; action: string; subject_refs: string[]; client_ip: string | null; request_id: string | null }>(
        "select pseudonym_id, action, subject_refs, client_ip, request_id from access_log where action in ('people.search', 'mcp.disconnect') order by id",
      )
    ).rows;
    expect(access.map((r) => [r.pseudonym_id, r.action, r.subject_refs])).toEqual([
      // 직원 검색은 기존처럼 보여 준 사람을 남겨요.
      [operatorId, 'people.search', [`person:${staffId}`]],
      [operatorId, 'mcp.disconnect', [`person:${staffId}`]],
    ]);
    expect(access[1]!.client_ip).toBe('127.0.0.1');
    expect(access[1]!.request_id).toMatch(/^[A-Za-z0-9_-]+$/);
    const accessDump = JSON.stringify((await t.db.query('select * from access_log')).rows);
    expect(accessDump).not.toContain(chosen.name);
    expect(accessDump).not.toContain(DEMO_CLIENT.appName);
  });

  it('[MCP 사람별 끊기] 끊을 연결이 없어도 결과 none과 접속기록 한 줄이 남아요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('POST', '/api/ops/mcp/people/disconnect', { ref: (await pick(op, '하늘')).ref })).body).toEqual({ removed: 0 });
    expect((await t.db.query("select result from audit_log where action = 'mcpPerson.disconnect'")).rows).toEqual([{ result: 'none' }]);
    const staffId = pseudonymize(t.ctx.config.pseudonymSecret, MOCK.staff);
    expect((await t.db.query("select subject_refs from access_log where action = 'mcp.disconnect'")).rows).toEqual([{ subject_refs: [`person:${staffId}`] }]);
  });
});
