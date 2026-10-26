import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { callTool, connect, dumpTablesExceptAudit, ROOMS_ARGS, setupMcp, type TestApp } from './fixtures/oauth-flow';

// 실제 회의실·공지 모듈(모의 장부·가상 공지)과 함께 도는 MCP 시험. 가짜 서비스를 넣지 않아요.
// 다른 모듈이 바뀌면 여기서 먼저 깨질 수 있어요.

vi.setConfig({ testTimeout: 30_000 });

const opened: TestApp[] = [];
async function setup() {
  const t = await createTestApp();
  opened.push(t);
  for (const module of t.modules) await module.seed?.();
  await setupMcp(t);
  return t;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

describe('실제 모듈과 함께', () => {
  it('[MCP-6] 링크를 열기만 하면 DB 변화가 0이고, 남의 링크는 열리지 않아요', async () => {
    const t = await setup();
    const { user, tokens } = await connect(t, MOCK.staff);
    const res = await callTool(t, tokens.access_token, 'rooms_find_free', ROOMS_ARGS);
    expect(res.statusCode).toBe(200);
    const out = res.json().result.structuredContent;
    const links: string[] = [...out.candidates, ...out.alternatives].map((c: { link: string }) => c.link);
    expect(links.length).toBeGreaterThan(0);
    const token = new URL(links[0]!).pathname.replace(/^\/r\//, '');

    const before = await dumpTablesExceptAudit(t.db);
    const mine = await user.call('POST', '/api/rooms/recheck', { proposalToken: token });
    expect(mine.status).toBe(200);
    expect(await dumpTablesExceptAudit(t.db)).toBe(before);

    const other = await t.loginAs(MOCK.dev);
    const theirs = await other.call('POST', '/api/rooms/recheck', { proposalToken: token });
    expect(theirs).toEqual({ status: 403, body: { error: 'not-owner', message: '다른 사람이 받은 링크라 열 수 없어요' } });
    expect((await t.db.query('select count(*)::int as n from room_reservations where plan_id in (select id from plans)')).rows[0]).toEqual({ n: 0 });
  });

  it('[MCP-2·3] 실제 모듈 결과도 정해진 칸만 나가요', async () => {
    const t = await setup();
    const { tokens } = await connect(t, MOCK.staff);
    const rooms = (await callTool(t, tokens.access_token, 'rooms_find_free', ROOMS_ARGS)).json().result;
    expect(rooms.isError).toBeFalsy();
    for (const c of rooms.structuredContent.candidates) {
      expect(Object.keys(c).sort()).toEqual([
        'capacity',
        'date',
        'end',
        'equipment',
        'facilities',
        'floor',
        'link',
        'linkText',
        'matched',
        'roomId',
        'roomName',
        'start',
      ]);
    }
    expect(rooms.structuredContent.mock).toBe(true);
    const notices = (await callTool(t, tokens.access_token, 'notices_search', { query: '연말정산' })).json().result;
    expect(notices.isError).toBeFalsy();
    expect(notices.structuredContent.hits.length).toBeGreaterThan(0);
    for (const h of notices.structuredContent.hits) expect(Object.keys(h).sort()).toEqual(['postedOn', 'title', 'url']);
    expect((await t.db.query('select count(*)::int as n from ai_usage')).rows[0]).toEqual({ n: 0 });
  });
});
