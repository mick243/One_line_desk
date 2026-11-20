import { type Card, PANTRY_TEXT } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AiGateway, type LlmProvider, type ProviderResult, type StructuredRequest } from '../../core/ai/gateway';
import { createTestApp, MOCK } from '../../testing';
import { createBoardService } from './service';
import { fakeUser, type PostAction, postActionOf } from './test-kit';

// 후보 2: 요청 쓰기 칸 한 줄에서 품목을 3개까지 나눠 품목마다 미리보기 카드를 따로 보여 줘요(ADR-04·07·10).
// 초안은 읽기 전용이고, 사람이 품목마다 [올리기]를 눌러요. 이름 검사·표 상한은 품목마다 게시 순간에 다시 봐요.
// 가상 품목 이름과 가상 직원만 써요.

/** 받은 요청을 적는 실제 모델 흉내. 목적별 답이 없으면 부르는 쪽의 결정적 대안을 돌려줘요. */
class RecordingProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  calls: { purpose: string; input: string; maxTokens: number | undefined }[] = [];
  constructor(private readonly replies: Record<string, unknown> = {}) {}
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    this.calls.push({ purpose: req.purpose, input: req.input, maxTokens: req.maxTokens });
    const reply = req.purpose in this.replies ? this.replies[req.purpose] : req.fallback();
    return { output: req.schema.parse(reply), inputTokens: 1, outputTokens: 1 };
  }
}

type Test = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<Test['loginAs']>>;

const opened: Test[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup(opts: { replies?: Record<string, unknown>; contract?: boolean } = {}) {
  const provider = new RecordingProvider(opts.replies);
  const t = await createTestApp({ provider });
  opened.push(t);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 10_000 });
  if (opts.contract) t.ctx.gateway = new AiGateway(provider, true, t.db);
  const svc = createBoardService(t.ctx);
  await svc.seed({ demoCards: false });
  const me = await t.loginAs(MOCK.staff);
  return { t, svc, me, provider };
}

async function draft(me: Session, text: string): Promise<Card[]> {
  const res = await me.call('POST', '/api/pantry/draft', { text });
  expect(res.status).toBe(200);
  return res.body.cards as Card[];
}

/** 카드마다 게시 행동(미리보기 [올리기] 또는 같은 품목 카드 [새 요청으로]) */
const postsOf = (cards: Card[]): PostAction[] => cards.map((c) => postActionOf([c]));

