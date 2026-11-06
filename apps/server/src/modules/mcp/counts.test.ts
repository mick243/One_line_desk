import type { PeopleSearchResponse } from '@one-line-desk/shared';
import { MCP_COUNT_KINDS } from '@one-line-desk/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { countCutoffDay, shiftMonth } from './counts';
import { fakeNotices, fakeRooms } from './fixtures/fake-services';
import { authorize, callTool, connect, mcpRequest, refresh, ROOMS_ARGS, setupMcp, type TestApp } from './fixtures/oauth-flow';
import { DEMO_CLIENT } from './index';

// 월간 보고용 날마다 셈(11/3 사용자 결정, 510_mcp.sql, ADR-21 예외 13개월).
// 감사 로그를 남기는 자리에서 그때그때 더하고, 표에는 날·종류·앱 이름·수만 있어요.

vi.setConfig({ testTimeout: 30_000 });

const opened: TestApp[] = [];
async function setup(start?: number) {
  const t = await createTestApp(start === undefined ? {} : { start });
  opened.push(t);
  t.ctx.services.rooms = fakeRooms().service;
  t.ctx.services.notices = fakeNotices().service;
  await setupMcp(t);
  return t;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function countsOf(t: TestApp): Promise<Record<string, number>> {
  const { rows } = await t.db.query<{ day: string; kind: string; app: string; count: number }>(
    "select to_char(day, 'YYYY-MM-DD') as day, kind, app, count from mcp_daily_counts order by day, kind, app",
  );
  return Object.fromEntries(rows.map((r) => [`${r.day} ${r.kind} ${r.app}`, r.count]));
}

describe('셈 표 모양', () => {
  it('[530] 칸은 날·종류·앱·수뿐이에요(사람·가명 ID·클라이언트 ID·도구 입력 칸 없음)', async () => {
    const t = await setup();
    const { rows } = await t.db.query<{ column_name: string; data_type: string }>(
      "select column_name, data_type from information_schema.columns where table_schema = current_schema() and table_name = 'mcp_daily_counts' order by ordinal_position",
    );
    expect(rows).toEqual([
      { column_name: 'day', data_type: 'date' },
      { column_name: 'kind', data_type: 'text' },
      { column_name: 'app', data_type: 'text' },
      { column_name: 'count', data_type: 'integer' },
    ]);
  });

  it('[530] 종류는 정해진 코드만 받아요(DB check와 코드 목록이 같아요)', async () => {
    const t = await setup();
    for (const kind of MCP_COUNT_KINDS) {
      await t.db.query("insert into mcp_daily_counts (day, kind, app, count) values ('2026-10-01', $1, 'X', 1)", [kind]);
    }
    await expect(t.db.query("insert into mcp_daily_counts (day, kind, app, count) values ('2026-10-01', 'search.query', 'X', 1)")).rejects.toThrow();
    await expect(t.db.query("insert into mcp_daily_counts (day, kind, app, count) values ('2026-10-02', 'connect', '', 1)")).rejects.toThrow();
  });
});

describe('셈 더하기', () => {
  it('[530] 도구 호출 결과·연결 허락·거절·막힌 앱마다 그 날·앱 이름으로 셈이 올라요(클라이언트 ID는 남지 않아요)', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    await callTool(t, tokens.access_token, 'rooms_find_free', ROOMS_ARGS);
    await callTool(t, tokens.access_token, 'rooms_find_free', ROOMS_ARGS);
    await callTool(t, tokens.access_token, 'rooms_find_free', { ...ROOMS_ARGS, people: 0 });
    // 허락하지 않기
    const user = await t.loginAs(MOCK.dev);
    const auth = await authorize(t);
    await user.call('POST', '/api/mcp/consent', { req: auth.location.searchParams.get('req'), decision: 'deny' });
    await authorize(t, { client_id: 'not-registered-app' });

    expect(await countsOf(t)).toEqual({
      '2026-10-26 authorize.blocked -': 1,
      '2026-10-26 call.found Claude': 2,
      '2026-10-26 call.refused Claude': 1,
      '2026-10-26 connect Claude': 1,
      '2026-10-26 connect.denied Claude': 1,
    });
    const dump = JSON.stringify((await t.db.query('select * from mcp_daily_counts')).rows);
    expect(dump).not.toContain(DEMO_CLIENT.clientId);
    expect(dump).not.toContain('not-registered-app');
    expect(dump).not.toMatch(/p_[0-9a-f]{6}|mock\|/);
  });

  it('[530] 본인 끊기·기기 폐기·운영자 앱별 끊기·사람별 끊기·회수가 끊은 연결 수만큼 셈에 더해져요', async () => {
    const t = await setup();
    // 본인 [끊기]: 기기 둘
    const a = await connect(t, MOCK.staff);
    await connect(t, MOCK.staff);
    expect((await a.user.call('DELETE', `/api/mcp/connections/${DEMO_CLIENT.clientId}`)).body).toMatchObject({ removed: 2 });
    // 기기 폐기(RFC 7009)
    const b = await connect(t, MOCK.dev);
    const revoke = await t.app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ token: b.tokens.refresh_token, client_id: DEMO_CLIENT.clientId, client_secret: DEMO_CLIENT.clientSecret }).toString(),
    });
    expect(revoke.statusCode).toBe(200);
    // 운영자 앱별 끊기
    await connect(t, MOCK.staff);
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('POST', `/api/ops/mcp/clients/${DEMO_CLIENT.clientId}/disconnect`)).body).toEqual({ removed: 1 });
    // 운영자 사람별 끊기
    await connect(t, MOCK.staff);
    await connect(t, MOCK.staff);
    const ref = ((await op.call('POST', '/api/people/search', { query: '하늘' })).body as PeopleSearchResponse).items[0]!.ref;
    expect((await op.call('POST', '/api/ops/mcp/people/disconnect', { ref })).body).toEqual({ removed: 2 });
    // 회수: 지운 앱의 이름으로 남아요(지우기 전에 더해요).
    await connect(t, MOCK.dev);
    expect((await op.call('DELETE', `/api/ops/mcp/clients/${DEMO_CLIENT.clientId}`)).body).toEqual({ removed: 1 });

    const c = await countsOf(t);
    expect(c['2026-10-26 disconnect Claude']).toBe(3);
    expect(c['2026-10-26 disconnect.ops Claude']).toBe(4);
    expect(c['2026-10-26 connect Claude']).toBe(7);
  });

  it('[530] 갱신 거부·퇴사 끊김·모든 기기 로그아웃도 셈에 들어가요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    t.adapters.employees.setActive(MOCK.staff, false);
    // 재직 재확인 재사용 창이 지나면 갱신이 거부되고, 그 사람의 연결이 모두 끊겨요.
    t.advance(t.ctx.ops.get().values.employmentRecheckSeconds * 1000);
    expect((await refresh(t, tokens.refresh_token)).statusCode).toBe(400);
    const c = await countsOf(t);
    expect(c['2026-10-26 employment.ended Claude']).toBe(1);
    expect(c['2026-10-26 token.refused Claude']).toBe(1);
    expect(c['2026-10-26 disconnect Claude']).toBe(1);

    // 모든 기기 로그아웃
    const dev = await connect(t, MOCK.dev);
    await connect(t, MOCK.dev);
    expect((await dev.user.call('POST', '/api/auth/logout-all')).status).toBe(200);
    expect((await mcpRequest(t, dev.tokens.access_token, 'tools/list')).statusCode).toBe(401);
    expect((await countsOf(t))['2026-10-26 disconnect Claude']).toBe(3);
  });

  it('[530] 날은 한국 시간이에요(UTC로는 전날 15시 반이 한국 0시 반)', async () => {
    const t = await setup(Date.parse('2026-10-31T15:30:00Z'));
    await connect(t, MOCK.staff);
    expect(await countsOf(t)).toEqual({ '2026-11-01 connect Claude': 1 });
  });
});

