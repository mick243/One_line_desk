import { afterEach, describe, expect, it, vi } from 'vitest';
import { pseudonymize } from '../../core/pseudonym';
import { TOOLS } from '../../core/tool-registry';
import { createTestApp, MOCK } from '../../testing';
import { BASE, callTool, connect, dumpTablesExceptAudit, mcpRequest, refresh, setupMcp, type TestApp, toolNames } from './fixtures/oauth-flow';

// 확인 링크 넓히기(11/3, ADR-14 개정): 휴가 신청 준비·탕비실 요청 찾기·장비 대여 확인.
// MCP 도구는 모두 읽기만 하고 앱 확인 링크만 줘요. 링크를 연 것만으로는 아무것도 쓰지 않고, 앱의 확인 시트·고정 버튼이 유일한 확인이에요.
// 링크 토큰에는 구조 값만 있어요(날짜·종류·카드 ID·장비 종류·시각). 사람이 쓴 글(사유·품목 이름)은 없어요.

vi.setConfig({ testTimeout: 30_000 });

const LINK_TOOLS = ['leave_prepare', 'pantry_find_similar', 'rooms_find_equipment'];

const opened: TestApp[] = [];
async function setup() {
  const t = await createTestApp();
  opened.push(t);
  // 가상 분장표·탕비실 판·회의실 장비(등급 0)를 넣어요. 판의 표는 가상 가명 ID(p_demo_…)가 줬어요.
  for (const kind of ['navi', 'pantry', 'rooms'] as const) await t.modules.find((m) => m.kind === kind)!.seed!();
  await setupMcp(t);
  return t;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const structured = async (t: TestApp, at: string, name: string, args: Record<string, unknown>) => {
  const res = await callTool(t, at, name, args);
  expect(res.statusCode, name).toBe(200);
  return { body: res.body, out: res.json().result.structuredContent, result: res.json().result };
};

const tokenOf = (link: string) => {
  expect(link.startsWith(`${BASE}/r/`)).toBe(true);
  return link.slice(`${BASE}/r/`.length);
};
/** 봉인을 풀지 않고 그냥 base64로 읽어 본 글(봉인이 아니면 값이 보여요) */
const decoded = (token: string) => Buffer.from(token, 'base64url').toString('utf8') + Buffer.from(token, 'base64url').toString('latin1');
const peekAs = (t: TestApp, subject: string, token: string) =>
  t.ctx.plans.peek({ pseudonymId: pseudonymize(t.ctx.config.pseudonymSecret, subject) } as never, token);

const count = async (t: TestApp, table: string) => (await t.db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;

async function allTables(t: TestApp): Promise<string> {
  const { rows } = await t.db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  const out: Record<string, unknown[]> = {};
  for (const { table_name } of rows) out[table_name] = (await t.db.query(`select * from ${table_name}`)).rows;
  return JSON.stringify(out);
}

type Json = { properties?: Record<string, Json>; items?: Json; additionalProperties?: boolean };
function fieldNames(schema: Json, out: string[] = []): string[] {
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    out.push(key);
    fieldNames(child, out);
    if (child.items) fieldNames(child.items, out);
  }
  return out;
}

describe('도구 목록과 출력 스키마', () => {
  it('[ADR-14 개정·MCP-1] 새 도구 셋도 읽기 전용이고, 쓰기 도구는 여전히 0개예요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const tools = (await mcpRequest(t, tokens.access_token, 'tools/list')).json().result.tools as {
      name: string;
      annotations: Record<string, boolean>;
      outputSchema: Json;
    }[];
    for (const name of LINK_TOOLS) {
      const tool = tools.find((x) => x.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool!.outputSchema.additionalProperties, name).toBe(false);
      // 남은 연차·병가 쓴 날·투표자·빌린 사람·사유 칸은 스키마에 없어요.
      expect(
        fieldNames(tool!.outputSchema).filter((f) =>
          /^(remaining|balance|used|sick|limit|reason|reasonText|voters?|author|borrower|holder|pseudonymId|person|owner|department|attendees?|home|itemName)$/i.test(
            f,
          ),
        ),
        name,
      ).toEqual([]);
    }
    expect(TOOLS.every((x) => x.access === 'read')).toBe(true);
    expect(tools.map((x) => x.name).filter((n) => /book|reserve|cancel|post|write|create|delete|send|submit|apply|vote|rent/i.test(n))).toEqual([]);
  });

  it('[ADR-14 시험] 도구 설명에 내부 문서 번호가 없어요', () => {
    for (const name of LINK_TOOLS) {
      const tool = TOOLS.find((x) => x.name === name)!;
      expect(tool.description, name).not.toMatch(/ADR-\d|\b[RDMF]\d{1,2}\b/);
      expect(tool.mcp?.withheld.length, name).toBeGreaterThan(0);
    }
  });
});

