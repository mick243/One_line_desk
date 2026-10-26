import type { AskResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { ALLOWED_BOARDS, MOCK_BOARD, NOTICE_BODY_CANARY } from './fixtures';
import { createNoticesService, indexNotice } from './service';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

// 시험마다 새 PGlite를 띄워요. 전체 시험을 함께 돌리면 기본 5초를 넘길 때가 있어서 넉넉히 둬요.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  for (const m of t.modules) if (m.kind === 'notices' || m.kind === 'navi') await m.seed?.();
  return t;
}

/** 공지 본문에서 뽑은 문장 조각. 응답·DB에 하나라도 있으면 본문이 샌 거예요. */
const BODY_PIECES = MOCK_BOARD.flatMap((n) => n.body.split(/[.。]\s*/).filter((s) => s.length >= 12));

async function count(t: TestApp, table: string): Promise<number> {
  return ((await t.db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n ?? 0) as number;
}

describe('[F1-7] 공지 찾기', () => {
  it('[F1-7] 공지 질문은 제목·게시일·원문 링크만 든 공지 카드를 줘요(본문·요약·AI 정리 없음)', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const res = await me.call('POST', '/api/ask', { text: '건강검진 공지 언제였지' });
    expect(res.status).toBe(200);
    const body = res.body as AskResponse;
    expect(body.kind).toBe('notices');
    expect(body.cards).toEqual([
      {
        id: 'notice-N-1002',
        kind: 'notices',
        label: '안내',
        headline: '공지에서 찾았어요',
        fields: [
          { name: '제목', value: '하반기 건강검진 일정 안내' },
          { name: '게시일', value: '2026-10-14' },
        ],
        evidence: { text: '공지 원문 · 전사 공지', href: 'https://groupware.example.com/board/notice/1002', aiSummarized: false },
        actions: { primary: { type: 'link', text: '원문 열기', href: 'https://groupware.example.com/board/notice/1002' }, secondary: [] },
        wrong: { predictedKind: 'notices', candidates: [] },
        tail: '질문 원문은 저장하지 않아요',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(NOTICE_BODY_CANARY);
    for (const piece of BODY_PIECES) expect(JSON.stringify(body)).not.toContain(piece);
    const { rows } = await t.db.query<{ result: string }>('select result from audit_log order by id desc limit 1');
    expect(rows[0]!.result).toBe('card');
  });

  it('[F1-7] 못 찾으면 "공지에서 찾지 못했어요" 카드와 [담당 찾기에서 찾기]예요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const body = (await me.call('POST', '/api/ask', { text: '강아지 분양 공지 있어?' })).body as AskResponse;
    expect(body.cards).toEqual([
      expect.objectContaining({
        id: 'notices-not-found',
        kind: 'notices',
        headline: '공지에서 찾지 못했어요',
        evidence: { text: '찾아본 범위: 전사 공지 · 총무 안내', aiSummarized: false },
        actions: { primary: { type: 'reask', text: '담당 찾기에서 찾기', kind: 'navi' }, secondary: [] },
      }),
    ]);
    const { rows } = await t.db.query<{ module: string; result: string }>('select module, result from audit_log order by id desc limit 1');
    expect(rows[0]).toEqual({ module: 'notices', result: 'not-found' });
  });

  it('[ADR-14 시험] 허용 밖 게시판 공지는 색인에 없고 찾아지지도 않아요', async () => {
    const t = await setup();
    expect(await count(t, 'notices')).toBe(MOCK_BOARD.filter((n) => (ALLOWED_BOARDS as readonly string[]).includes(n.board)).length);
    expect((await t.db.query("select * from notices where board = '인사 발령'")).rows).toEqual([]);
    const me = await t.loginAs(MOCK.staff);
    const body = (await me.call('POST', '/api/ask', { text: '정기 인사 발령 공지' })).body as AskResponse;
    expect(body.cards[0]!.id).toBe('notices-not-found');
    expect(JSON.stringify(body)).not.toContain('가상 인물');
  });

  it('[ADR-10] 공지 본문은 DB에 남지 않고 색인 조각만 있어요', async () => {
    const t = await setup();
    const { rows } = await t.db.query('select * from notices');
    const json = JSON.stringify(rows);
    expect(json).not.toContain(NOTICE_BODY_CANARY);
    for (const piece of BODY_PIECES) expect(json).not.toContain(piece);
    expect(Object.keys(rows[0]!).sort()).toEqual(['board', 'id', 'posted_on', 'terms', 'title', 'url']);
  });

  it('가상 공지는 비어 있을 때 한 번만 들어가요', async () => {
    const t = await setup();
    const before = await count(t, 'notices');
    for (const m of t.modules) if (m.kind === 'notices') await m.seed?.();
    expect(await count(t, 'notices')).toBe(before);
  });
});

describe('[F1-11·MCP] notices_search(ctx.services.notices)', () => {
  it('[MCP 완료 기준] 본문을 넣은 공지로 불러도 응답은 제목·게시일·원문 링크·게시판뿐이고 카나리 0건이에요', async () => {
    const t = await setup();
    const notices = t.ctx.services.notices!;
    for (const q of ['건강검진', NOTICE_BODY_CANARY, '복지몰 검진 기관 예약', '와이파이']) {
      const res = await notices.search(q, 5);
      expect(res.mock).toBe(true);
      for (const hit of res.hits) expect(Object.keys(hit).sort()).toEqual(['board', 'id', 'postedOn', 'title', 'url']);
      const json = JSON.stringify(res);
      expect(json).not.toContain(NOTICE_BODY_CANARY);
      for (const piece of BODY_PIECES) expect(json).not.toContain(piece);
    }
    expect((await notices.search('건강검진', 5)).hits.map((h) => h.id)).toEqual(['N-1002']);
  });

  it('[MCP 완료 기준] 허용 밖 게시판 공지는 0건이에요', async () => {
    const t = await setup();
    const notices = t.ctx.services.notices!;
    for (const q of ['인사 발령', '신규 입사자 소개', '가상 인물', '재무팀장']) {
      const res = await notices.search(q, 10);
      expect(res.hits.filter((h) => !(ALLOWED_BOARDS as readonly string[]).includes(h.board))).toEqual([]);
      expect(res.hits.map((h) => h.id).filter((id) => id.startsWith('N-9'))).toEqual([]);
    }
  });

  it('[MCP 완료 기준] 찾기는 LLM을 부르지 않고 DB에 쓰지 않아요', async () => {
    const t = await setup();
    const tables = ['ai_usage', 'audit_log', 'notices', 'navi_feedback', 'plans', 'action_receipts'];
    const before = await Promise.all(tables.map((x) => count(t, x)));
    await t.ctx.services.notices!.search('주차 등록', 3);
    await t.ctx.services.notices!.search('소방 훈련', 3);
    expect(await Promise.all(tables.map((x) => count(t, x)))).toEqual(before);
  });

  it('[ADR-14] 검색어 길이와 돌려주는 수를 제한해요', async () => {
    const t = await setup();
    const notices = t.ctx.services.notices!;
    const long = await notices.search('안내 '.repeat(500), 1000);
    expect(long.hits.length).toBeLessThanOrEqual(10);
    expect((await notices.search('공지 안내', 5)).hits).toEqual([]);
    expect((await notices.search('', 5)).hits).toEqual([]);
    const two = await notices.search('정기', 2);
    expect(two.hits.length).toBeLessThanOrEqual(2);
  });

  it('[ADR-14] 내보내는 제목은 제어 문자를 지우고 길이를 잘라요', async () => {
    const t = await createTestApp();
    opened.push(t);
    const svc = createNoticesService(t.ctx);
    await svc.seed([
      {
        id: 'N-5001',
        board: '전사 공지',
        title: `주차\u0007 안내 ${'가'.repeat(150)}`,
        postedOn: '2026-10-01',
        url: 'https://groupware.example.com/board/notice/5001',
        body: '주차 본문',
      },
      { id: 'N-5002', board: '전사 공지', title: '링크가 이상한 공지', postedOn: '2026-10-01', url: 'javascript:alert(1)', body: '주차' },
    ]);
    const res = await svc.search('주차', 5);
    expect(res.hits.map((h) => h.id)).toEqual(['N-5001']);
    expect(res.hits[0]!.title).not.toContain('\u0007');
    expect(res.hits[0]!.title.length).toBeLessThanOrEqual(120);
  });

  it('허용 밖 게시판·잘못된 링크는 색인하지 않아요', () => {
    expect(indexNotice({ id: 'x', board: '인사 발령', title: 't', postedOn: '2026-10-01', url: 'https://a.example/1', body: 'b' })).toBeNull();
    expect(indexNotice({ id: 'x', board: '전사 공지', title: 't', postedOn: '2026-10-01', url: 'ftp://a.example/1', body: 'b' })).toBeNull();
    expect(indexNotice({ id: 'x', board: '전사 공지', title: 't', postedOn: '2026-10-01', url: 'https://a.example/1', body: 'b' })).not.toBeNull();
  });
});
