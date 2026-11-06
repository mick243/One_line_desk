import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AskResponse, GroupwareDoc, GroupwareFormResponse, GroupwareInboxResponse, HomeAskResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type Adapters, createMockAdapters } from '../adapters';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { createTestDb } from '../core/db/test-db';
import { createTestApp, MOCK } from '../testing';
import { DEMO_GROUPWARE_MAX_DOCS, DemoGroupwareStore } from './demo-groupware';

// 시연 전용 가상 그룹웨어 전자결재(11/6 사용자 결정, 휴가 A안). 시험 시계는 2026-10-26(월) 09:00이에요.
// 서준(개발팀) 기안 → 개발팀 팀장 도윤 → 인사팀(지후) → 최종 승인되면 가상 근태 기록에 들어가고, 한 줄 데스크는 근태 기록만 읽어요.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp({ leaveInApp: false });
  opened.push(t);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 1000 });
  for (const kind of ['rooms', 'navi'] as const) await t.modules.find((m) => m.kind === kind)!.seed!();
  return t;
}

let n = 0;
const requestId = () => `gw-req-${(n += 1).toString().padStart(4, '0')}`;
const draft = (me: Session, from: string, to = from, half: 'full' | 'am' | 'pm' = 'full', type = 'annual', id = requestId(), reason?: string) =>
  me.call('POST', '/api/demo/groupware/drafts', { type, from, to, half, requestId: id, ...(reason !== undefined ? { reason } : {}) });
const inbox = async (me: Session, as = '') => (await me.call('GET', `/api/demo/groupware/inbox${as ? `?as=${as}` : ''}`)).body as GroupwareInboxResponse;
const refOf = async (me: Session, name: string) => (await inbox(me)).approvers.find((a) => a.name === name)!.ref;
const decide = (me: Session, id: string, as: string, decision: 'approved' | 'rejected', reason?: string) =>
  me.call('POST', `/api/demo/groupware/docs/${id}/decision`, { as, decision, ...(reason !== undefined ? { reason } : {}) });
const leaveDates = async (t: TestApp, email: string) =>
  ((await t.ctx.adapters.leave.leaveOf({ idpSubject: 'x', email })) ?? { uses: [] }).uses.map((u) => u.date);

describe('가상 그룹웨어 결재선(팀장 → 인사팀)', () => {
  it('기안자 부서 팀장 → 인사팀이고, 기안자가 팀장이거나 부서에 팀장이 없으면 인사팀만이에요', async () => {
    const t = await setup();
    const form = async (subject: string) => ((await (await t.loginAs(subject)).call('GET', '/api/demo/groupware/form')).body as GroupwareFormResponse).line;
    expect(await form(MOCK.devMember)).toEqual(['개발팀 팀장 가상 직원 도윤', '인사팀']);
    expect(await form(MOCK.dev)).toEqual(['인사팀']);
    expect(await form(MOCK.staff)).toEqual(['인사팀']);
    // 결재자로 보기 목록은 팀장과 인사팀 사람이에요. IdP 주체·메일은 내보내지 않아요.
    const me = await t.loginAs(MOCK.devMember);
    const list = (await inbox(me)).approvers;
    expect(list.map((a) => `${a.name}:${a.role}`)).toEqual(['가상 직원 도윤:팀장', '가상 직원 지우:팀장', '가상 인사 지후:인사팀', '가상 직원 은우:인사팀']);
    expect(JSON.stringify(list)).not.toMatch(/mock\||@corp\.example/);
  });
});