describe('leave_prepare 휴가 신청 준비', () => {
  it('[ADR-18] 날짜·종류만 확인해 링크를 주고, 연차 자료를 읽지 않아서 남은 연차 숫자가 나갈 길이 없어요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const leaveOf = vi.spyOn(t.ctx.adapters.leave, 'leaveOf');
    const spy = vi.spyOn(t.ctx.gateway, 'structured');
    const { out, body } = await structured(t, tokens.access_token, 'leave_prepare', {
      days: [
        { date: '2026-11-02', kind: 'am' },
        { date: '2026-10-30', kind: 'full' },
      ],
      type: 'annual',
    });
    expect(out.days).toEqual([
      { date: '2026-10-30', kind: 'full', label: '10월 30일(금) 하루' },
      { date: '2026-11-02', kind: 'am', label: '11월 2일(월) 오전 반차' },
    ]);
    expect(out).toMatchObject({ type: 'annual', typeLabel: '연차', linkText: '한 줄 데스크에서 연차 신청 열기' });
    expect(out.confirm).toContain('확정은 앱에서 한 번');
    tokenOf(out.link);
    expect(leaveOf).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(body).not.toMatch(/remaining|남은 연차 \d|\d+(\.\d)?일 남/);
    expect((await t.db.query("select result from audit_log where tool = 'leave_prepare'")).rows).toEqual([{ result: 'found' }]);
  });

  it('[ADR-24] 주말·지난 날·1년 넘은 날·두 번 고른 날은 링크 없이 까닭을 주고, 병가는 지난 3일까지 받아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const reasonOf = async (days: { date: string; kind: string }[], type = 'annual') => {
      const { out } = await structured(t, tokens.access_token, 'leave_prepare', { days, type });
      expect(out.link).toBeUndefined();
      return out.emptyReason;
    };
    expect(await reasonOf([{ date: '2026-10-31', kind: 'full' }])).toEqual({ code: 'weekend', message: '10월 31일(토)은 주말이에요' });
    expect((await reasonOf([{ date: '2026-10-23', kind: 'full' }])).code).toBe('past');
    expect((await reasonOf([{ date: '2027-11-01', kind: 'full' }])).code).toBe('too-far');
    expect(
      (
        await reasonOf([
          { date: '2026-10-28', kind: 'full' },
          { date: '2026-10-28', kind: 'pm' },
        ])
      ).code,
    ).toBe('duplicate');
    // 병가는 지난 3일(10/23 금)까지 받아요.
    const sick = await structured(t, tokens.access_token, 'leave_prepare', { days: [{ date: '2026-10-23', kind: 'full' }], type: 'sick' });
    expect(sick.out).toMatchObject({ type: 'sick', typeLabel: '병가' });
    expect(sick.out.confirm).toContain('병가 사유는 사람이 앱 양식에서 직접 골라요');
    // 형식이 틀린 날짜는 입력 검사에서 막혀요(값은 어디에도 남지 않아요).
    const bad = await callTool(t, tokens.access_token, 'leave_prepare', { days: [{ date: '2026-02-30', kind: 'full' }], type: 'annual' });
    expect(bad.json().result?.isError ?? bad.json().error).toBeTruthy();
  });

  it('[반차-MCP] 반차는 오전(am)·오후(pm)로만 받고 구분 없는 반차(half)는 입력에서 막아요. 링크로 연 양식에 오전·오후가 그대로 채워져요', async () => {
    const t = await setup();
    const { tokens, user } = await connect(t, MOCK.staff);
    const half = await callTool(t, tokens.access_token, 'leave_prepare', { days: [{ date: '2026-10-28', kind: 'half' }], type: 'annual' });
    expect(half.json().result?.isError ?? half.json().error).toBeTruthy();
    expect(TOOLS.find((x) => x.name === 'leave_prepare')!.input.days!.description).toContain('am 오전 반차 · pm 오후 반차');

    const { out } = await structured(t, tokens.access_token, 'leave_prepare', {
      days: [
        { date: '2026-10-29', kind: 'pm' },
        { date: '2026-10-28', kind: 'am' },
        { date: '2026-10-29', kind: 'am' },
      ],
      type: 'annual',
    });
    // 같은 날 오전·오후는 하루로 합쳐요.
    expect(out.days).toEqual([
      { date: '2026-10-28', kind: 'am', label: '10월 28일(수) 오전 반차' },
      { date: '2026-10-29', kind: 'full', label: '10월 29일(목) 하루' },
    ]);
    const res = await user.call('POST', '/api/mcp/link', { proposalToken: tokenOf(out.link) });
    expect(res.body.action.days).toEqual([
      { date: '2026-10-28', kind: 'half', half: 'am' },
      { date: '2026-10-29', kind: 'full' },
    ]);
  });

  it('[ADR-14 개정·R13] 링크를 열면 그 날짜·종류로 채운 휴가 양식이 열리고(남은 연차는 내 화면에만), 열기만 해서는 휴가 요청·plan 0건이에요', async () => {
    const t = await setup();
    const { tokens, user } = await connect(t, MOCK.staff);
    const days = [
      { date: '2026-10-28', kind: 'full' },
      { date: '2026-10-29', kind: 'pm' },
    ];
    const { out } = await structured(t, tokens.access_token, 'leave_prepare', { days, type: 'sick' });
    const token = tokenOf(out.link);
    // 봉인돼서 풀어 봐도 날짜·종류가 보이지 않고, 안에는 날짜·종류만 있어요(사유 칸 없음).
    expect(decoded(token)).not.toContain('2026-10-28');
    expect(decoded(token)).not.toContain('sick');
    const peeked = peekAs(t, MOCK.staff, token);
    expect(peeked).toMatchObject({ module: 'navi', action: 'leave-link', expired: false });
    expect(Object.keys(peeked.params as object).sort()).toEqual(['days', 'type']);

    const res = await user.call('POST', '/api/mcp/link', { proposalToken: token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'leave',
      action: {
        type: 'leave-request',
        text: '병가 신청하기',
        rowId: 'HR-02',
        team: '인사팀',
        task: '휴가 신청',
        days: [
          { date: '2026-10-28', kind: 'full' },
          { date: '2026-10-29', kind: 'half', half: 'pm' },
        ],
        leaveType: 'sick',
      },
    });
    // 남은 연차·올해 병가는 본인이 앱에서 열 때만 이 화면으로 와요(서버가 지금 계산).
    expect(typeof res.body.action.remaining).toBe('number');
    expect(res.body.action.sick).toMatchObject({ used: expect.any(Number) });
    expect(await count(t, 'navi_inquiries')).toBe(0);
    expect(await count(t, 'plans')).toBe(0);

    // 링크로는 plan을 만들거나 바로 실행할 수 없어요. 보내기는 양식의 확인 시트 [보내기]뿐이에요.
    expect((await user.call('POST', '/api/plans', { proposalToken: token })).status).toBe(409);
    expect((await user.call('POST', '/api/plans/direct', { proposalToken: token, edits: {} })).status).toBe(400);
    await expect(t.ctx.plans.auto(user.me as never, 'navi', 'leave-link', peeked.params, 'req-leave-0001')).rejects.toThrow();
    expect(await count(t, 'navi_inquiries')).toBe(0);
    expect(await count(t, 'plans')).toBe(0);

    const other = await t.loginAs(MOCK.dev);
    expect((await other.call('POST', '/api/mcp/link', { proposalToken: token })).body).toMatchObject({ error: 'not-owner' });
  });

  it('[ADR-14 개정] 휴가 링크는 시간이 지나면 다시 준비하라고 하고, 담당 찾기가 꺼지면 꺼졌다고 알려요', async () => {
    const t = await setup();
    const { tokens, user } = await connect(t, MOCK.staff);
    const { out } = await structured(t, tokens.access_token, 'leave_prepare', { days: [{ date: '2026-10-28', kind: 'full' }], type: 'official' });
    const token = tokenOf(out.link);
    expect((await user.call('POST', '/api/mcp/link', { proposalToken: token })).body.action.leaveType).toBe('official');
    // 담당 찾기는 같이 채워요 단독 모드(공지·회의실 끔)에서만 끌 수 있어요.
    await t.ctx.ops.setModule('p_op', 'notices', 'off');
    await t.ctx.ops.setModule('p_op', 'rooms', 'off');
    await t.ctx.ops.setModule('p_op', 'navi', 'off');
    expect((await user.call('POST', '/api/mcp/link', { proposalToken: token })).body).toEqual({ kind: 'off', about: 'leave' });
    await t.ctx.ops.setModule('p_op', 'navi', 'on');
    t.advance((t.ctx.ops.get().values.proposalTtlSeconds + 1) * 1000);
    const again = await t.loginAs(MOCK.staff);
    expect((await again.call('POST', '/api/mcp/link', { proposalToken: token })).body).toEqual({ kind: 'expired', about: 'leave' });
  });
});

