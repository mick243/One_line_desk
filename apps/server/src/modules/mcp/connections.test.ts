import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { fakeNotices, fakeRooms } from './fixtures/fake-services';
import { callTool, connect, refresh, ROOMS_ARGS, setupMcp, type TestApp } from './fixtures/oauth-flow';
import { DEMO_CLIENT } from './index';

// S6 "연결된 AI 앱"과 [끊기](M4), 시연 시나리오(동의 → 조회 → 링크 → 끊기 → 퇴사 차단).

// 시험마다 새 PGlite를 띄우고 인가 흐름을 한 바퀴 돌아서, 파일 첫 시험(WASM 준비)이 5초를 넘을 수 있어요.
vi.setConfig({ testTimeout: 20_000 });

const opened: TestApp[] = [];
async function setup() {
  const t = await createTestApp({ start: Date.parse('2026-10-26T09:00:00+09:00') });
  opened.push(t);
  t.ctx.services.rooms = fakeRooms().service;
  t.ctx.services.notices = fakeNotices().service;
  await setupMcp(t);
  return t;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

describe('연결된 AI 앱', () => {
  it('[MCP 요구 6] 앱 이름·연결한 날·범위만 보여 주고 "마지막 사용"은 없어요', async () => {
    const t = await setup();
    const { user, tokens } = await connect(t, MOCK.staff);
    await callTool(t, tokens.access_token, 'rooms_find_free', ROOMS_ARGS);
    const res = await user.call('GET', '/api/mcp/connections');
    expect(res.body).toEqual({
      available: true,
      tools: ['rooms.read', 'notices.read'],
      apps: [{ clientId: DEMO_CLIENT.clientId, appName: 'Claude', connectedOn: '2026-10-26', scopes: ['rooms.read', 'notices.read'] }],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/last|used/i);
  });

  it('[MCP 요구 6] 연결이 없으면 빈 목록이고, 다른 사람의 연결은 보이지 않아요', async () => {
    const t = await setup();
    await connect(t, MOCK.staff);
    const other = await t.loginAs(MOCK.dev);
    expect((await other.call('GET', '/api/mcp/connections')).body.apps).toEqual([]);
  });

  it('[MCP-7] MCP를 끄면 S6에도 쓸 수 있는 도구가 없다고 알려요(연결 줄은 남아요)', async () => {
    const t = await setup();
    const { user } = await connect(t, MOCK.staff);
    await t.ctx.ops.setModule('p_op', 'notices', 'off');
    expect((await user.call('GET', '/api/mcp/connections')).body).toMatchObject({ available: true, tools: ['rooms.read'] });
    await t.ctx.ops.setFlag('p_op', 'mcp', false);
    const res = await user.call('GET', '/api/mcp/connections');
    expect(res.body).toMatchObject({ available: false, tools: [] });
    expect(res.body.apps).toHaveLength(1);
  });

  it('[ADR-03 시험] [끊기]는 고정 버튼 쓰기로 감사 로그에 남고, 내용 칸은 없어요', async () => {
    const t = await setup();
    const { user } = await connect(t, MOCK.staff);
    expect((await user.call('DELETE', `/api/mcp/connections/${DEMO_CLIENT.clientId}`)).body).toEqual({ ok: true, removed: 1 });
    const audit = (await t.db.query("select channel, module, action, result from audit_log where action = 'disconnect'")).rows;
    expect(audit).toEqual([{ channel: 'write', module: 'mcp', action: 'disconnect', result: 'done' }]);
    expect((await user.call('GET', '/api/mcp/connections')).body.apps).toEqual([]);
  });

  it('[ADR-13] 연결 목록과 [끊기]는 로그인해야 하고, [끊기]는 CSRF 토큰도 있어야 해요', async () => {
    const t = await setup();
    const { user } = await connect(t, MOCK.staff);
    expect((await t.app.inject({ method: 'GET', url: '/api/mcp/connections' })).statusCode).toBe(401);
    const res = await t.app.inject({ method: 'DELETE', url: `/api/mcp/connections/${DEMO_CLIENT.clientId}`, headers: { cookie: user.cookie } });
    expect(res.statusCode).toBe(403);
  });
});

describe('시연 시나리오(모의 데이터)', () => {
  it('[MCP-8] 동의 → 조회 → 링크 → 끊기 → 다시 연결 → 퇴사 차단', async () => {
    const t = await setup();
    // 동의 → 조회
    const first = await connect(t, MOCK.staff);
    const out = (await callTool(t, first.tokens.access_token, 'rooms_find_free', ROOMS_ARGS)).json().result.structuredContent;
    expect(out.candidates[0].link).toMatch(/^http:\/\/localhost:5190\/r\/[A-Za-z0-9_.-]+$/);
    // 링크를 만든 것만으로는 예약·plan이 생기지 않아요(예약은 앱 확인 시트에서만).
    expect((await t.db.query('select count(*)::int as n from plans')).rows[0]).toEqual({ n: 0 });
    expect((await t.db.query('select count(*)::int as n from room_reservations')).rows[0]).toEqual({ n: 0 });
    // 끊기
    await first.user.call('DELETE', `/api/mcp/connections/${DEMO_CLIENT.clientId}`);
    expect((await callTool(t, first.tokens.access_token, 'rooms_find_free', ROOMS_ARGS)).statusCode).toBe(401);
    // 다시 연결 → 퇴사 차단
    const second = await connect(t, MOCK.staff);
    expect((await callTool(t, second.tokens.access_token, 'notices_search', { query: '공지' })).statusCode).toBe(200);
    t.adapters.employees.setActive(MOCK.staff, false);
    t.advance(t.ctx.ops.get().values.employmentRecheckSeconds * 1000);
    expect((await callTool(t, second.tokens.access_token, 'notices_search', { query: '공지' })).statusCode).toBe(401);
    expect((await refresh(t, second.tokens.refresh_token)).json().error).toBe('invalid_grant');
  });
});
