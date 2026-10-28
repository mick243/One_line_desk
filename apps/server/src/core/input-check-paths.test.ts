import { randomUUID } from 'node:crypto';
import type { Card } from '@one-line-desk/shared';
import { QA_LOCKED } from '@one-line-desk/shared/input-check/samples';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postActionOf } from '../modules/pantry/test-kit';
import { createTestApp, MOCK } from '../testing';

// 입력 검사 규칙 2(QA-2·3·10·19, L-39)를 사람이 글을 쓰는 다섯 경로에 같은 표로 돌려요.
// 묻기·문의·판 초안·판 올리기(/api/plans/direct edits)·회의실 채팅(ADR-19). 모두 잠기고, 500은 0건이에요. 제어 문자는 어느 경로든 400이에요.

type Test = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<Test['loginAs']>>;

let t: Test;
let me: Session;
let postToken: string;

beforeAll(async () => {
  t = await createTestApp();
  t.ctx.ops.patchValues({ rateLimitPerMinute: 10_000 });
  for (const kind of ['navi', 'pantry'] as const) await t.modules.find((m) => m.kind === kind)!.seed!();
  me = await t.loginAs(MOCK.dev);
  const draft = await me.call('POST', '/api/pantry/draft', { text: '보리차 채워 주세요' });
  postToken = postActionOf(draft.body.cards as Card[]).proposalToken;
});

afterAll(async () => {
  await t.close();
});

describe('입력 검사 다섯 경로(L-39)', () => {
  it.each(QA_LOCKED)('%s', async (_name, text, kind) => {
    const control = kind === 'control';
    const ask = await me.call('POST', '/api/ask', { text, kind: 'navi' });
    expect(ask.status, 'ask').toBe(control ? 400 : 422);
    const inquiry = await me.call('POST', '/api/navi/inquiries', { rowId: 'FIN-01', question: text, reason: '입력 검사 시험', requestId: randomUUID() });
    expect(inquiry.status, 'inquiry').toBe(400);
    const draft = await me.call('POST', '/api/pantry/draft', { text });
    expect(draft.status, 'draft').toBe(control ? 400 : 422);
    const post = await me.call('POST', '/api/plans/direct', { proposalToken: postToken, edits: { itemName: text } });
    expect(post.status, 'post').toBe(400);
    const chat = await me.call('POST', '/api/rooms/chat', { text, requestId: randomUUID() });
    expect(chat.status, 'chat').toBe(control ? 400 : 422);
    for (const res of [ask, inquiry, draft, post, chat]) expect(res.body.message).not.toContain(text.trim());
  });

  it('잠긴 글은 문의함·판 어디에도 저장되지 않아요', async () => {
    const { rows } = await t.db.query<{ n: number }>(
      "select count(*)::int as n from navi_inquiries where question like '%900101%' or question like '%레르기%'",
    );
    expect(rows[0]!.n).toBe(0);
    const board = await me.call('GET', '/api/pantry/board');
    expect(JSON.stringify(board.body)).not.toMatch(/900101|레르기|\u0000/);
  });

  it('글 방향 문자는 지운 글로 저장해요(QA-19)', async () => {
    const sent = await me.call('POST', '/api/navi/inquiries', { rowId: 'FIN-01', question: '\u202Egnp.exe 끝', reason: '표시 시험', requestId: randomUUID() });
    expect(sent.status).toBe(200);
    const { rows } = await t.db.query<{ question: string }>("select question from navi_inquiries where reason = '표시 시험'");
    expect(rows.map((r) => r.question)).toEqual(['gnp.exe 끝']);
  });

  it('쿼리의 제어 문자도 500 없이 400이에요', async () => {
    const res = await me.call('GET', '/api/pantry/board?floor=%00');
    expect(res.status).toBe(400);
  });
});
