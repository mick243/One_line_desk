import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockAdapters } from '../adapters';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { createTestApp, MOCK } from '../testing';
import { pseudonymize } from './pseudonym';
import { createTestDb } from './db/test-db';

// 접속기록(ADR-20, 개인정보의 안전성 확보조치 기준 제8조). 감사 로그와 따로, 접속지·처리한 정보주체 표시를 남겨요.
// 글·검색어·이름은 남기지 않고, 고칠 수 없고, 1년이 지난 줄만 지워요.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  await t.modules.find((m) => m.kind === 'navi')!.seed!();
  return t;
}

interface Row {
  action: string;
  pseudonym_id: string;
  subject_refs: string[];
  client_ip: string | null;
  request_id: string | null;
}
/** 요청 번호는 프로세스마다 다시 세지 않는 무작위 값이에요(배포 준비 회의 C5). 1년 기록에서 겹치지 않아요. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const rows = async (t: TestApp, action?: string) =>
  (
    await t.db.query<Row>(
      `select action, pseudonym_id, subject_refs, host(client_ip) as client_ip, request_id from access_log ${action ? 'where action = $1' : ''} order by id`,
      action ? [action] : [],
    )
  ).rows;

describe('접속기록(C-2)', () => {
  it('로그인·로그아웃은 누가·언제·어디서를 남겨요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    await me.call('POST', '/api/auth/logout');
    const pseudonymId = pseudonymize(t.ctx.config.pseudonymSecret, MOCK.dev);
    expect(await rows(t)).toEqual([
      { action: 'login', pseudonym_id: pseudonymId, subject_refs: [], client_ip: '127.0.0.1', request_id: expect.stringMatching(UUID) },
      { action: 'logout', pseudonym_id: pseudonymId, subject_refs: [], client_ip: '127.0.0.1', request_id: expect.stringMatching(UUID) },
    ]);
  });

  it('받은 문의함을 열거나 처리하면 연 문의 번호를 남기고, 글은 남기지 않아요', async () => {
    const t = await setup();
    const sender = await t.loginAs(MOCK.dev);
    const sent = await sender.call('POST', '/api/navi/inquiries', {
      rowId: 'FIN-01',
      question: '접속기록카나리 법인카드 문의',
      reason: '시험',
      requestId: randomUUID(),
    });
    expect(sent.status).toBe(200);
    const finance = await t.loginAs(MOCK.staff);
    const inbox = (await finance.call('GET', '/api/navi/inquiries/inbox')).body as { enabled: boolean; items: { id: string }[] };
    expect(inbox.enabled).toBe(true);
    const id = inbox.items[0]!.id;
    expect((await finance.call('POST', `/api/navi/inquiries/${id}/state`, { state: 'seen' })).status).toBe(200);

    expect(await rows(t, 'inquiry.inbox')).toEqual([expect.objectContaining({ subject_refs: [`inquiry:${id}`] })]);
    expect(await rows(t, 'inquiry.update')).toEqual([expect.objectContaining({ subject_refs: [`inquiry:${id}`] })]);
    // 내 문의(내가 보낸 것)는 남의 정보가 아니라 남기지 않아요.
    await sender.call('GET', '/api/navi/inquiries/mine');
    expect(JSON.stringify((await t.db.query('select * from access_log')).rows)).not.toContain('카나리');
  });

  it('직원 검색은 검색어 없이 보여 준 사람의 가명 ID만 남겨요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const found = (await me.call('POST', '/api/people/search', { query: '가상' })).body as { items: unknown[] };
    expect(found.items.length).toBeGreaterThan(0);
    const [row] = await rows(t, 'people.search');
    expect(row!.subject_refs).toHaveLength(found.items.length);
    for (const ref of row!.subject_refs) expect(ref).toMatch(/^person:p_[0-9a-f]{24}$/);
    expect(JSON.stringify(row)).not.toContain('가상');
  });

  it('정해진 칸·동작·모양만 받아요', async () => {
    const t = await setup();
    const base = { pseudonymId: 'p_x' };
    await expect(t.ctx.access.record({ ...base, action: 'login', note: '글' } as never)).rejects.toThrow('없는 칸');
    await expect(t.ctx.access.record({ ...base, action: 'read-everything' } as never)).rejects.toThrow('정해지지 않은');
    await expect(t.ctx.access.record({ ...base, action: 'people.search', subjectRefs: ['가상 직원 하늘'] })).rejects.toThrow('모양이 틀렸어요');
    await t.ctx.access.record({ ...base, action: 'login', ip: 'not-an-ip', requestId: 'bad id!' });
    expect((await rows(t)).at(-1)).toMatchObject({ client_ip: null, request_id: null });
  });

  it('고칠 수 없고, 1년이 지난 줄만 지워져요', async () => {
    const t = await setup();
    await t.loginAs(MOCK.dev);
    await expect(t.db.query("update access_log set action = 'logout'")).rejects.toThrow('cannot be changed');
    await expect(t.db.query('delete from access_log')).rejects.toThrow('kept for a year');
    await t.db.query("insert into access_log (at, pseudonym_id, action) values (now() - interval '400 days', 'p_old', 'login')");
    await t.ctx.access.purge();
    expect((await rows(t)).map((r) => r.pseudonym_id)).toEqual([pseudonymize(t.ctx.config.pseudonymSecret, MOCK.dev)]);
  });

  it('관문 주소만 믿으면 진짜 접속지를 남기고, 관문을 건너뛴 위조 머리는 믿지 않아요(TRUST_PROXY)', async () => {
    const db = await createTestDb();
    const built = await buildApp({
      config: { ...loadConfig({}), databaseUrl: undefined, trustProxy: '10.0.3.11' },
      db,
      adapters: createMockAdapters(),
      seed: false,
      retentionTimer: false,
    });
    try {
      const login = (remoteAddress: string, xff: string) =>
        built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { idpSubject: MOCK.dev }, remoteAddress, headers: { 'x-forwarded-for': xff } });
      expect((await login('10.0.3.11', '203.0.113.7')).statusCode).toBe(200);
      expect((await login('10.0.9.99', '198.51.100.1')).statusCode).toBe(200);
      const ips = (await db.query<{ ip: string }>('select host(client_ip) as ip from access_log order by id')).rows.map((r) => r.ip);
      expect(ips).toEqual(['203.0.113.7', '10.0.9.99']);
    } finally {
      await built.app.close();
      await db.close();
    }
  });
});