async function count(t: Test, table: string): Promise<number> {
  return (await t.db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;
}

describe('[후보 2] 요청 쓰기 칸 한 줄에서 여러 품목 나누기', () => {
  it('[후보 2·H1] 규칙 길(계약 전): "제로콜라랑 컵라면"은 두 품목의 미리보기 카드 두 장이고, 모델을 부르지 않아요', async () => {
    const { t, me, provider } = await setup();
    const cards = await draft(me, '제로콜라랑 컵라면 넣어 주세요');
    expect(cards.map((c) => c.variant)).toEqual(['pantry-preview', 'pantry-preview']);
    expect(postsOf(cards).map((a) => a.itemName)).toEqual(['제로콜라', '컵라면']);
    expect(new Set(cards.map((c) => c.id)).size).toBe(2);
    expect(cards.every((c) => c.evidence.aiSummarized === false)).toBe(true);
    expect(provider.calls).toEqual([]);
    expect(await count(t, 'ai_usage')).toBe(0);
  });

  it('[후보 2] 규칙 길: 세 품목은 세 장, 넷 이상이면 앞의 셋까지만이에요', async () => {
    const { me } = await setup();
    expect(postsOf(await draft(me, '바나나, 생수하고 원두 채워 주세요')).map((a) => a.itemName)).toEqual(['바나나', '생수', '원두']);
    expect(postsOf(await draft(me, '바나나, 생수, 원두, 종이컵, 녹차 채워 주세요')).map((a) => a.itemName)).toEqual(['바나나', '생수', '원두']);
  });

  it('[후보 2] 쪼개지면 안 되는 이름("호랑이 젤리"·"말랑카우"·"과자"·"와플")은 한 장이에요', async () => {
    const { me } = await setup();
    for (const [text, name] of [
      ['호랑이 젤리 넣어 주세요', '호랑이 젤리'],
      ['말랑카우 채워 주세요', '말랑카우'],
      ['과자 넣어 주세요', '과자'],
      ['와플 요청', '와플'],
      ['사과 주스 넣어 주세요', '사과 주스'],
    ] as const) {
      const cards = await draft(me, text);
      expect(cards, text).toHaveLength(1);
      expect(postActionOf(cards).itemName, text).toBe(name);
    }
  });

  it('[후보 2] 모델 길(계약 뒤): 모델이 나눈 이름마다 카드이고 넷째부터는 버려요. 호출은 이름 뽑기 1 + 같은 상품 비교 3 = 4번이고 모두 답 길이 상한이 있어요', async () => {
    const { me, provider } = await setup({
      contract: true,
      replies: { 'draft-item-name': { pantryRequest: true, itemNames: ['제로콜라', ' 컵라면 ', '녹차 티백', '원두'] } },
    });
    const cards = await draft(me, '제로콜라랑 컵라면이랑 녹차 티백이랑 원두 넣어 주세요');
    expect(postsOf(cards).map((a) => a.itemName)).toEqual(['제로콜라', '컵라면', '녹차 티백']);
    expect(cards.every((c) => c.evidence.aiSummarized)).toBe(true);
    expect(provider.calls.map((c) => c.purpose)).toEqual(['draft-item-name', 'same-item', 'same-item', 'same-item']);
    for (const c of provider.calls) expect(c.maxTokens, c.purpose).toBeGreaterThan(0);
    expect(provider.calls[0]!.maxTokens).toBeLessThanOrEqual(512);
  });

  it('[후보 2] 모델이 같은 상품 이름을 두 번 주거나 빈·너무 긴 이름을 주면 버려요', async () => {
    const { me } = await setup({
      contract: true,
      replies: { 'draft-item-name': { pantryRequest: true, itemNames: ['원두', '원두 1kg', '', '가'.repeat(41), '생수'] } },
    });
    expect(postsOf(await draft(me, '원두랑 생수')).map((a) => a.itemName)).toEqual(['원두', '생수']);
  });

  it('[후보 2·ADR-04] 여러 품목 초안도 판 표·plan·영수증에 아무것도 쓰지 않고, 쓴 글은 DB 어디에도 없어요', async () => {
    const { t, me } = await setup({ contract: true });
    const canary = '나누기카나리QZ7';
    const cards = await draft(me, `바나나랑 생수하고 원두 ${canary} 채워 주세요`);
    expect(cards).toHaveLength(3);
    for (const table of ['pantry_cards', 'pantry_votes', 'pantry_similar_flags', 'plans', 'action_receipts']) expect(await count(t, table), table).toBe(0);
    const { rows: tables } = await t.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'");
    for (const { table_name } of tables) {
      expect(JSON.stringify((await t.db.query(`select * from ${table_name}`)).rows), table_name).not.toContain(canary);
    }
  });

  it('[후보 2·R14] 표 상한은 품목마다 게시 순간에 다시 봐요: 상한 1이면 첫 품목은 올라가고 둘째는 막혀요', async () => {
    const { t, me } = await setup();
    const facilities = await t.loginAs(MOCK.facilities);
    expect(
      (await facilities.call('PUT', `/api/pantry/settings/${encodeURIComponent('3층')}`, { minShareWon: 0, perPersonLimit: 1, cycleNote: '' })).status,
    ).toBe(200);
    const [first, second] = postsOf(await draft(me, '바나나랑 생수 채워 주세요'));
    const one = await me.call('POST', '/api/plans/direct', { proposalToken: first!.proposalToken, edits: { itemName: first!.itemName } });
    expect(one.body.status).toBe('done');
    const two = await me.call('POST', '/api/plans/direct', { proposalToken: second!.proposalToken, edits: { itemName: second!.itemName } });
    expect(two).toMatchObject({ status: 409, body: { error: 'vote-limit', message: PANTRY_TEXT.postLimit } });
    expect((await t.db.query<{ item_name: string }>('select item_name from pantry_cards')).rows.map((r) => r.item_name)).toEqual(['바나나']);
  });

  it('[후보 2·ADR-04] 이름 검사도 품목마다예요: 고친 이름에 전화번호가 든 품목만 막히고 다른 품목은 올라가요', async () => {
    const { t, me } = await setup();
    const [first, second] = postsOf(await draft(me, '바나나랑 생수 채워 주세요'));
    const blocked = await me.call('POST', '/api/plans/direct', { proposalToken: first!.proposalToken, edits: { itemName: '바나나 010-1234-5678' } });
    expect(blocked.body).toMatchObject({ status: 'blocked', card: { label: '막힘', headline: '올릴 수 없는 글자가 있어요: [전화번호]' } });
    const ok = await me.call('POST', '/api/plans/direct', { proposalToken: second!.proposalToken, edits: { itemName: second!.itemName } });
    expect(ok.body.status).toBe('done');
    expect((await t.db.query<{ item_name: string }>('select item_name from pantry_cards')).rows.map((r) => r.item_name)).toEqual(['생수']);
  });

  it('[후보 2·QA-26] 사람 이름이 든 품목은 그 카드만 막힘 이유를 싣고, 그 이름은 같은 상품 비교(모델)로 보내지 않아요', async () => {
    const { me, provider } = await setup({
      contract: true,
      replies: { 'draft-item-name': { pantryRequest: true, itemNames: ['하늘님이 좋아하는 커피', '생수'] } },
    });
    const cards = await draft(me, '하늘님이 좋아하는 커피랑 생수 채워 주세요');
    const [first, second] = postsOf(cards);
    expect(first!.nameBlock).toEqual({ kinds: ['person'], message: '올릴 수 없는 글자가 있어요: [사람 이름]' });
    expect(second!.nameBlock).toBeUndefined();
    const sameItem = provider.calls.filter((c) => c.purpose === 'same-item');
    expect(sameItem).toHaveLength(1);
    expect(sameItem[0]!.input).not.toContain('하늘');
  });

  it('[후보 2] 두 품목이 같은 열린 품목을 가리켜도 카드 ID는 겹치지 않아요(같은 품목 카드 두 장)', async () => {
    const { t, svc, me } = await setup();
    const other = fakeUser('split-a');
    await t.ctx.plans.direct(other, postActionOf(await svc.draftForName(other, '코카콜라 제로 355')).proposalToken, { itemName: '코카콜라 제로 355' });
    const cards = await draft(me, '제로콜라랑 콜라 제로 캔 넣어 주세요');
    expect(cards.map((c) => c.variant)).toEqual(['pantry-same', 'pantry-same']);
    expect(new Set(cards.map((c) => c.id)).size).toBe(2);
  });

  it('[후보 2] 묻기(/ask) 길은 그대로 이름 하나예요', async () => {
    const { me } = await setup();
    const res = await me.call('POST', '/api/ask', { text: '바나나 채워 주세요', kind: 'pantry' });
    expect(res.body.cards).toHaveLength(1);
    expect(postActionOf(res.body.cards).itemName).toBe('바나나');
  });
});
