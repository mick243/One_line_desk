import { afterEach, describe, expect, it, vi } from 'vitest';
import { pseudonymize } from '../../core/pseudonym';
import type { NaviMcpRead } from '../../core/services';
import { createTestApp, MOCK } from '../../testing';
import { fakeNotices, fakeRooms } from './fixtures/fake-services';
import { BASE, callTool, connect, dumpTablesExceptAudit, mcpRequest, setupMcp, type TestApp, toolNames } from './fixtures/oauth-flow';

// 2단계 읽기 도구(11/3, ADR-14 개정): 받을 팀 찾기·IT 오류 FAQ·첫 2주 할 일·내 요청 상태.
// 모두 읽기만 하고, 쓰기는 앱 확인 링크를 사람이 열어 앱에서 한 번 눌러요. 질문 글은 어디에도 남지 않아요.

vi.setConfig({ testTimeout: 30_000 });

const ROW_ID = /\b[A-Z]{2,5}-\d{2,3}\b/;
const NEW_TOOLS = ['my_requests_status', 'navi_find_team', 'navi_it_faq', 'navi_onboarding'];

const opened: TestApp[] = [];
async function setup() {
  const t = await createTestApp();
  opened.push(t);
  t.ctx.services.rooms = fakeRooms().service;
  t.ctx.services.notices = fakeNotices().service;
  // 가상 분장표·IT FAQ(등급 0)를 넣어요. 분장표에는 가상 담당자 이름 칸이 있어서 이름이 새지 않는지 같이 봐요.
  await t.modules.find((m) => m.kind === 'navi')!.seed!();
  await setupMcp(t);
  return t;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

type Json = { properties?: Record<string, Json>; items?: Json; additionalProperties?: boolean };

/** 출력 스키마의 모든 칸 이름(중첩 포함) */
function fieldNames(schema: Json, out: string[] = []): string[] {
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    out.push(key);
    fieldNames(child, out);
    if (child.items) fieldNames(child.items, out);
  }
  return out;
}

const structured = async (t: TestApp, at: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await callTool(t, at, name, args);
  expect(res.statusCode, name).toBe(200);
  return { body: res.body, out: res.json().result.structuredContent, result: res.json().result };
};

const tokenOf = (link: string) => link.slice(`${BASE}/r/`.length);

async function allTables(t: TestApp): Promise<string> {
  const { rows } = await t.db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  const out: Record<string, unknown[]> = {};
  for (const { table_name } of rows) out[table_name] = (await t.db.query(`select * from ${table_name}`)).rows;
  return JSON.stringify(out);
}

describe('도구 목록과 출력 스키마', () => {
  it('[ADR-14 개정] 새 도구 넷이 읽기 전용으로 나오고 쓰기 도구는 여전히 0개예요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const tools = (await mcpRequest(t, tokens.access_token, 'tools/list')).json().result.tools as { name: string; annotations: Record<string, boolean> }[];
    for (const name of NEW_TOOLS) {
      const tool = tools.find((x) => x.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(tools.map((x) => x.name).filter((n) => /book|reserve|cancel|post|write|create|delete|send|submit|apply|vote/i.test(n))).toEqual([]);
  });

  it('[ADR-14 개정] 출력 스키마에 사람 이름·행 ID·주인 부서·글 칸이 없고 모르는 칸을 받지 않아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const tools = (await mcpRequest(t, tokens.access_token, 'tools/list')).json().result.tools as { name: string; outputSchema: Json }[];
    for (const name of NEW_TOOLS) {
      const schema = tools.find((x) => x.name === name)!.outputSchema;
      expect(schema.additionalProperties, name).toBe(false);
      const fields = fieldNames(schema);
      expect(
        fields.filter((f) =>
          /^(id|rowId|row|owner|ownerDepartment|department|name|person|assignee|sender|author|question|reason|body|text|reply|replies|days|balance|remaining|attendees?)$/i.test(
            f,
          ),
        ),
        name,
      ).toEqual([]);
    }
  });
});

