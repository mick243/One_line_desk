import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOLS } from '../../core/tool-registry';
import { createTestApp, MOCK } from '../../testing';
import { CANARY, fakeNotices, fakeRooms } from './fixtures/fake-services';
import { BASE, callTool, connect, dumpTablesExceptAudit, mcpRequest, ROOMS_ARGS, setupMcp, type TestApp, toolNames } from './fixtures/oauth-flow';

// /mcp 자원 서버와 도구 둘 시험(ADR-14). 이름 앞 [MCP-n]은 PRD "MCP 읽기 채널" 완료 기준 n번째 줄이에요.

// 시험마다 새 PGlite를 띄우고 인가 흐름을 한 바퀴 돌아서, 파일 첫 시험(WASM 준비)이 5초를 넘을 수 있어요.
vi.setConfig({ testTimeout: 20_000 });

const opened: TestApp[] = [];
async function setup(opts: { rooms?: Parameters<typeof fakeRooms>[0] } = {}) {
  const t = await createTestApp();
  opened.push(t);
  const rooms = fakeRooms(opts.rooms);
  const notices = fakeNotices();
  t.ctx.services.rooms = rooms.service;
  t.ctx.services.notices = notices.service;
  await setupMcp(t);
  const { tokens, user } = await connect(t, MOCK.staff);
  return { t, rooms, notices, at: tokens.access_token, user };
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

type ToolListItem = { name: string; annotations?: Record<string, boolean>; inputSchema: Json; outputSchema: Json };
type Json = { properties?: Record<string, Json>; items?: Json; required?: string[]; additionalProperties?: boolean };

async function listed(t: TestApp, at: string): Promise<ToolListItem[]> {
  return (await mcpRequest(t, at, 'tools/list')).json().result.tools;
}

describe('도구 목록', () => {
  it('[MCP-1] 도구 목록 스냅샷에 쓰기 도구가 0개예요(읽기 둘뿐, 모두 readOnly)', async () => {
    const { t, at } = await setup();
    const tools = await listed(t, at);
    expect(tools.map((x) => x.name).sort()).toEqual(['notices_search', 'rooms_find_free']);
    for (const tool of tools) expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(TOOLS.filter((x) => x.mcpExposed && x.access !== 'read')).toEqual([]);
    expect(tools.map((x) => x.name).filter((n) => /book|reserve|cancel|post|write|create|delete|vote/i.test(n))).toEqual([]);
  });

  it('[MCP-2] rooms_find_free 출력 스키마에는 예약자·회의 제목·방별 일정 칸이 없어요', async () => {
    const { t, at } = await setup();
    const rooms = (await listed(t, at)).find((x) => x.name === 'rooms_find_free')!;
    const out = rooms.outputSchema;
    expect(Object.keys(out.properties!).sort()).toEqual(['alternatives', 'candidates', 'checkedAt', 'checkedAtLabel', 'mock']);
    const slot = out.properties!.candidates!.items!;
    expect(Object.keys(slot.properties!).sort()).toEqual(['date', 'end', 'floor', 'link', 'linkText', 'matched', 'roomId', 'roomName', 'start']);
    expect(slot.additionalProperties).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/booker|title|meeting|schedule|owner|attendee/i);
  });

  it('[MCP-3] notices_search 출력 스키마는 제목·게시일·원문 링크뿐이에요(본문·요약 칸 없음)', async () => {
    const { t, at } = await setup();
    const notices = (await listed(t, at)).find((x) => x.name === 'notices_search')!;
    const hit = notices.outputSchema.properties!.hits!.items!;
    expect(Object.keys(hit.properties!).sort()).toEqual(['postedOn', 'title', 'url']);
    expect(hit.additionalProperties).toBe(false);
  });

  it('[ADR-14 시험] 입력 스키마는 도구 레지스트리 칸과 같고 모르는 칸을 받지 않아요', async () => {
    const { t, at } = await setup();
    for (const tool of await listed(t, at)) {
      const def = TOOLS.find((x) => x.name === tool.name)!;
      expect(Object.keys(tool.inputSchema.properties!).sort(), tool.name).toEqual(Object.keys(def.input).sort());
      const required = Object.entries(def.input)
        .filter(([, f]) => !f.optional)
        .map(([k]) => k)
        .sort();
      expect([...(tool.inputSchema.required ?? [])].sort(), tool.name).toEqual(required);
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });
});

describe('rooms_find_free', () => {
  it('[MCP-2] 예약자 이름·회의 제목을 넣은 시험 장부로 불러도 응답에 그 값이 0건이에요', async () => {
    const { t, at } = await setup();
    const res = await callTool(t, at, 'rooms_find_free', ROOMS_ARGS);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(CANARY.booker);
    expect(res.body).not.toContain(CANARY.meetingTitle);
    expect(res.body).not.toMatch(/schedule|bookerName|meetingTitle/);
    const out = res.json().result.structuredContent;
    expect(out.candidates).toHaveLength(3);
    expect(out.candidates[0]).toEqual({
      roomId: 'room-1',
      roomName: '가상 회의실 1',
      floor: '3층',
      date: '2026-10-27',
      start: '15:00',
      end: '16:00',
      matched: ['인원 6명 이상', '화면'],
      link: `${BASE}/r/fakeProposal1.sig`,
      linkText: '한 줄 데스크에서 예약하기',
    });
    expect(out).toMatchObject({ checkedAtLabel: '09:00', mock: true, alternatives: [] });
  });

  it('[MCP 요구 2] 앱 확인 링크는 토큰 주인의 가명 ID로 서명한 제안 토큰이고, 조건은 운영 설정 기본 길이로 채워요', async () => {
    const { t, at, rooms, user } = await setup();
    await callTool(t, at, 'rooms_find_free', ROOMS_ARGS);
    expect(rooms.calls.findFree).toEqual([{ date: '2026-10-27', start: '15:00', minutes: 60, people: 6, equipment: ['화면'] }]);
    const owner = (await t.db.query<{ pseudonym_id: string }>('select pseudonym_id from mcp_grants')).rows[0]!.pseudonym_id;
    expect(rooms.calls.propose.map((c) => c.pseudonymId)).toEqual([owner, owner, owner]);
    expect(user.me.displayName).toBe('가상 직원 하늘');
  });

  it('[MCP 요구 2] 빈 방이 없으면 대안을 최대 2개 주고, 감사 로그 결과는 "없음"이에요', async () => {
    const { t, at } = await setup({ rooms: { empty: true } });
    const out = (await callTool(t, at, 'rooms_find_free', ROOMS_ARGS)).json().result.structuredContent;
    expect(out.candidates).toEqual([]);
    expect(out.alternatives.map((a: { roomId: string }) => a.roomId)).toEqual(['room-5', 'room-6']);
    const audit = (await t.db.query("select result from audit_log where channel = 'mcp' and tool = 'rooms_find_free'")).rows;
    expect(audit).toEqual([{ result: 'none' }]);
  });

  it('[MCP 요구 2] 회의실 쓰기가 꺼져 있으면 링크가 "그룹웨어에서 예약하기"이고 제안 토큰을 만들지 않아요', async () => {
    const { t, at, rooms } = await setup();
    await t.ctx.ops.setFlag('p_op', 'roomsWrite', false);
    const out = (await callTool(t, at, 'rooms_find_free', ROOMS_ARGS)).json().result.structuredContent;
    expect(out.candidates[0]).toMatchObject({ link: t.ctx.ops.get().links.rooms, linkText: '그룹웨어에서 예약하기' });
    expect(rooms.calls.propose).toEqual([]);
  });

  it('[ADR-14 시험] 정해진 목록 밖 장비·모르는 칸·잘못된 날짜는 거부하고 서비스를 부르지 않아요', async () => {
    const { t, at, rooms } = await setup();
    const bad = [
      { ...ROOMS_ARGS, equipment: ['빔프로젝터'] },
      { ...ROOMS_ARGS, note: '아무 말' },
      { ...ROOMS_ARGS, date: '2026-02-31' },
      { ...ROOMS_ARGS, start: '25:00' },
      { ...ROOMS_ARGS, people: 0 },
      { ...ROOMS_ARGS, floor: '옥상 아무 데나' },
    ];
    for (const args of bad) {
      const res = await callTool(t, at, 'rooms_find_free', args);
      expect(res.json().result?.isError ?? res.json().error, JSON.stringify(args)).toBeTruthy();
    }
    expect(rooms.calls.findFree).toEqual([]);
    const audit = (await t.db.query("select result from audit_log where channel = 'mcp' and tool = 'rooms_find_free'")).rows;
    expect(audit).toHaveLength(bad.length);
    expect(audit.every((r) => (r as { result: string }).result === 'refused')).toBe(true);
  });
});

describe('notices_search', () => {
  it('[MCP-3] 본문에 카나리를 넣은 시험 공지로 불러도 응답에 본문·요약이 0건이에요', async () => {
    const { t, at } = await setup();
    const res = await callTool(t, at, 'notices_search', { query: '연말정산' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(CANARY.noticeBody);
    expect(res.body).not.toContain(CANARY.noticeSummary);
    const out = res.json().result.structuredContent;
    for (const hit of out.hits) expect(Object.keys(hit).sort()).toEqual(['postedOn', 'title', 'url']);
  });

  it('[ADR-14 시험] 제목은 제어 문자를 지우고 길이를 자르며, http(s)가 아닌 링크는 버려요', async () => {
    const { t, at, notices } = await setup();
    const out = (await callTool(t, at, 'notices_search', { query: '연말정산' })).json().result.structuredContent;
    expect(out.hits[0]).toEqual({ title: '연말정산 안내 (가상)', postedOn: '2026-10-20', url: 'https://groupware.example.com/board/1' });
    expect(out.hits[1].title).toHaveLength(120);
    expect(out.hits[1].postedOn).toBe('');
    expect(out.hits).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain('javascript:');
    expect(notices.calls).toEqual([{ query: '연말정산', limit: 5 }]);
  });

  it('[ADR-14 시험] 검색어는 100자까지만 받아요', async () => {
    const { t, at, notices } = await setup();
    const res = await callTool(t, at, 'notices_search', { query: '가'.repeat(101) });
    expect(res.json().result.isError).toBe(true);
    expect(notices.calls).toEqual([]);
  });
});

describe('MCP 경로의 경계', () => {
  it('[MCP-1] MCP 호출 중 게이트웨이 LLM 호출이 0건이에요(ai_usage 0행)', async () => {
    const { t, at } = await setup();
    const spy = vi.spyOn(t.ctx.gateway, 'structured');
    await mcpRequest(t, at, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: '시험', version: '1' } });
    await callTool(t, at, 'rooms_find_free', ROOMS_ARGS);
    await callTool(t, at, 'notices_search', { query: '연말정산' });
    expect(spy).not.toHaveBeenCalled();
    expect((await t.db.query('select count(*)::int as n from ai_usage')).rows[0]).toEqual({ n: 0 });
  });

  it('[MCP-6] MCP 경로는 감사 로그 말고 DB에 쓰지 않아요', async () => {
    const { t, at } = await setup();
    const before = await dumpTablesExceptAudit(t.db);
    const auditBefore = (await t.db.query<{ n: number }>('select count(*)::int as n from audit_log')).rows[0]!.n;
    await mcpRequest(t, at, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: '시험', version: '1' } });
    await mcpRequest(t, at, 'tools/list');
    await callTool(t, at, 'rooms_find_free', ROOMS_ARGS);
    await callTool(t, at, 'notices_search', { query: '연말정산' });
    expect(await dumpTablesExceptAudit(t.db)).toBe(before);
    const added = (await t.db.query('select channel, tool, client_id, result from audit_log order by id offset $1', [auditBefore])).rows;
    expect(added).toEqual([
      { channel: 'mcp', tool: 'rooms_find_free', client_id: 'desk-demo-claude-org', result: 'found' },
      { channel: 'mcp', tool: 'notices_search', client_id: 'desk-demo-claude-org', result: 'found' },
    ]);
  });

  it('[MCP-6] MCP 감사 로그에 검색어·조건 카나리가 0건이에요', async () => {
    const { t, at } = await setup();
    const canaryQuery = '검색어카나리QX8';
    await callTool(t, at, 'notices_search', { query: canaryQuery });
    await callTool(t, at, 'rooms_find_free', { date: '2026-11-03', start: '07:13', minutes: 47, people: 37, floor: '9층' });
    const { rows } = await t.db.query('select * from audit_log');
    const text = JSON.stringify(rows);
    for (const needle of [canaryQuery, '2026-11-03', '07:13', '"47"', '"37"', '9층']) expect(text, needle).not.toContain(needle);
    const all = await dumpTablesExceptAudit(t.db);
    expect(all).not.toContain(canaryQuery);
  });

  it('[MCP-7] MCP 스위치를 끄면 연결이 거부돼요', async () => {
    const { t, at } = await setup();
    await t.ctx.ops.setFlag('p_op', 'mcp', false);
    const res = await mcpRequest(t, at, 'tools/list');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'mcp-off', message: '지금 연결할 수 있는 도구가 없어요' });
  });

  it('[MCP-7] rooms·notices를 링크만·끔으로 하면 그 도구가 목록에서 빠지고 부를 수 없어요', async () => {
    const { t, at, rooms } = await setup();
    await t.ctx.ops.setModule('p_op', 'rooms', 'link');
    expect(await toolNames(t, at)).toEqual(['notices_search']);
    const res = await callTool(t, at, 'rooms_find_free', ROOMS_ARGS);
    expect(res.json().result?.isError ?? res.json().error).toBeTruthy();
    expect(rooms.calls.findFree).toEqual([]);
    await t.ctx.ops.setModule('p_op', 'rooms', 'off');
    await t.ctx.ops.setModule('p_op', 'notices', 'link');
    expect(await toolNames(t, at)).toEqual([]);
    await t.ctx.ops.setModule('p_op', 'notices', 'on');
    expect(await toolNames(t, at)).toEqual(['notices_search']);
  });

  it('[ADR-15 시험] 범위가 모자란 도구를 부르면 403 insufficient_scope예요', async () => {
    const { t } = await setup();
    const { tokens } = await connect(t, MOCK.dev, { scope: 'rooms.read' });
    expect(tokens.scope).toBe('rooms.read');
    const res = await callTool(t, tokens.access_token, 'notices_search', { query: '연말정산' });
    expect(res.statusCode).toBe(403);
    expect(res.headers['www-authenticate']).toContain('error="insufficient_scope"');
    expect(res.headers['www-authenticate']).toContain('notices.read');
    expect((await callTool(t, tokens.access_token, 'rooms_find_free', ROOMS_ARGS)).statusCode).toBe(200);
  });

  it('[ADR-13 시험] 가명 ID × 도구 요청 횟수가 상한을 넘으면 429예요', async () => {
    const { t, at } = await setup();
    const limit = t.ctx.ops.get().values.rateLimitPerMinute;
    for (let i = 0; i < limit; i += 1) expect((await callTool(t, at, 'notices_search', { query: '공지' })).statusCode).toBe(200);
    const res = await callTool(t, at, 'notices_search', { query: '공지' });
    expect(res.statusCode).toBe(429);
    expect((await callTool(t, at, 'rooms_find_free', ROOMS_ARGS)).statusCode).toBe(200);
  });

  it('[ADR-14 시험] 다른 출처의 브라우저 요청과 GET·DELETE는 받지 않아요', async () => {
    const { t, at } = await setup();
    expect((await mcpRequest(t, at, 'tools/list', {}, { origin: 'https://evil.example.com' })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(405);
    expect((await t.app.inject({ method: 'DELETE', url: '/mcp' })).statusCode).toBe(405);
  });
});