describe('pantry_find_similar 탕비실 요청 찾기', () => {
  it('[ADR-14 개정·F3] 연결한 사람 층의 열린 품목 이름·표 수만 주고, 표를 준 사람은 없어요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const spy = vi.spyOn(t.ctx.gateway, 'structured');
    const { out, body } = await structured(t, tokens.access_token, 'pantry_find_similar', { itemName: '제로콜라' });
    expect(out.floor).toBe('3층');
    expect(out.items.map((i: { name: string; votes: number }) => [i.name, i.votes])).toEqual([
      ['코카콜라 제로 355', 3],
      ['제로 콜라 캔', 2],
    ]);
    expect(out.items[0].linkText).toBe('한 줄 데스크에서 여기에 +1');
    expect(out.newRequest.linkText).toBe('한 줄 데스크에서 새 요청 쓰기');
    expect(body).not.toContain('p_demo_');
    expect(body).not.toMatch(/"(cardId|bundleId)"/);
    expect(spy).not.toHaveBeenCalled();

    // 5층 사람은 5층 판만 봐요. 3층 품목은 나오지 않아요.
    const dev = await connect(t, MOCK.dev);
    const theirs = await structured(t, dev.tokens.access_token, 'pantry_find_similar', { itemName: '제로콜라' });
    expect(theirs.out).toMatchObject({ floor: '5층', items: [], emptyReason: { code: 'no-match' } });
    tokenOf(theirs.out.newRequest.link);

    // 층은 접근 토큰에 봉인돼 있고, 갱신해도 디렉터리에서 다시 읽어 그대로예요.
    const renewed = (await refresh(t, tokens.refresh_token)).json();
    expect((await structured(t, renewed.access_token, 'pantry_find_similar', { itemName: '녹차' })).out).toMatchObject({ floor: '3층' });
  });

  it('[R13 카나리] 찾은 품목 이름은 링크 토큰·DB·감사 로그·접속기록 어디에도 남지 않아요', async () => {
    const t = await setup();
    const { tokens, user } = await connect(t, MOCK.staff);
    const canary = '카나리콜라Q7Z 제로';
    const { out, body } = await structured(t, tokens.access_token, 'pantry_find_similar', { itemName: canary });
    expect(body).not.toContain('카나리콜라Q7Z');
    const links = [...out.items.map((i: { link: string }) => i.link), out.newRequest.link];
    for (const link of links) {
      const token = tokenOf(link);
      expect(decoded(token)).not.toContain('카나리콜라Q7Z');
      const peeked = peekAs(t, MOCK.staff, token);
      expect(peeked).toMatchObject({ module: 'pantry', action: 'board-link' });
      expect(Object.keys(peeked.params as object)).toEqual(['cardId']);
      await user.call('POST', '/api/mcp/link', { proposalToken: token });
    }
    expect(await allTables(t)).not.toContain('카나리콜라Q7Z');
    expect((await t.db.query("select tool, result from audit_log where tool = 'pantry_find_similar'")).rows).toEqual([
      { tool: 'pantry_find_similar', result: out.items.length ? 'found' : 'none' },
    ]);
    const access = (await t.db.query<{ subject_refs: string[] }>("select subject_refs from access_log where action = 'mcp.call'")).rows;
    expect(access).toEqual([{ subject_refs: [] }]);
  });

  it('[ADR-11] 공통 입력 검사에 걸리는 이름은 찾지 않고 거절해요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const { result } = await structured(t, tokens.access_token, 'pantry_find_similar', { itemName: '콜라 900101-1234567' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('1234567');
    expect(await allTables(t)).not.toContain('1234567');
  });

  it('[ADR-14 개정·F3-1] 품목 링크를 열면 [여기에 +1] 고정 버튼 카드가 열리고, 열기만 해서는 표가 그대로예요', async () => {
    const t = await setup();
    const { tokens, user } = await connect(t, MOCK.staff);
    const { out } = await structured(t, tokens.access_token, 'pantry_find_similar', { itemName: '녹차' });
    expect(out.items).toHaveLength(1);
    const token = tokenOf(out.items[0].link);
    const votes = await count(t, 'pantry_votes');

    const res = await user.call('POST', '/api/mcp/link', { proposalToken: token });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('pantry');
    const card = res.body.cards[0];
    expect(card.headline).toBe('판에 있는 품목이에요: 녹차 티백');
    expect(card.actions.primary).toMatchObject({ type: 'fixed', text: '여기에 +1', method: 'POST', path: '/api/pantry/votes' });
    expect(JSON.stringify(res.body)).not.toContain('p_demo_');
    expect(await count(t, 'pantry_votes')).toBe(votes);
    expect(await count(t, 'plans')).toBe(0);
    expect((await user.call('POST', '/api/plans', { proposalToken: token })).status).toBe(409);
    expect((await user.call('POST', '/api/plans/direct', { proposalToken: token, edits: {} })).status).toBe(400);
    expect(await count(t, 'pantry_votes')).toBe(votes);

    // 사람이 고정 버튼을 눌러야 표가 하나 늘어요.
    const pressed = await user.call('POST', card.actions.primary.path, card.actions.primary.body);
    expect(pressed.status).toBe(200);
    expect(await count(t, 'pantry_votes')).toBe(votes + 1);
    const after = await user.call('POST', '/api/mcp/link', { proposalToken: token });
    expect(after.body.cards[0].actions.primary).toMatchObject({ type: 'navigate', to: 'board' });

    const other = await t.loginAs(MOCK.dev);
    expect((await other.call('POST', '/api/mcp/link', { proposalToken: token })).body).toMatchObject({ error: 'not-owner' });
  });

  it('[ADR-14 개정] 새 요청 링크는 쓰기 칸을 빈 채로 열고, 다른 층 품목·꺼진 판·지난 링크는 열지 않아요', async () => {
    const t = await setup();
    const { tokens, user } = await connect(t, MOCK.staff);
    const { out } = await structured(t, tokens.access_token, 'pantry_find_similar', { itemName: '원두' });
    const fresh = tokenOf(out.newRequest.link);
    expect((await user.call('POST', '/api/mcp/link', { proposalToken: fresh })).body).toEqual({ kind: 'pantry-new' });

    // 5층 품목 카드 ID로 만든 링크는 3층 사람에게 열리지 않아요(내 층 판만).
    const fifth = Number((await t.db.query<{ id: number | string }>("select id from pantry_cards where floor = '5층' order by id limit 1")).rows[0]!.id); // PostgreSQL은 bigint를 글자로 돌려줘요
    const other = t.ctx.services.pantry!.mcp!.proposeBoardLink({ pseudonymId: peekOwner(t) }, fifth);
    expect((await user.call('POST', '/api/mcp/link', { proposalToken: other })).body).toEqual({ kind: 'gone', about: 'pantry' });

    await t.ctx.ops.setModule('p_op', 'pantry', 'link');
    expect((await user.call('POST', '/api/mcp/link', { proposalToken: fresh })).body).toEqual({ kind: 'off', about: 'pantry' });
    expect(await toolNames(t, tokens.access_token)).not.toContain('pantry_find_similar');
    await t.ctx.ops.setModule('p_op', 'pantry', 'on');
    t.advance((t.ctx.ops.get().values.proposalTtlSeconds + 1) * 1000);
    const again = await t.loginAs(MOCK.staff);
    expect((await again.call('POST', '/api/mcp/link', { proposalToken: fresh })).body).toEqual({ kind: 'expired', about: 'pantry' });
  });
});