describe('navi_find_team 받을 팀 찾기', () => {
  it('[ADR-14 개정] 분장표 규칙 순위로 팀·창구·할 일을 주고, 행 ID·담당자 이름은 없어요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const spy = vi.spyOn(t.ctx.gateway, 'structured');
    const { body, out } = await structured(t, tokens.access_token, 'navi_find_team', { query: '법인카드를 잃어버렸어요' });
    expect(out.mock).toBe(true);
    expect(out.candidates[0]).toMatchObject({
      task: '법인카드 분실 신고',
      team: '재무팀',
      match: 'strong',
      processingPeriod: '재발급 7영업일',
      revisedOn: '2026-09-01',
    });
    expect(out.candidates[0].linkText).toBe('한 줄 데스크에서 재무팀에 문의하기');
    expect(out.candidates.length).toBeLessThanOrEqual(3);
    expect(out.confirm).toContain('확정은 앱에서 한 번');
    expect(body).not.toMatch(ROW_ID);
    expect(body).not.toContain('가상 담당');
    // 경로는 LLM을 부르지 않아요.
    expect(spy).not.toHaveBeenCalled();
  });

  it('[ADR-14 개정] 맞는 업무가 없으면 까닭과 대표 창구 문의 링크를 줘요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const { out, body } = await structured(t, tokens.access_token, 'navi_find_team', { query: '우주선 발사 허가' });
    expect(out.candidates).toEqual([]);
    expect(out.emptyReason.code).toBe('no-match');
    expect(out.general).toMatchObject({ team: '총무팀', linkText: '한 줄 데스크에서 총무팀에 문의하기' });
    expect(out.general.link.startsWith(`${BASE}/r/`)).toBe(true);
    expect(body).not.toMatch(ROW_ID);
    const audit = (await t.db.query("select result from audit_log where tool = 'navi_find_team'")).rows;
    expect(audit).toEqual([{ result: 'none' }]);
  });

  it('[ADR-14 개정·R13] 문의 링크 토큰에는 받을 행만 있고 질문 글은 없어요. 열기만 하면 문의 0건이고 남의 링크는 안 열려요', async () => {
    const t = await setup();
    const { tokens, user } = await connect(t, MOCK.staff);
    const canary = '링크카나리Q7Z 법인카드를 잃어버렸어요';
    const { out } = await structured(t, tokens.access_token, 'navi_find_team', { query: canary });
    const token = tokenOf(out.candidates[0].link);
    // 토큰은 봉인돼서 풀어 봐도 질문 글·행 ID가 보이지 않아요.
    expect(Buffer.from(token, 'base64url').toString('latin1')).not.toContain('FIN-01');
    const peeked = t.ctx.plans.peek({ pseudonymId: pseudonymize(t.ctx.config.pseudonymSecret, MOCK.staff) } as never, token);
    expect(peeked).toMatchObject({ module: 'navi', action: 'inquire', params: { rowId: 'FIN-01' }, expired: false });
    expect(Object.keys(peeked.params as object)).toEqual(['rowId']);

    const opened = await user.call('POST', '/api/mcp/link', { proposalToken: token });
    expect(opened).toMatchObject({ status: 200, body: { kind: 'inquiry', rowId: 'FIN-01', team: '재무팀', task: '법인카드 분실 신고' } });
    expect(JSON.stringify(opened.body)).not.toContain('링크카나리Q7Z');
    expect((await t.db.query('select count(*)::int as n from navi_inquiries')).rows[0]).toEqual({ n: 0 });
    expect((await t.db.query('select count(*)::int as n from plans')).rows[0]).toEqual({ n: 0 });

    // 링크로는 plan을 만들거나 바로 실행할 수 없어요. 보내기는 양식의 확인 시트 [보내기]뿐이에요.
    expect((await user.call('POST', '/api/plans', { proposalToken: token })).status).toBe(409);
    expect((await user.call('POST', '/api/plans/direct', { proposalToken: token })).status).toBe(400);
    expect((await t.db.query('select count(*)::int as n from navi_inquiries')).rows[0]).toEqual({ n: 0 });

    const other = await t.loginAs(MOCK.dev);
    expect((await other.call('POST', '/api/mcp/link', { proposalToken: token })).body).toMatchObject({ error: 'not-owner' });
  });

  it('[ADR-14 개정] 문의 링크는 시간이 지나면 열지 않고, 담당 찾기가 꺼지면 꺼졌다고 알려요', async () => {
    const t = await setup();
    const { tokens, user } = await connect(t, MOCK.staff);
    const { out } = await structured(t, tokens.access_token, 'navi_find_team', { query: '법인카드를 잃어버렸어요' });
    const token = tokenOf(out.candidates[0].link);
    await t.ctx.ops.setModule('p_op', 'navi', 'link');
    // 링크만이면 양식은 열려요(끔일 때만 막혀요). 시간이 지나면 열지 않아요.
    expect((await user.call('POST', '/api/mcp/link', { proposalToken: token })).body.kind).toBe('inquiry');
    t.advance((t.ctx.ops.get().values.proposalTtlSeconds + 1) * 1000);
    const again = await t.loginAs(MOCK.staff);
    expect((await again.call('POST', '/api/mcp/link', { proposalToken: token })).body).toEqual({ kind: 'expired' });
  });

  it('[ADR-10·R13 카나리] 질문 글은 DB·감사 로그·접속기록 어디에도 남지 않아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const canary = '질문카나리K3P 법인카드 분실';
    const faqCanary = '오류카나리M9W 0x80070005 액세스가 거부되었습니다';
    await structured(t, tokens.access_token, 'navi_find_team', { query: canary });
    await structured(t, tokens.access_token, 'navi_it_faq', { text: faqCanary });
    const everything = await allTables(t);
    expect(everything).not.toContain('질문카나리K3P');
    expect(everything).not.toContain('오류카나리M9W');
    // 감사 로그에는 도구 이름·클라이언트·결과만, 접속기록에는 mcp.call만 남아요.
    const audit = (await t.db.query("select tool, result from audit_log where channel = 'mcp' and tool is not null order by id")).rows;
    expect(audit).toEqual([
      { tool: 'navi_find_team', result: 'found' },
      { tool: 'navi_it_faq', result: 'found' },
    ]);
    const access = (await t.db.query<{ action: string; subject_refs: string[] }>("select action, subject_refs from access_log where action = 'mcp.call'")).rows;
    expect(access).toEqual([
      { action: 'mcp.call', subject_refs: [] },
      { action: 'mcp.call', subject_refs: [] },
    ]);
  });

  it('[ADR-11] 공통 입력 검사에 걸리는 글(주민번호 등)은 찾지 않고 거절해요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const { result } = await structured(t, tokens.access_token, 'navi_find_team', { query: '법인카드 분실 900101-1234567' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('900101-1234567');
    expect((await t.db.query("select result from audit_log where tool = 'navi_find_team'")).rows).toEqual([{ result: 'refused' }]);
    expect(await allTables(t)).not.toContain('1234567');
  });

  it('[MCP 요구 4] 분장표가 실제 자료면 보안팀 승인 없는 앱에는 보내지 않아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const read = t.ctx.services.navi!.mcp!;
    const realChart: NaviMcpRead['findTeam'] = async (text) => ({ ...(await read.findTeam(text)), mock: false });
    t.ctx.services.navi!.mcp = { ...read, findTeam: realChart };
    const { result } = await structured(t, tokens.access_token, 'navi_find_team', { query: '법인카드를 잃어버렸어요' });
    expect(result).toMatchObject({ isError: true, content: [{ text: '회사가 허락하지 않은 앱이라 실제 사내 자료는 보낼 수 없어요' }] });
    expect(JSON.stringify(result)).not.toContain('재무팀');
  });
});