describe('보관 13개월(ADR-21 예외)', () => {
  it('[530] 이번 달과 지난 12달만 남기고 그보다 앞선 날만 지워요', async () => {
    const t = await setup();
    // 시험 시계는 2026-10-26이에요: 2025-10 ~ 2026-10(13개 달)을 남겨요.
    expect(countCutoffDay(t.now())).toBe('2025-10-01');
    for (const day of ['2025-08-31', '2025-09-30', '2025-10-01', '2026-01-15', '2026-10-26']) {
      await t.db.query("insert into mcp_daily_counts (day, kind, app, count) values ($1, 'connect', 'Claude', 1)", [day]);
    }
    expect(await t.runRetention()).toEqual([]);
    const { rows } = await t.db.query<{ day: string }>("select to_char(day, 'YYYY-MM-DD') as day from mcp_daily_counts order by day");
    expect(rows.map((r) => r.day)).toEqual(['2025-10-01', '2026-01-15', '2026-10-26']);
    // 8일 뒤(2026-11-03): 7일 보관 회차(감사 로그 등)와 달리 8일 지난 2026-10-26 셈은 남고, 달이 바뀌어 2025-10만 빠져요.
    t.advance(8 * 24 * 60 * 60_000);
    await t.runRetention();
    const after = await t.db.query<{ day: string }>("select to_char(day, 'YYYY-MM-DD') as day from mcp_daily_counts order by day");
    expect(after.rows.map((r) => r.day)).toEqual(['2026-01-15', '2026-10-26']);
  });

  it('[530] 달 옮기기는 해를 넘어도 맞아요', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-11', -12)).toBe('2025-11');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  });
});