/** 3층 가상 직원(하늘)의 가명 ID */
function peekOwner(t: TestApp): string {
  return pseudonymize(t.ctx.config.pseudonymSecret, MOCK.staff);
}

const EQUIPMENT_ARGS = { kind: '빔프로젝터', date: '2026-10-27', start: '15:00', minutes: 60 };

describe('rooms_find_equipment 장비 대여 확인', () => {
  it('[ADR-14 개정·ADR-19] 남은 수·전체 수와 대여 확인 링크만 주고, 빌린 사람·보관 위치는 없어요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const { out, body } = await structured(t, tokens.access_token, 'rooms_find_equipment', EQUIPMENT_ARGS);
    expect(out).toMatchObject({ kind: '빔프로젝터', when: '10월 27일(화) 15:00~16:00', free: 2, total: 2, linkText: '한 줄 데스크에서 빔프로젝터 빌리기' });
    expect(out.confirm).toContain('빌리기는 앱 확인 시트에서 한 번');
    tokenOf(out.link);
    expect(body).not.toContain('보관함');
    expect(body).not.toMatch(/eq-projector|pseudonym/);

    const past = await structured(t, tokens.access_token, 'rooms_find_equipment', { ...EQUIPMENT_ARGS, date: '2026-10-25' });
    expect(past.out).toMatchObject({ emptyReason: { code: 'past' } });
    expect(past.out.link).toBeUndefined();
    const late = await structured(t, tokens.access_token, 'rooms_find_equipment', { ...EQUIPMENT_ARGS, start: '23:30' });
    expect(late.out.emptyReason.code).toBe('bad-time');
    await t.ctx.ops.setFlag('p_op', 'roomsWrite', false);
    const off = await structured(t, tokens.access_token, 'rooms_find_equipment', EQUIPMENT_ARGS);
    expect(off.out).toMatchObject({ free: 2, emptyReason: { code: 'write-off' } });
    expect(off.out.link).toBeUndefined();
  });

  it('[ADR-14 개정·R2] 링크를 열면 지금 다시 확인한 카드에 [빌리기](확인 시트)가 붙고, 열기만 해서는 대여·plan 0건이에요', async () => {
    const t = await setup();
    const { tokens, user } = await connect(t, MOCK.staff);
    const { out } = await structured(t, tokens.access_token, 'rooms_find_equipment', EQUIPMENT_ARGS);
    const token = tokenOf(out.link);
    expect(decoded(token)).not.toContain('2026-10-27T15');
    const peeked = peekAs(t, MOCK.staff, token);
    expect(peeked).toMatchObject({
      module: 'rooms',
      action: 'rent-link',
      params: { kind: '빔프로젝터', start: '2026-10-27T15:00:00+09:00', end: '2026-10-27T16:00:00+09:00' },
    });
    expect(Object.keys(peeked.params as object).sort()).toEqual(['end', 'kind', 'start']);

    const res = await user.call('POST', '/api/mcp/link', { proposalToken: token });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('equipment');
    const primary = res.body.cards[0].actions.primary;
    expect(primary).toMatchObject({ type: 'propose', text: '빌리기' });
    expect(await count(t, 'room_equipment_loans')).toBe(0);
    expect(await count(t, 'plans')).toBe(0);

    // MCP 링크 토큰 자체로는 plan·바로 실행·자동 실행이 모두 막혀요(자동 실행 허용 목록을 MCP로 넓히지 않아요).
    expect((await user.call('POST', '/api/plans', { proposalToken: token })).status).toBe(409);
    expect((await user.call('POST', '/api/plans/direct', { proposalToken: token, edits: {} })).status).toBe(400);
    await expect(t.ctx.plans.auto(user.me as never, 'rooms', 'rent-link', peeked.params, 'req-rent-0001')).rejects.toThrow();
    expect(await count(t, 'room_equipment_loans')).toBe(0);

    // 앱 카드의 [빌리기] → 확인 시트 → [빌리기]가 유일한 길이에요.
    const sheet = await user.call('POST', '/api/plans', { proposalToken: primary.proposalToken });
    expect(sheet.body).toMatchObject({ status: 'sheet', sheet: { title: '이 장비를 빌릴까요?', confirmLabel: '빌리기' } });
    expect(await count(t, 'room_equipment_loans')).toBe(0);
    const done = await user.call('POST', `/api/plans/${sheet.body.planId}/confirm`);
    expect(done.body.status).toBe('done');
    expect(await count(t, 'room_equipment_loans')).toBe(1);

    const other = await t.loginAs(MOCK.dev);
    expect((await other.call('POST', '/api/mcp/link', { proposalToken: token })).body).toMatchObject({ error: 'not-owner' });
  });

  it('[ADR-14 개정] 장비 링크는 회의실 쓰기가 꺼지면 꺼졌다고, 시간이 지나면 다시 찾으라고 알려요', async () => {
    const t = await setup();
    const { tokens, user } = await connect(t, MOCK.staff);
    const token = tokenOf((await structured(t, tokens.access_token, 'rooms_find_equipment', EQUIPMENT_ARGS)).out.link);
    await t.ctx.ops.setFlag('p_op', 'roomsWrite', false);
    expect((await user.call('POST', '/api/mcp/link', { proposalToken: token })).body).toEqual({ kind: 'off', about: 'equipment' });
    await t.ctx.ops.setFlag('p_op', 'roomsWrite', true);
    t.advance((t.ctx.ops.get().values.proposalTtlSeconds + 1) * 1000);
    const again = await t.loginAs(MOCK.staff);
    expect((await again.call('POST', '/api/mcp/link', { proposalToken: token })).body).toEqual({ kind: 'expired', about: 'equipment' });
  });
});