describe('navi_it_faq·navi_onboarding', () => {
  it('[ADR-25] IT 오류 글로 FAQ 원문 단계를 그대로 주고, 사용자 폴더 같은 값은 돌려주지 않아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const { out, body } = await structured(t, tokens.access_token, 'navi_it_faq', {
      text: 'Windows 업데이트 오류 0x80070005 액세스가 거부되었습니다 C:\\Users\\gildong\\AppData\\Local\\Temp\\setup.log',
    });
    expect(out.faq.title).toBe("윈도 업데이트·설치 중 '액세스가 거부되었습니다'");
    expect(out.faq.steps[0]).toBe('작업 중인 파일을 저장하고 PC를 다시 시작해 주세요.');
    expect(out.inquiry).toMatchObject({ team: 'IT지원팀' });
    expect(out.inquiry.link.startsWith(`${BASE}/r/`)).toBe(true);
    expect(body).not.toContain('gildong');
    expect(body).not.toMatch(ROW_ID);
    expect(body).not.toContain('ITF-01');
  });

  it('[ADR-25] 첫 2주 할 일은 주차별 목록이고 행 ID·담당자 이름은 없어요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const { out, body } = await structured(t, tokens.access_token, 'navi_onboarding');
    expect(out.weeks.map((w: { week: number }) => w.week)).toEqual([1, 2]);
    expect(out.weeks[0].items.length).toBeGreaterThan(0);
    expect(out.appLink).toBe(`${BASE}/`);
    expect(body).not.toMatch(ROW_ID);
    expect(body).not.toContain('가상 담당');
  });
});

