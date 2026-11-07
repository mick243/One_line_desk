import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DemoBoardPostResponse,
  type DemoBoardResponse,
  NOTICE_AUDIENCE_TEXT,
  type NoticeAudienceListResponse,
  type NotificationsResponse,
} from '@one-line-desk/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Adapters, createMockAdapters } from '../adapters';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { createTestDb } from '../core/db/test-db';
import { createTestApp, MOCK } from '../testing';
import { DEMO_BOARD_MAX_POSTS, DemoBoardStore } from './demo-groupware-board';

// 시연 전용 가상 그룹웨어 게시판(11/6 새 공지 알림 대상). 올리면 한 줄 데스크 공지 사본에 들어가고 → AI(계약 전이면 규칙)가 대상 제안 →
// 총무 확인 → 대상자 알림까지 한 바퀴예요. 운영에는 경로가 없어요(404).

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 1000 });
  await t.modules.find((m) => m.kind === 'notices')!.seed!();
  return t;
}

let n = 0;
const requestId = () => `board-req-${(n += 1).toString().padStart(4, '0')}`;
const BODY = '3층 화장실은 11월 9일 하루 공사로 쓸 수 없어요. 2층이나 4층 화장실을 써 주세요. 문의는 총무팀으로 해 주세요.';

describe('가상 그룹웨어 게시판 → 공지 사본 → 대상 제안 → 총무 확인 → 알림', () => {
  it('올리면 공지 사본에 들어오고(본문은 DB에 없음), 총무가 확인하면 대상자에게만 알림이 가요', async () => {
    const t = await setup();
    const haneul = await t.loginAs(MOCK.staff);
    const res = await haneul.call('POST', '/api/demo/groupware/board/posts', { title: '3층 화장실 공사 안내', body: BODY, requestId: requestId() });
    expect(res.status).toBe(200);
    const posted = res.body as DemoBoardPostResponse;
    expect(posted.copy).toEqual({ copied: true, audience: 'pending' });
    expect(posted.post).toMatchObject({
      title: '3층 화장실 공사 안내',
      body: BODY,
      postedOn: '2026-10-26',
    });
    expect(posted.post.id).toMatch(/^GB-[0-9a-f]{8}$/);
    // 시연 무대로만 둬요(11/6): 올린 사람 이름은 게시 글에 없어요.
    expect(Object.keys(posted.post).sort()).toEqual(['body', 'createdAt', 'id', 'postedOn', 'title']);
    expect(JSON.stringify(posted)).not.toContain('가상 직원 하늘');

    // 게시판 목록(새 글 먼저)
    const board = (await haneul.call('GET', '/api/demo/groupware/board')).body as DemoBoardResponse;
    expect(board.posts.map((p) => p.id)).toEqual([posted.post.id]);

    // 한 줄 데스크 공지 사본: 제목·게시일·원문 링크·색인 조각만이고 본문 글은 없어요.
    const copy = (await t.db.query<Record<string, unknown>>('select * from notices where id = $1', [posted.post.id])).rows[0]!;
    expect(copy).toMatchObject({ board: '전사 공지', title: '3층 화장실 공사 안내', url: `http://localhost:5190/demo/groupware/board?post=${posted.post.id}` });
    const dump = JSON.stringify((await t.db.query('select * from notices')).rows) + JSON.stringify((await t.db.query('select * from notice_audience')).rows);
    for (const sentence of BODY.split(/(?<=요\.)\s*/).filter(Boolean)) expect(dump).not.toContain(sentence.replace(/\.$/, ''));
    // 공지 찾기에서 바로 찾아져요.
    expect((await t.ctx.services.notices!.search('화장실 공사', 3)).hits.map((h) => h.id)).toEqual([posted.post.id]);

    // 총무 확인: 계약 전이라 규칙 제안(3층). 문의처 문장의 총무팀은 대상이 아니에요.
    const seoyeon = await t.loginAs(MOCK.facilities);
    expect(((await seoyeon.call('GET', '/api/notifications')).body as NotificationsResponse).items.map((i) => i.title)).toEqual([
      NOTICE_AUDIENCE_TEXT.notifyReview,
    ]);
    const item = ((await seoyeon.call('GET', '/api/notices/audience')).body as NoticeAudienceListResponse).items[0]!;
    expect(item).toMatchObject({
      notice: { id: posted.post.id },
      audience: { everyone: false, departments: [], floors: ['3층', '2층', '4층'] },
      state: 'pending',
    });
    // 3층(4명) + 2층(서연·지후·은우) + 4층(민준·다인·하린) = 10명
    expect(item.count).toBe(10);

    // [대상 바꾸기]로 3층만 고쳐 보내요.
    const sent = await seoyeon.call('POST', `/api/notices/audience/${item.id}/send`, {
      audience: { everyone: false, departments: [], floors: ['3층'], roles: [] },
    });
    expect(sent.body).toMatchObject({ state: 'sent', sent: 4 });
    const bell = ((await haneul.call('GET', '/api/notifications')).body as NotificationsResponse).items;
    expect(bell.map((i) => [i.title, i.page])).toEqual([[NOTICE_AUDIENCE_TEXT.notifyTarget, 'notices']]);
    const doyun = await t.loginAs(MOCK.dev);
    expect(((await doyun.call('GET', '/api/notifications')).body as NotificationsResponse).items).toEqual([]);
  });

  it('방문자가 올린 공지 사본은 게시일 7일 뒤 지워지고(알림 대상 줄도), 회사 게시판 사본은 남아요. 넓게 연 시연에서는 올리지 않아요', async () => {
    const t = await setup();
    const haneul = await t.loginAs(MOCK.staff);
    const posted = (await haneul.call('POST', '/api/demo/groupware/board/posts', { title: '3층 화장실 공사 안내', body: BODY, requestId: requestId() }))
      .body as DemoBoardPostResponse;
    const count = async (sql: string) => Number((await t.db.query<{ n: number }>(sql)).rows[0]!.n);
    const seeded = await count("select count(*)::int as n from notices where not starts_with(id, 'GB-')");
    expect(seeded).toBeGreaterThan(0);

    t.advance(6 * 24 * 3600_000);
    await t.runRetention();
    expect(await count(`select count(*)::int as n from notices where id = '${posted.post.id}'`)).toBe(1);

    t.advance(2 * 24 * 3600_000);
    await t.runRetention();
    expect(await count(`select count(*)::int as n from notices where id = '${posted.post.id}'`)).toBe(0);
    expect(await count('select count(*)::int as n from notice_audience')).toBe(0);
    expect(await count("select count(*)::int as n from notices where not starts_with(id, 'GB-')")).toBe(seeded);
    expect((await t.ctx.services.notices!.search('화장실 공사', 3)).hits).toEqual([]);

    t.ctx.config.demoWide = true;
    // 8일이 지나 세션이 끊겼어요. 다시 들어와요.
    const again = await t.loginAs(MOCK.staff);
    const locked = await again.call('POST', '/api/demo/groupware/board/posts', { title: '공지', body: '내용이에요', requestId: requestId() });
    expect(locked.status).toBe(409);
    expect(locked.body).toMatchObject({ error: 'demo-locked' });
  });

  it('같은 요청 번호로 두 번 올려도 한 번만 올라가요. 잠기는 글자가 있으면 올리지 않고 사본에도 들어가지 않아요', async () => {
    const t = await setup();
    const haneul = await t.loginAs(MOCK.staff);
    const id = requestId();
    const first = await haneul.call('POST', '/api/demo/groupware/board/posts', {
      title: '연말 행사 안내',
      body: '전 직원 연말 행사는 12월 20일이에요.',
      requestId: id,
    });
    const again = await haneul.call('POST', '/api/demo/groupware/board/posts', {
      title: '연말 행사 안내',
      body: '전 직원 연말 행사는 12월 20일이에요.',
      requestId: id,
    });
    expect(again.body).toEqual(first.body);
    expect(((await haneul.call('GET', '/api/demo/groupware/board')).body as DemoBoardResponse).posts).toHaveLength(1);
    expect(Number((await t.db.query<{ n: number }>('select count(*)::int as n from notice_audience')).rows[0]!.n)).toBe(1);

    const before = Number((await t.db.query<{ n: number }>('select count(*)::int as n from notices')).rows[0]!.n);
    const locked = await haneul.call('POST', '/api/demo/groupware/board/posts', {
      title: '계정 안내',
      body: '비밀번호: hunter2 로 들어오세요',
      requestId: requestId(),
    });
    expect(locked.status).toBe(400);
    const empty = await haneul.call('POST', '/api/demo/groupware/board/posts', { title: ' ', body: '본문', requestId: requestId() });
    expect(empty.status).toBe(400);
    // 게시판 고르기·수정·삭제 같은 게시판 기능은 없어요(11/6 사용자 결정: 시연 무대로만). 모르는 칸은 400이에요.
    expect((await haneul.call('POST', '/api/demo/groupware/board/posts', { board: '인사 발령', title: 't', body: 'b', requestId: requestId() })).status).toBe(
      400,
    );
    for (const method of ['PUT', 'DELETE'] as const) expect((await haneul.call(method, '/api/demo/groupware/board/posts')).status).toBe(404);
    expect(Number((await t.db.query<{ n: number }>('select count(*)::int as n from notices')).rows[0]!.n)).toBe(before);
    // 이메일은 가린 글로 올라가요.
    const masked = (
      await haneul.call('POST', '/api/demo/groupware/board/posts', {
        title: '복지 문의 창구',
        body: '복지 문의는 welfare@corp.example 로 보내 주세요.',
        requestId: requestId(),
      })
    ).body as DemoBoardPostResponse;
    expect(masked.post.body).toBe('복지 문의는 [이메일] 로 보내 주세요.');
  });

  it('게시 글은 메모리에 상한까지만 두고 7일 지나면 지워요', () => {
    let now = Date.parse('2026-10-26T09:00:00+09:00');
    const store = new DemoBoardStore(() => now);
    const post = (i: number) => ({
      id: `GB-${i}`,
      title: `글 ${i}`,
      body: '본문',
      postedOn: '2026-10-26',
      createdAt: '',
      at: now,
      requestKey: `k${i}`,
      copy: { copied: false, audience: null },
    });
    for (let i = 0; i < DEMO_BOARD_MAX_POSTS + 5; i += 1) store.add(post(i));
    expect(store.size).toBe(DEMO_BOARD_MAX_POSTS);
    expect(store.all()[0]!.id).toBe('GB-5');
    now += 8 * 24 * 60 * 60 * 1000;
    store.purge();
    expect(store.size).toBe(0);
  });
});

