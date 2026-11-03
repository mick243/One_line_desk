import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { fakeNotices, fakeRooms } from './fixtures/fake-services';
import { callTool, connect, OPERATOR_ID, ROOMS_ARGS, setupMcp, type TestApp, toolNames } from './fixtures/oauth-flow';
import { DEMO_CLIENT } from './index';

// MCP 통합 회의 0단계(11/2): MCP 접속기록(ADR-20), 도구별 운영 스위치, 봉인한 앱 확인 링크(B11).

vi.setConfig({ testTimeout: 20_000 });

const opened: TestApp[] = [];
async function setup(opts: { realRooms?: boolean } = {}) {
  const t = await createTestApp({ start: Date.parse('2026-11-02T09:00:00+09:00') });
  opened.push(t);
  if (opts.realRooms) await t.modules.find((m) => m.kind === 'rooms')!.seed!();
  else t.ctx.services.rooms = fakeRooms().service;
  t.ctx.services.notices = fakeNotices().service;
  await setupMcp(t);
  return t;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const accessRows = async (t: TestApp) =>
  (await t.db.query<{ action: string; pseudonym_id: string; subject_refs: string[] }>('select action, pseudonym_id, subject_refs from access_log order by id'))
    .rows;

describe('MCP 접속기록(ADR-20)', () => {
  it('연결 허락·도구 호출·끊기가 접속기록에 남고, 도구 이름·입력·클라이언트는 남지 않아요', async () => {
    const t = await setup();
    const { user, tokens } = await connect(t, MOCK.staff);
    await callTool(t, tokens.access_token, 'rooms_find_free', ROOMS_ARGS);
    await callTool(t, tokens.access_token, 'notices_search', { query: '연말정산' });
    await user.call('DELETE', `/api/mcp/connections/${DEMO_CLIENT.clientId}`);
    const rows = (await accessRows(t)).filter((r) => r.action.startsWith('mcp.'));
    expect(rows.map((r) => r.action)).toEqual(['mcp.connect', 'mcp.call', 'mcp.call', 'mcp.disconnect']);
    expect(new Set(rows.map((r) => r.pseudonym_id)).size).toBe(1);
    const all = JSON.stringify((await t.db.query('select * from access_log')).rows);
    for (const leaked of ['rooms_find_free', 'notices_search', '연말정산', DEMO_CLIENT.clientId, '15:00']) expect(all).not.toContain(leaked);
  });

  it('거부된 호출(범위 밖·꺼진 도구)도 접속 시도로 남아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff, { scope: 'notices.read' });
    const before = (await accessRows(t)).length;
    await callTool(t, tokens.access_token, 'rooms_find_free', ROOMS_ARGS);
    expect((await accessRows(t)).length).toBe(before + 1);
  });

  it('도구를 부르지 않는 요청(도구 목록)은 남기지 않아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const before = (await accessRows(t)).length;
    await toolNames(t, tokens.access_token);
    expect((await accessRows(t)).length).toBe(before);
  });
});

describe('도구별 운영 스위치', () => {
  it('운영자가 도구 하나를 끄면 그 도구만 목록에서 빠지고, 감사 로그에 도구 이름과 켬·끔만 남아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const op = await t.loginAs(MOCK.operator);
    const off = await op.call('PUT', '/api/ops/mcp-tool', { tool: 'notices_search', value: false });
    expect(off.status).toBe(200);
    expect(off.body.mcpToolsOff).toEqual(['notices_search']);
    expect(await toolNames(t, tokens.access_token)).toEqual(['my_requests_status', 'navi_find_team', 'navi_it_faq', 'navi_onboarding', 'rooms_find_free']);
    const refused = await callTool(t, tokens.access_token, 'notices_search', { query: '공지' });
    expect(refused.json().result?.isError ?? refused.json().error).toBeTruthy();
    const audit = (await t.db.query("select tool, result from audit_log where action = 'mcpTool.set'")).rows;
    expect(audit).toEqual([{ tool: 'notices_search', result: 'false' }]);

    await op.call('PUT', '/api/ops/mcp-tool', { tool: 'notices_search', value: true });
    expect(await toolNames(t, tokens.access_token)).toEqual([
      'my_requests_status',
      'navi_find_team',
      'navi_it_faq',
      'navi_onboarding',
      'notices_search',
      'rooms_find_free',
    ]);
  });

  it('도구별 스위치는 서버를 다시 켜도 남고, 동의 시트·S6 범위에도 반영돼요', async () => {
    const t = await setup();
    await t.ctx.ops.setMcpTool(OPERATOR_ID, 'rooms_find_free', false);
    await t.ctx.ops.load();
    expect(t.ctx.ops.get().mcpToolsOff).toEqual(['rooms_find_free']);
    const user = await t.loginAs(MOCK.staff);
    expect((await user.call('GET', '/api/mcp/connections')).body.tools).toEqual(['notices.read', 'navi.read', 'mine.read']);
  });

  it('레지스트리에 없는 이름이나 MCP가 아닌 도구는 받지 않고, 운영자만 바꿀 수 있어요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/mcp-tool', { tool: 'navi_find_rows', value: false })).status).toBe(400);
    expect((await op.call('PUT', '/api/ops/mcp-tool', { tool: 'drop_table', value: false })).status).toBe(400);
    const staff = await t.loginAs(MOCK.staff);
    expect((await staff.call('PUT', '/api/ops/mcp-tool', { tool: 'notices_search', value: false })).status).toBe(403);
  });
});

describe('봉인한 앱 확인 링크(B11)', () => {
  it('MCP 결과의 예약 링크를 풀어도 가명 ID·방·시각이 보이지 않아요', async () => {
    // 실제 회의실 모듈(모의 장부)이 만든 제안 토큰으로 봐요.
    const t = await setup({ realRooms: true });
    const { tokens } = await connect(t, MOCK.staff);
    const args = { date: '2026-11-03', start: '15:00', people: 4 };
    const out = (await callTool(t, tokens.access_token, 'rooms_find_free', args)).json().result.structuredContent;
    expect(out.candidates.length).toBeGreaterThan(0);
    const link: string = out.candidates[0].link;
    const token = link.split('/r/')[1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(token, 'base64url').toString('latin1');
    const pseudonym = (await t.db.query<{ pseudonym_id: string }>('select pseudonym_id from mcp_grants limit 1')).rows[0]!.pseudonym_id;
    for (const plain of [pseudonym, out.candidates[0].roomId, '2026-11-03', 'reserve']) expect(decoded).not.toContain(plain);
    console.info(`[B11] 앱 확인 링크 길이: ${link.length}자`);
  });
});