describe('가상 그룹웨어 결재와 근태 반영', () => {
  it('팀장 결재 → 인사 결재를 마쳐야 근태 기록·같은 팀 일정·회의실 인원 짐작에 들어가요. 차례가 아닌 사람은 결재하지 못해요', async () => {
    const t = await setup();
    const seojun = await t.loginAs(MOCK.devMember);
    const doyun = await t.loginAs(MOCK.dev);
    const doc = ((await draft(seojun, '2026-11-06')).body as { doc: GroupwareDoc }).doc;
    expect(doc).toMatchObject({
      state: 'pending',
      typeLabel: '연차',
      daysText: '11월 6일(금) 하루 (1일)',
      drafter: { name: '가상 직원 서준', department: '개발팀' },
    });
    expect(doc.line.map((s) => s.state)).toEqual(['current', 'waiting']);

    const lead = await refOf(seojun, '가상 직원 도윤');
    const hr = await refOf(seojun, '가상 인사 지후');
    const otherLead = await refOf(seojun, '가상 직원 지우');
    // 인사팀은 팀장 결재 전에는 차례가 아니에요. 다른 팀 팀장도 결재하지 못해요.
    expect((await inbox(seojun, hr)).waiting).toEqual([]);
    expect(await decide(seojun, doc.id, hr, 'approved')).toMatchObject({ status: 403, body: { message: '이 문서의 결재 차례가 아니에요' } });
    expect(await decide(seojun, doc.id, otherLead, 'approved')).toMatchObject({ status: 403 });

    // 팀장 승인: 아직 근태 기록에 없어요. 앱(같은 팀 일정·회의실 인원)도 모르는 채예요.
    expect((await inbox(seojun, lead)).waiting.map((d) => d.id)).toEqual([doc.id]);
    const first = ((await decide(seojun, doc.id, lead, 'approved')).body as { doc: GroupwareDoc }).doc;
    expect(first.state).toBe('pending');
    expect(first.line.map((s) => s.state)).toEqual(['approved', 'current']);
    expect(await leaveDates(t, 'seojun@corp.example')).not.toContain('2026-11-06');
    const teamBefore = (await doyun.call('POST', '/api/home/ask', { text: '다음 주 우리 부서 휴가자' })).body as HomeAskResponse;
    expect(teamBefore.team?.entries.some((e) => e.name === '가상 직원 서준' && e.what === 'leave')).toBe(false);
    const roomsBefore = (await doyun.call('POST', '/api/ask', { text: '11월 6일 3시 회의실', kind: 'rooms' })).body as AskResponse;
    expect(roomsBefore.cards.map((c) => c.headline)).toContain('인원을 말하지 않아 우리 팀 4명으로 찾았어요');

    // 인사 최종 승인: 가상 근태 기록에 들어가고, 앱이 근태 기록을 읽어 보여요.
    const last = ((await decide(seojun, doc.id, hr, 'approved')).body as { doc: GroupwareDoc }).doc;
    expect(last).toMatchObject({ state: 'approved', stateLabel: '최종 승인', recorded: true });
    expect(await leaveDates(t, 'seojun@corp.example')).toContain('2026-11-06');
    const teamAfter = (await doyun.call('POST', '/api/home/ask', { text: '다음 주 우리 부서 휴가자' })).body as HomeAskResponse;
    expect(teamAfter.team?.entries).toContainEqual({ name: '가상 직원 서준', date: '2026-11-06', what: 'leave', part: 'full' });
    const roomsAfter = (await doyun.call('POST', '/api/ask', { text: '11월 6일 3시 회의실', kind: 'rooms' })).body as AskResponse;
    expect(roomsAfter.cards.map((c) => c.headline)).toContain('인원을 말하지 않아 우리 팀 3명(4명 중 휴가 1명 빼고)으로 찾았어요');
    // 서준의 상태 묻기 답도 근태 기록으로 "승인됐어요"예요.
    const status = (await seojun.call('POST', '/api/home/ask', { text: '내 휴가 신청 어떻게 됐어?' })).body as HomeAskResponse;
    expect(status.headline).toBe('11월 6일(금) 연차 하루가 승인됐어요');

    // 끝난 문서는 다시 결재하지 못해요.
    expect(await decide(seojun, doc.id, hr, 'approved')).toMatchObject({ status: 409 });
  });

  it('반려는 사유가 꼭 있어야 하고, 반려하면 근태 기록에 들어가지 않아요. 기안자는 내 문서에서 사유를 봐요', async () => {
    const t = await setup();
    const seojun = await t.loginAs(MOCK.devMember);
    const doc = ((await draft(seojun, '2026-11-09', '2026-11-10')).body as { doc: GroupwareDoc }).doc;
    const lead = await refOf(seojun, '가상 직원 도윤');
    expect(await decide(seojun, doc.id, lead, 'rejected')).toMatchObject({ status: 400, body: { message: '반려 사유를 적어 주세요' } });
    expect(await decide(seojun, doc.id, lead, 'rejected', '   ')).toMatchObject({ status: 400 });
    // 반려 사유도 공통 입력 검사를 지나요(주민번호 같은 글은 막아요).
    expect(await decide(seojun, doc.id, lead, 'rejected', '확인 900101-1234567')).toMatchObject({ status: 400, body: { error: 'locked' } });
    const rejected = ((await decide(seojun, doc.id, lead, 'rejected', '그 주에 출시가 있어요')).body as { doc: GroupwareDoc }).doc;
    expect(rejected).toMatchObject({ state: 'rejected', rejectReason: '그 주에 출시가 있어요' });
    expect(await leaveDates(t, 'seojun@corp.example')).not.toContain('2026-11-09');
    expect((await inbox(seojun)).mine[0]).toMatchObject({ id: doc.id, state: 'rejected', rejectReason: '그 주에 출시가 있어요' });
  });

  it('팀장이 기안하면 인사팀만 결재해요. 자기 신청서는 결재하지 못해요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const doc = ((await draft(doyun, '2026-10-28', '2026-10-28', 'pm')).body as { doc: GroupwareDoc }).doc;
    expect(doc.line.map((s) => s.label)).toEqual(['인사팀']);
    expect(await decide(doyun, doc.id, await refOf(doyun, '가상 직원 도윤'), 'approved')).toMatchObject({ status: 403 });
    const done = ((await decide(doyun, doc.id, await refOf(doyun, '가상 직원 은우'), 'approved')).body as { doc: GroupwareDoc }).doc;
    expect(done).toMatchObject({ state: 'approved', recorded: true });
    const uses = (await t.ctx.adapters.leave.leaveOf({ idpSubject: MOCK.dev, email: 'doyun@corp.example' }))!.uses;
    expect(uses).toContainEqual({ date: '2026-10-28', kind: 'half', half: 'pm' });
  });

  it('기안 검사: 같은 요청 번호는 한 번만, 지난 날·주말만·근태에 이미 있는 날·결재 중인 날과 겹침은 막아요', async () => {
    const t = await setup();
    const seojun = await t.loginAs(MOCK.devMember);
    const a = await draft(seojun, '2026-11-12', '2026-11-12', 'full', 'annual', 'gw-same-0001');
    const b = await draft(seojun, '2026-11-12', '2026-11-12', 'full', 'annual', 'gw-same-0001');
    expect((b.body as { doc: GroupwareDoc }).doc.id).toBe((a.body as { doc: GroupwareDoc }).doc.id);
    expect((await inbox(seojun)).mine).toHaveLength(1);
    expect(await draft(seojun, '2026-10-23')).toMatchObject({ status: 400, body: { message: '지난 날은 신청할 수 없어요' } });
    expect(await draft(seojun, '2026-10-31', '2026-11-01')).toMatchObject({ status: 400, body: { message: '고른 날이 모두 주말이에요' } });
    expect(await draft(seojun, '2026-11-12')).toMatchObject({ status: 409, body: { message: '결재 중인 내 신청서와 날이 겹쳐요' } });
    expect(await draft(seojun, '2026-11-13', '2026-11-16', 'am')).toMatchObject({ status: 400, body: { message: '반차는 하루만 고를 수 있어요' } });
    // 하늘은 11월 6일이 이미 근태 기록에 있어요.
    const haneul = await t.loginAs(MOCK.staff);
    expect(await draft(haneul, '2026-11-06')).toMatchObject({ status: 409 });
    // 병가는 지난 3일까지 받아요(금요일 10/23은 받아요).
    expect((await draft(haneul, '2026-10-23', '2026-10-23', 'full', 'sick', requestId(), '병원 진료')).status).toBe(200);
  });

  it('신청서 사유: 병가·공가·경조는 꼭, 연차는 골라서 적어요. 공통 입력 검사를 지나고, 그 문서의 지금 결재자와 기안자에게만 보여요', async () => {
    const t = await setup();
    const seojun = await t.loginAs(MOCK.devMember);
    for (const [type, label] of [
      ['sick', '병가'],
      ['official', '공가'],
      ['family-event', '경조'],
    ] as const) {
      expect(await draft(seojun, '2026-11-12', '2026-11-12', 'full', type), type).toMatchObject({
        status: 400,
        body: { message: `${label} 사유를 적어 주세요` },
      });
      expect(await draft(seojun, '2026-11-12', '2026-11-12', 'full', type, requestId(), '   '), type).toMatchObject({ status: 400 });
    }
    // 등급 3(주민번호)·키 같은 글은 막아요.
    expect(await draft(seojun, '2026-11-12', '2026-11-12', 'full', 'family-event', requestId(), '확인 900101-1234567')).toMatchObject({
      status: 400,
      body: { error: 'locked' },
    });
    // 연차는 사유 없이도 돼요.
    expect((await draft(seojun, '2026-11-13')).status).toBe(200);

    const doc = ((await draft(seojun, '2026-11-12', '2026-11-12', 'full', 'family-event', requestId(), '외조부 장례')).body as { doc: GroupwareDoc }).doc;
    expect(doc).toMatchObject({ type: 'family-event', typeLabel: '경조', reason: '외조부 장례' });
    const lead = await refOf(seojun, '가상 직원 도윤');
    const hr = await refOf(seojun, '가상 인사 지후');
    const otherLead = await refOf(seojun, '가상 직원 지우');
    // 지금 결재자(개발팀 팀장)는 사유를 봐요. 차례가 아닌 인사팀·다른 팀 팀장의 결재함에는 문서가 없어요.
    expect((await inbox(seojun, lead)).waiting.find((d) => d.id === doc.id)?.reason).toBe('외조부 장례');
    expect(JSON.stringify((await inbox(seojun, hr)).waiting)).not.toContain('외조부 장례');
    expect(JSON.stringify((await inbox(seojun, otherLead)).waiting)).not.toContain('외조부 장례');
    // 기안자 본인은 "내가 올린 문서"에서 자기 사유를 봐요.
    expect((await inbox(seojun)).mine.find((d) => d.id === doc.id)?.reason).toBe('외조부 장례');
    // 다른 사람(하늘)의 "내가 올린 문서"에는 없어요.
    const haneul = await t.loginAs(MOCK.staff);
    expect(JSON.stringify(await inbox(haneul))).not.toContain('외조부 장례');
    // 팀장이 승인하면 이제 인사팀 차례라 인사팀이 사유를 보고, 팀장 결재함에서는 빠져요.
    await decide(seojun, doc.id, lead, 'approved');
    expect((await inbox(seojun, hr)).waiting.find((d) => d.id === doc.id)?.reason).toBe('외조부 장례');
    expect(JSON.stringify((await inbox(seojun, lead)).waiting)).not.toContain('외조부 장례');
    // 근태 반영은 날·하루/반차·종류 코드까지만이에요.
    await decide(seojun, doc.id, hr, 'approved');
    const uses = (await t.ctx.adapters.leave.leaveOf({ idpSubject: MOCK.devMember, email: 'seojun@corp.example' }))!.uses;
    expect(uses).toContainEqual({ date: '2026-11-12', kind: 'full', type: 'family-event' });
  });

  it('사유 카나리: 한 줄 데스크 응답·근태 기록·로그·DB 어디에도 사유가 없어요(가상 그룹웨어 메모리에만 있어요)', async () => {
    const lines: string[] = [];
    const t = await createTestApp({ leaveInApp: false, logger: { level: 'debug', stream: { write: (line: string) => void lines.push(line) } } });
    opened.push(t);
    t.ctx.ops.patchValues({ rateLimitPerMinute: 1000 });
    for (const kind of ['rooms', 'navi', 'notices'] as const) await t.modules.find((m) => m.kind === kind)!.seed!();
    const CANARY = 'GWREASONCANARY7Q';
    const seojun = await t.loginAs(MOCK.devMember);
    const doyun = await t.loginAs(MOCK.dev);
    const doc = ((await draft(seojun, '2026-11-05', '2026-11-05', 'am', 'sick', requestId(), `몸살 ${CANARY}`)).body as { doc: GroupwareDoc }).doc;
    await decide(seojun, doc.id, await refOf(seojun, '가상 직원 도윤'), 'approved');
    const done = ((await decide(seojun, doc.id, await refOf(seojun, '가상 인사 지후'), 'approved')).body as { doc: GroupwareDoc }).doc;
    expect(done).toMatchObject({ state: 'approved', recorded: true });

    // 한 줄 데스크 응답: 상태 묻기·남은 연차·바로 하기·같은 팀 일정·회의실 인원·내 문의
    const app = [
      await seojun.call('POST', '/api/home/ask', { text: '내 휴가 신청 어떻게 됐어?' }),
      await seojun.call('POST', '/api/ask', { text: '내 연차 몇 개 남았어?', kind: 'navi' }),
      await seojun.call('POST', '/api/ask', { text: '11월 5일 병가 쓸래', kind: 'navi' }),
      await seojun.call('GET', '/api/navi/leave/start'),
      await seojun.call('GET', '/api/navi/inquiries/mine'),
      await doyun.call('POST', '/api/home/ask', { text: '다음 주 우리 부서 휴가자' }),
      await doyun.call('POST', '/api/ask', { text: '11월 5일 10시 회의실', kind: 'rooms' }),
    ];
    for (const res of app) expect(JSON.stringify(res.body)).not.toContain(CANARY);
    // 같은 팀 일정에는 반영됐지만(오전) 종류·사유는 없어요.
    expect((app[5]!.body as HomeAskResponse).team?.entries).toContainEqual({ name: '가상 직원 서준', date: '2026-11-05', what: 'leave', part: 'am' });
    // 근태 기록·로그·DB
    const record = await t.ctx.adapters.leave.leaveOf({ idpSubject: MOCK.devMember, email: 'seojun@corp.example' });
    expect(JSON.stringify(record)).not.toContain(CANARY);
    expect(record!.uses).toContainEqual({ date: '2026-11-05', kind: 'half', half: 'am', type: 'sick' });
    expect(lines.join('\n')).not.toContain(CANARY);
    const { rows } = await t.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'");
    for (const { table_name } of rows) expect(JSON.stringify((await t.db.query(`select * from ${table_name}`)).rows), table_name).not.toContain(CANARY);
  });

  it('문서는 서버 메모리에 200건까지, 만든 지 7일이 지나면 지워요', () => {
    let now = Date.parse('2026-10-26T09:00:00+09:00');
    const store = new DemoGroupwareStore(() => now);
    const base = {
      drafter: { subject: 's', name: '가상', department: '개발팀' },
      type: 'annual' as const,
      days: [],
      steps: [],
      current: 0,
      state: 'pending' as const,
    };
    for (let i = 0; i < DEMO_GROUPWARE_MAX_DOCS + 5; i += 1) store.add({ ...base, requestKey: `k${i}` });
    expect(store.size).toBe(DEMO_GROUPWARE_MAX_DOCS);
    // 가장 오래된 것부터 지워요.
    expect(store.byRequest('k0')).toBeUndefined();
    expect(store.byRequest(`k${DEMO_GROUPWARE_MAX_DOCS + 4}`)).toBeDefined();
    now += 7 * 24 * 60 * 60 * 1000 + 1;
    store.purge();
    expect(store.size).toBe(0);
  });
});