describe('my_requests_status 내 요청 상태', () => {
  it('[ADR-14 개정] 본인 문의의 업무·팀·상태·답장 있음만 주고, 글·답한 사람·남의 요청은 없어요', async () => {
    const t = await setup();
    const staff = await connect(t, MOCK.staff);
    const sent = await staff.user.call('POST', '/api/navi/inquiries', {
      rowId: 'HR-01',
      question: '문의글카나리R2D 직인본이 필요해요',
      reason: '사유카나리S5T 은행 제출용이에요',
      requestId: 'req-mine-0001',
    });
    expect(sent.status).toBe(200);
    const hr = await t.loginAs(MOCK.hr);
    const inbox = (await hr.call('GET', '/api/navi/inquiries/inbox')).body;
    const id = inbox.items[0].id as string;
    expect((await hr.call('POST', `/api/navi/inquiries/${id}/reply`, { text: '답장카나리U8V 내일 드려요', requestId: 'reply-0001' })).status).toBe(200);

    const { out, body } = await structured(t, staff.tokens.access_token, 'my_requests_status');
    expect(Object.keys(out.requests[0])).not.toContain('id');
    expect(out.requests).toEqual([{ kind: '문의', task: '재직증명서 발급', team: '인사팀', state: '새 문의', sentOn: '2026-10-26', hasReply: true }]);
    for (const needle of ['문의글카나리R2D', '사유카나리S5T', '답장카나리U8V', '가상 인사 지후', 'HR-01']) expect(body, needle).not.toContain(needle);

    const other = await connect(t, MOCK.dev);
    const theirs = await structured(t, other.tokens.access_token, 'my_requests_status');
    expect(theirs.out.requests).toEqual([]);
    expect(theirs.out.reservations).toEqual([]);
    expect(theirs.result.structuredContent).toBeDefined();
  });

  it('[ADR-17] 내 예약은 방·시간만 주고 참석자 이름은 내보내지 않아요', async () => {
    const t = await setup();
    const rooms = t.ctx.services.rooms!;
    const asked: string[] = [];
    t.ctx.services.rooms = {
      ...rooms,
      myReservations: async (user) => {
        asked.push(user.pseudonymId);
        return {
          enabled: true,
          items: [
            {
              id: 'res-1',
              roomName: '가상 회의실 1',
              floor: '3층',
              start: '2026-10-27T15:00:00+09:00',
              end: '2026-10-27T16:00:00+09:00',
              when: '10월 27일(화) 15:00~16:00',
              cancel: { type: 'navigate', text: '취소', to: 'rooms' },
              invite: { type: 'navigate', text: '초대', to: 'rooms' },
              attendees: [{ name: '참석자카나리W1X', department: '개발팀', status: 'invited' }],
              icsPath: '/api/rooms/reservations/res-1/ics',
              loans: [],
            },
          ],
        } as never;
      },
    };
    const { tokens } = await connect(t, MOCK.staff);
    const { out, body } = await structured(t, tokens.access_token, 'my_requests_status');
    expect(out.reservations).toEqual([{ roomName: '가상 회의실 1', floor: '3층', when: '10월 27일(화) 15:00~16:00' }]);
    expect(body).not.toContain('참석자카나리W1X');
    expect(body).not.toContain('res-1');
    const owner = (await t.db.query<{ pseudonym_id: string }>('select pseudonym_id from mcp_grants')).rows[0]!.pseudonym_id;
    expect(asked).toEqual([owner]);
  });
});