describe('가상 그룹웨어 게시판은 시연에서만 있어요', () => {
  it('운영(시연 아님)에는 API·화면 주소가 없어요(404). 시연은 화면 주소가 index.html이고, 로그인해야 API가 열려요', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'desk-board-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    const db = await createTestDb();
    try {
      const prodEnv = {
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://desk.example.com',
        DATABASE_URL: 'postgres://desk@db.example.com/desk',
        TRUST_PROXY: '10.0.3.11',
        DESK_IDP: 'keycloak',
        DESK_IDP_ISSUER: 'https://idp.example.com/realms/desk',
        DESK_IDP_CLIENT_SECRET: 'c'.repeat(40),
        DESK_IDP_DIRECTORY_CLIENT_SECRET: 'd'.repeat(40),
        SESSION_SECRET: 's'.repeat(40),
        PSEUDONYM_SECRET: 'p'.repeat(40),
        PROPOSAL_SECRET: 'q'.repeat(40),
        MCP_TOKEN_SECRET: 'm'.repeat(40),
      };
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
        for (const url of ['/api/demo/groupware/board', '/demo/groupware/board', '/demo/groupware/board?post=GB-00000000']) {
          const res = await prod.app.inject({ method: 'GET', url });
          expect(res.statusCode, url).toBe(404);
          expect(res.body, url).not.toContain('id="root"');
        }
        expect((await prod.app.inject({ method: 'POST', url: '/api/demo/groupware/board/posts', payload: {} })).statusCode).toBe(404);
        // 운영에서도 공지 알림 대상 경로는 있어요(총무만, 로그인 필요).
        expect((await prod.app.inject({ method: 'GET', url: '/api/notices/audience' })).statusCode).toBe(401);
      } finally {
        await prod.app.close();
      }

      const demo = await createTestApp({ webDir: dist });
      opened.push(demo);
      const res = await demo.app.inject({ method: 'GET', url: '/demo/groupware/board?post=GB-00000000' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('id="root"');
      expect((await demo.app.inject({ method: 'GET', url: '/api/demo/groupware/board' })).statusCode).toBe(401);
    } finally {
      await db.close();
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