describe('가상 그룹웨어는 시연에서만 있어요', () => {
  it('운영(시연 아님)에는 API·화면 주소가 없어요(404). 시연은 화면 주소가 index.html이에요', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'desk-gw-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    const db = await createTestDb();
    try {
      const secrets = { SESSION_SECRET: 's'.repeat(40), PSEUDONYM_SECRET: 'p'.repeat(40), PROPOSAL_SECRET: 'q'.repeat(40), MCP_TOKEN_SECRET: 'm'.repeat(40) };
      const prodEnv = {
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://desk.example.com',
        DATABASE_URL: 'postgres://desk@db.example.com/desk',
        TRUST_PROXY: '10.0.3.11',
        DESK_IDP: 'keycloak',
        DESK_IDP_ISSUER: 'https://idp.example.com/realms/desk',
        DESK_IDP_CLIENT_SECRET: 'c'.repeat(40),
        DESK_IDP_DIRECTORY_CLIENT_SECRET: 'd'.repeat(40),
        ...secrets,
      };
      // 모의 직원 명단을 쓰되 고르기 목록이 없는 IdP(운영처럼 리디렉트 로그인만 있다고 쳐요).
      const mock = createMockAdapters();
      const idp = {
        capabilities: { name: 'company-idp', label: '회사 IdP(시험)', mock: false },
        authenticate: (s: string) => mock.employees.authenticate(s),
        isActive: (s: string) => mock.employees.isActive(s),
      };
      const adapters: Adapters = { idp, directory: mock.employees, all: () => [idp.capabilities] };
      const prod = await buildApp({
        config: { ...loadConfig(prodEnv), databaseUrl: undefined },
        db,
        adapters,
        seed: false,
        retentionTimer: false,
        webDir: dist,
      });
      try {
        for (const url of ['/api/demo/groupware/form', '/api/demo/groupware/inbox', '/demo/groupware/leave', '/demo/groupware/inbox']) {
          const res = await prod.app.inject({ method: 'GET', url });
          expect(res.statusCode, url).toBe(404);
          expect(res.body, url).not.toContain('id="root"');
        }
        const post = await prod.app.inject({ method: 'POST', url: '/api/demo/groupware/drafts', payload: {} });
        expect(post.statusCode).toBe(404);
      } finally {
        await prod.app.close();
      }

      const demo = await createTestApp({ leaveInApp: false, webDir: dist });
      opened.push(demo);
      for (const url of ['/demo/groupware/leave?type=annual&from=2026-11-06&to=2026-11-06&half=', '/demo/groupware/inbox']) {
        const res = await demo.app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
        expect(res.body).toContain('id="root"');
      }
      // 로그인하지 않으면 API는 열리지 않아요.
      expect((await demo.app.inject({ method: 'GET', url: '/api/demo/groupware/form' })).statusCode).toBe(401);
    } finally {
      await db.close();
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