describe('범위·스위치', () => {
  it('[ADR-15 시험] 새 범위가 없는 연결로 부르면 403 insufficient_scope이고 그 범위를 알려 줘요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.dev, { scope: 'rooms.read notices.read' });
    const team = await callTool(t, tokens.access_token, 'navi_find_team', { query: '법인카드' });
    expect(team.statusCode).toBe(403);
    expect(team.headers['www-authenticate']).toContain('error="insufficient_scope"');
    expect(team.headers['www-authenticate']).toContain('navi.read');
    const mine = await callTool(t, tokens.access_token, 'my_requests_status', {});
    expect(mine.statusCode).toBe(403);
    expect(mine.headers['www-authenticate']).toContain('mine.read');
    expect((await t.db.query("select result from audit_log where tool in ('navi_find_team', 'my_requests_status')")).rows).toEqual([
      { result: 'refused' },
      { result: 'refused' },
    ]);
  });

  it('[MCP-7] 담당 찾기 모듈이 켬이 아니면 navi 도구가 빠지고, 도구별 스위치로 하나만 끌 수도 있어요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    await t.ctx.ops.setMcpTool('p_op', 'navi_find_team', false);
    expect(await toolNames(t, tokens.access_token)).toEqual([
      'leave_prepare',
      'my_requests_status',
      'navi_it_faq',
      'navi_onboarding',
      'notices_search',
      'pantry_find_similar',
      'rooms_find_equipment',
      'rooms_find_free',
    ]);
    const off = await callTool(t, tokens.access_token, 'navi_find_team', { query: '법인카드' });
    expect(off.json().result?.isError ?? off.json().error).toBeTruthy();
    await t.ctx.ops.setModule('p_op', 'navi', 'link');
    expect(await toolNames(t, tokens.access_token)).toEqual(['notices_search', 'pantry_find_similar', 'rooms_find_equipment', 'rooms_find_free']);
  });

  it('[MCP-6] 새 도구도 감사 로그·접속기록 말고 DB에 쓰지 않아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const before = await dumpTablesExceptAudit(t.db);
    await structured(t, tokens.access_token, 'navi_find_team', { query: '법인카드를 잃어버렸어요' });
    await structured(t, tokens.access_token, 'navi_it_faq', { text: '0x80070005' });
    await structured(t, tokens.access_token, 'navi_onboarding');
    await structured(t, tokens.access_token, 'my_requests_status');
    expect(await dumpTablesExceptAudit(t.db)).toBe(before);
  });
});

describe('서버 안내문', () => {
  it('[ADR-14 개정] 안내문은 새 도구를 알리고 "담당 부서 질문은 답할 수 없어요"라고 하지 않아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const init = await mcpRequest(t, tokens.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const text: string = init.json().result.instructions;
    expect(text).toContain('업무 분장표의 받을 팀');
    expect(text).toContain('앱에서 한 번 눌러 확정');
    expect(text).not.toContain('이 MCP로 답할 수 없어요');
    expect(text).not.toMatch(/ADR-\d|\b[RDMF]\d{1,2}\b/);
  });
});