describe('범위·스위치·DB', () => {
  it('[ADR-15 시험] 새 범위가 없는 연결로 부르면 403 insufficient_scope이고 그 범위를 알려 줘요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff, { scope: 'notices.read' });
    const leave = await callTool(t, tokens.access_token, 'leave_prepare', { days: [{ date: '2026-10-28', kind: 'full' }], type: 'annual' });
    expect(leave.statusCode).toBe(403);
    expect(leave.headers['www-authenticate']).toContain('leave.prepare');
    const pantry = await callTool(t, tokens.access_token, 'pantry_find_similar', { itemName: '콜라' });
    expect(pantry.statusCode).toBe(403);
    expect(pantry.headers['www-authenticate']).toContain('pantry.read');
    const equipment = await callTool(t, tokens.access_token, 'rooms_find_equipment', EQUIPMENT_ARGS);
    expect(equipment.statusCode).toBe(403);
    expect(equipment.headers['www-authenticate']).toContain('rooms.read');
  });

  it('[MCP-7] 도구별 스위치로 하나씩 끄고, 모듈이 켬이 아니면 그 모듈 도구가 빠져요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    for (const name of LINK_TOOLS) await t.ctx.ops.setMcpTool('p_op', name, false);
    const names = await toolNames(t, tokens.access_token);
    for (const name of LINK_TOOLS) expect(names).not.toContain(name);
    const off = await callTool(t, tokens.access_token, 'rooms_find_equipment', EQUIPMENT_ARGS);
    expect(off.json().result?.isError ?? off.json().error).toBeTruthy();
    for (const name of LINK_TOOLS) await t.ctx.ops.setMcpTool('p_op', name, true);
    await t.ctx.ops.setModule('p_op', 'rooms', 'link');
    await t.ctx.ops.setModule('p_op', 'navi', 'link');
    expect(await toolNames(t, tokens.access_token)).toEqual(['notices_search', 'pantry_find_similar']);
  });

  it('[MCP-6] 세 도구 모두 감사 로그·접속기록 말고 DB에 쓰지 않아요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const before = await dumpTablesExceptAudit(t.db);
    await structured(t, tokens.access_token, 'leave_prepare', { days: [{ date: '2026-10-28', kind: 'full' }], type: 'annual' });
    await structured(t, tokens.access_token, 'pantry_find_similar', { itemName: '제로콜라' });
    await structured(t, tokens.access_token, 'rooms_find_equipment', EQUIPMENT_ARGS);
    expect(await dumpTablesExceptAudit(t.db)).toBe(before);
  });
});
