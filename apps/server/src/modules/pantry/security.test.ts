import type { BoardResponse, Card } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AiGateway, FakeProvider, type LlmProvider, type ProviderResult, type StructuredRequest } from '../../core/ai/gateway';
import { createTestApp, MOCK } from '../../testing';
import { OrderService } from './order/service';
import { createBoardService } from './service';
import { fakeUser, postActionOf } from './test-kit';

// 보안·QA 검토(docs/REVIEW.md) H1·H2와 "AI 정리" 표시 시험. 가상 자료와 가상 이름(김가상)만 써요.
// H1: 사람이 쓴 글(요청 글·품목 이름)은 등급 1이라 무보관 계약 전에는 게이트웨이가 거절하고 공급자로 가지 않아요.
// H2: 원문에서 뽑은 이름·막힌 이름은 제안 토큰·plan 행·영수증에 남지 않아요.

/** 받은 요청을 모두 적는 실제 모델 흉내(modelBacked). 답은 부르는 쪽의 결정적 대안이고, 목적별로 바꿔 끼울 수 있어요. */
class RecordingProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  calls: { purpose: string; grade: number; input: string }[] = [];
  constructor(private readonly replies: Record<string, unknown> = {}) {}
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    this.calls.push({ purpose: req.purpose, grade: req.grade, input: req.input });
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

/**
 * contract: 무보관 계약을 확인한 게이트웨이로 바꿔 끼워요(모듈은 ctx.gateway를 부를 때마다 읽어요). 라우터는 계약 전 그대로예요.
 * 돌려주는 provider는 기본 기록용 공급자예요. opts.provider를 넘기면 거기엔 기록이 쌓이지 않아요.
 */
async function setup(opts: { provider?: LlmProvider; contract?: boolean } = {}) {
  const recorder = new RecordingProvider();
  const provider = opts.provider ?? recorder;
  const t = await createTestApp({ provider });
  opened.push(t);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 10_000 });
  if (opts.contract) t.ctx.gateway = new AiGateway(provider, true, t.db);
  const svc = createBoardService(t.ctx);
  await svc.seed({ demoCards: false });
  const me = await t.loginAs(MOCK.staff);
  return { t, svc, me, provider: recorder };
}

async function draft(me: Session, text: string): Promise<Card[]> {
  const res = await me.call('POST', '/api/pantry/draft', { text });
  expect(res.status).toBe(200);
  return res.body.cards as Card[];
}

function expire(t: Test) {
  t.advance((t.ctx.ops.get().values.proposalTtlSeconds + 1) * 1000);
}

async function aiUsageRows(t: Test): Promise<number> {
  return (await t.db.query<{ n: number }>('select count(*)::int as n from ai_usage')).rows[0]!.n;
}

/** 제안 토큰(base64url 본문.서명)을 찾아 본문을 풀어 붙여요. */
function withDecodedTokens(text: string): string {
  let out = text;
  for (const m of text.matchAll(/([A-Za-z0-9_-]{16,})\.([A-Za-z0-9_-]{16,})/g)) out += `\n${Buffer.from(m[1]!, 'base64url').toString('utf8')}`;
  return out;
}

/** DB 모든 표를 JSON으로 덤프하고, 안에 든 토큰도 풀어서 같이 돌려줘요. */
async function dumpDb(t: Test): Promise<string> {
  const { rows: tables } = await t.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'");
  let text = '';
  for (const { table_name } of tables) text += `\n${table_name}: ${JSON.stringify((await t.db.query(`select * from ${table_name}`)).rows)}`;
  return withDecodedTokens(text);
}

describe('[H1] 사람이 쓴 글은 등급 1이라 무보관 계약 전에는 공급자로 가지 않아요', () => {
  it('[H1] 요청 쓰기 칸(POST /api/pantry/draft)의 사람 이름·카나리 글은 공급자 호출 0건이고, 이름 규칙으로 미리보기를 줘요', async () => {
    const { t, me, provider } = await setup();
    const cards = await draft(me, '김가상 과장님 녹차 티백 DRAFTCANARY2 채워 주세요');
    expect(provider.calls).toEqual([]);
    expect(await aiUsageRows(t)).toBe(0);
    expect(cards[0]).toMatchObject({ variant: 'pantry-preview', evidence: { aiSummarized: false } });
  });

  it('[H1] /api/ask에서 탕비실로 간 질문(kind pantry)도 공급자 호출 0건이에요', async () => {
    const { t, me, provider } = await setup();
    const res = await me.call('POST', '/api/ask', { text: '법인카드 분실 ASKCANARY3', kind: 'pantry' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('pantry');
    expect(provider.calls).toEqual([]);
    expect(await aiUsageRows(t)).toBe(0);
  });

  it('[H1·ADR-11] 만료된 게시 토큰에 키 형식·전화번호 이름을 넣어도 공급자를 부르지 않아요', async () => {
    const { t, me, provider } = await setup();
    const action = postActionOf(await draft(me, '보리차 채워 주세요'));
    expire(t);

    const key = await me.call('POST', '/api/plans/direct', { proposalToken: action.proposalToken, edits: { itemName: 'AKIAABCDEFGHIJKLMNOP' } });
    expect(key).toMatchObject({ status: 400, body: { error: 'locked' } });
    expect(JSON.stringify(key.body)).not.toContain('AKIA');

    const phone = await me.call('POST', '/api/plans/direct', { proposalToken: action.proposalToken, edits: { itemName: '보리차 010-9876-5432' } });
    expect(phone.body).toMatchObject({ status: 'expired', message: '시간이 지나 다시 확인해 주세요' });
    expect(phone.body.cards).toHaveLength(1);
    expect(phone.body.cards[0]).toMatchObject({ variant: 'pantry-blocked', label: '막힘', headline: '올릴 수 없는 글자가 있어요: [전화번호]' });
    expect(withDecodedTokens(JSON.stringify(phone.body))).not.toMatch(/9876|보리차/);

    expect(provider.calls).toEqual([]);
    expect(await aiUsageRows(t)).toBe(0);
  });

  it('[H1] 판 품목 이름(총무 제안함 모으기)과 주문안 줄 설명도 계약 전에는 공급자 호출 0건이에요', async () => {
    const { t, svc, provider } = await setup();
    for (const [i, name] of ['제로콜라', '코카콜라 제로 355', '원두'].entries()) {
      const u = fakeUser(`h${i}`);
      await t.ctx.plans.direct(u, postActionOf(await svc.draftForName(u, name)).proposalToken, { itemName: name });
    }
    const facilities = await t.loginAs(MOCK.facilities);
    const collected = await facilities.call('POST', '/api/pantry/suggestions/collect', { floor: '3층' });
    expect(collected.body.suggestions.map((s: { source: string }) => s.source)).toEqual(['rule']);

    const order = new OrderService(t.ctx);
    const fac = fakeUser('fac', { facilities: true });
    const plan = await order.create(fac, 1_000_000);
    const explained = await order.explain(fac, plan.planId);
    expect(explained.lines.every((l) => l.explanationSource === 'template')).toBe(true);

    expect(provider.calls).toEqual([]);
    expect(await aiUsageRows(t)).toBe(0);
  });

  it('[H1] 무보관 계약 뒤에는 등급 1로 보내고, 만료 토큰의 막힌 이름은 계약 뒤에도 보내지 않아요', async () => {
    const { t, me, provider } = await setup({ contract: true });
    const action = postActionOf(await draft(me, '보리차 채워 주세요'));
    expect(provider.calls.map((c) => [c.purpose, c.grade])).toEqual([
      ['draft-item-name', 1],
      ['same-item', 1],
    ]);
    expire(t);
    const sent = provider.calls.length;
    const blocked = await me.call('POST', '/api/plans/direct', { proposalToken: action.proposalToken, edits: { itemName: '김가상 대리 보리차' } });
    expect(blocked.body.cards[0]).toMatchObject({ variant: 'pantry-blocked', headline: '올릴 수 없는 글자가 있어요: [사람 이름]' });
    expect(provider.calls).toHaveLength(sent);

    // 판 검사를 지나는 고친 이름은 다시 찾기에서 같은 품목 비교를 해요(등급 1).
    const fine = await me.call('POST', '/api/plans/direct', { proposalToken: action.proposalToken, edits: { itemName: '보리차 큰 통' } });
    expect(fine.body.cards[0]).toMatchObject({ variant: 'pantry-preview', fields: [{ name: '올라갈 이름', value: '보리차 큰 통' }] });
    expect(provider.calls.slice(sent).map((c) => [c.purpose, c.grade])).toEqual([['same-item', 1]]);
    expect(provider.calls.map((c) => c.input).join('\n')).not.toContain('김가상');
  });
});

describe('[H2] 원문에서 뽑은 이름·막힌 이름은 토큰·plan·영수증에 남지 않아요', () => {
  it('[H2·F3 카나리] 이름을 고쳐 올리고, 막힌 이름(전화번호)으로도 올린 뒤 DB 전체(토큰을 풀어서도)에 원문 조각·카나리·전화번호가 0건이에요', async () => {
    const { t, me } = await setup();

    // 1) 원문 조각이 미리보기 이름으로 나와요(응답에만 있어요). 토큰에는 이름 글자가 없어요.
    const first = postActionOf(await draft(me, '김가상 과장님 부탁 보리차 PLANCANARY9 채워 주세요'));
    expect(first.itemName).toContain('PLANCANARY9');
    expect(withDecodedTokens(first.proposalToken)).not.toMatch(/PLANCANARY9|김가상|보리차/);
    const fixed = await me.call('POST', '/api/plans/direct', { proposalToken: first.proposalToken, edits: { itemName: '보리차' } });
    expect(fixed.body.status).toBe('done');

    // 2) 막힌 이름: 막힘 카드와 [이름 고치기] 토큰에 막힌 이름이 없어요. 같은 토큰을 다시 보내도 영수증 결과 그대로예요.
    const second = postActionOf(await draft(me, '옥수수차 PLANCANARY9 채워 주세요'));
    const blocked = await me.call('POST', '/api/plans/direct', { proposalToken: second.proposalToken, edits: { itemName: '옥수수차 010-9876-5432' } });
    expect(blocked.body).toMatchObject({ status: 'blocked', card: { label: '막힘', headline: '올릴 수 없는 글자가 있어요: [전화번호]' } });
    // 무작위 ID·토큰에 우연히 섞일 수 있는 짧은 숫자 대신 전화번호 전체로 찾아요.
    expect(withDecodedTokens(JSON.stringify(blocked.body))).not.toMatch(/9876-5432|98765432|옥수수차|PLANCANARY9/);
    const replay = await me.call('POST', '/api/plans/direct', { proposalToken: second.proposalToken, edits: { itemName: '옥수수차 010-9876-5432' } });
    expect(replay.body).toEqual(blocked.body);

    const retry = postActionOf([blocked.body.card as Card]);
    expect(retry).toMatchObject({ text: '이름 고치기', itemName: '' });
    const again = await me.call('POST', '/api/plans/direct', { proposalToken: retry.proposalToken, edits: { itemName: '옥수수차' } });
    expect(again.body.status).toBe('done');

    // 3) DB 전체 덤프(토큰을 풀어서도): 카나리·전화번호·원문 조각 0건
    const dump = await dumpDb(t);
    for (const needle of ['PLANCANARY9', '010-9876-5432', '9876-5432', '98765432', '김가상', '과장님']) expect(dump, needle).not.toContain(needle);

    // plan 행: HMAC은 남기지 않고, 막힌 plan에는 이름도 없어요.
    const { rows } = await t.db.query<{ state: string; params: Record<string, unknown> }>("select state, params from plans where module = 'pantry'");
    expect(rows.map((r) => r.state).sort()).toEqual(['blocked', 'done', 'done']);
    for (const r of rows) {
      expect(Object.keys(r.params)).not.toContain('nameMac');
      expect(Object.keys(r.params)).not.toContain('draftName');
      expect('itemName' in r.params, r.state).toBe(r.state === 'done');
    }
    expect((await t.db.query<{ item_name: string }>('select item_name from pantry_cards order by id')).rows.map((r) => r.item_name)).toEqual([
      '보리차',
      '옥수수차',
    ]);
  });

  it('[H2] 이름을 고쳤는지는 HMAC으로만 알아봐요: 안 고치면 초안 때 AI가 맞춘 카탈로그를 쓰고, 고치면 이름 규칙으로 다시 맞춰요', async () => {
    const provider = new RecordingProvider({ 'same-item': { sameIds: [], catalogId: 'cat-green-tea' } });
    const { t, svc } = await setup({ provider, contract: true });
    const [a, b] = [fakeUser('mac1'), fakeUser('mac2')];
    const kept = postActionOf(await svc.draftForName(a, '마카롱'));
    await t.ctx.plans.direct(a, kept.proposalToken, { itemName: '마카롱' });
    const changed = postActionOf(await svc.draftForName(b, '마카롱'));
    await t.ctx.plans.direct(b, changed.proposalToken, { itemName: '마카롱 세트' });
    const { rows } = await t.db.query<{ item_name: string; catalog_item_id: string | null }>('select item_name, catalog_item_id from pantry_cards order by id');
    expect(rows).toEqual([
      { item_name: '마카롱', catalog_item_id: 'cat-green-tea' },
      { item_name: '마카롱 세트', catalog_item_id: null },
    ]);
  });
});

describe('"AI 정리" 표시는 실제 모델이 판단했을 때만이에요', () => {
  /** 탕비실 카드가 나오는 길을 모두 지나며 카드를 모아요: 미리보기·담당 안내·이름 없음·확정·같은 품목·막힘·묻기·만료 다시 찾기. */
  async function collectCards(t: Test, me: Session): Promise<Card[]> {
    const out: Card[] = [];
    const preview = await draft(me, '보리차 채워 주세요');
    out.push(...preview);
    out.push(...(await draft(me, '법인카드 잃어버렸어요')));
    out.push(...(await draft(me, '채워 주세요')));
    const posted = await me.call('POST', '/api/plans/direct', { proposalToken: postActionOf(preview).proposalToken, edits: { itemName: '보리차' } });
    out.push(posted.body.card);
    out.push(...(await draft(me, '보리차 티백 채워 주세요')));
    const blocked = await me.call('POST', '/api/plans/direct', {
      proposalToken: postActionOf(await draft(me, '현미녹차 채워 주세요')).proposalToken,
      edits: { itemName: '현미녹차 010-1111-2222' },
    });
    out.push(blocked.body.card);
    out.push(...((await me.call('POST', '/api/ask', { text: '종이컵 채워 주세요', kind: 'pantry' })).body.cards as Card[]));
    const late = postActionOf(await draft(me, '원두 채워 주세요'));
    expire(t);
    out.push(...((await me.call('POST', '/api/plans/direct', { proposalToken: late.proposalToken, edits: { itemName: '원두' } })).body.cards as Card[]));
    expect(out.map((c) => c.variant ?? c.label)).toEqual(expect.arrayContaining(['pantry-preview', 'pantry-same', 'pantry-blocked', '확정', '안내']));
    return out;
  }

  it('[AI 표시] 가짜 공급자(fake)면 계약 전·후 모두 탕비실 카드에 aiSummarized: true가 0건이에요', async () => {
    for (const contract of [false, true]) {
      const { t, me } = await setup({ provider: new FakeProvider(), contract });
      const cards = await collectCards(t, me);
      expect(cards.filter((c) => c.kind === 'pantry').length).toBeGreaterThanOrEqual(8);
      expect(
        cards.filter((c) => c.evidence.aiSummarized).map((c) => c.id),
        `contract=${contract}`,
      ).toEqual([]);
    }
  });

  it('[AI 표시] 가짜 공급자면 판의 "같은 상품 같아요"에도 AI 정리가 없어요(이름 규칙 표시 행)', async () => {
    const { t, svc, me } = await setup({ provider: new FakeProvider(), contract: true });
    for (const [i, name] of ['제로콜라', '코카콜라 제로 355'].entries()) {
      const u = fakeUser(`s${i}`);
      const cards = await svc.draftForName(u, name);
      await t.ctx.plans.direct(u, postActionOf(cards).proposalToken, { itemName: name });
    }
    const b = (await me.call('GET', '/api/pantry/board')).body as BoardResponse;
    expect(b.items.map((i) => [i.similarTo.length, i.similarByAi])).toEqual([
      [1, false],
      [1, false],
    ]);
  });

  it('[AI 표시] 실제 모델이 계약 뒤 답한 카드만 AI 정리이고, 확정·막힘·게시 직전 재검사 카드와 규칙으로 뽑은 묻기 이름은 아니에요', async () => {
    const { t, me } = await setup({ contract: true });
    const preview = await draft(me, '보리차 채워 주세요');
    expect(preview[0]).toMatchObject({ variant: 'pantry-preview', evidence: { aiSummarized: true } });
    const posted = await me.call('POST', '/api/plans/direct', { proposalToken: postActionOf(preview).proposalToken, edits: { itemName: '보리차' } });
    expect(posted.body.card).toMatchObject({ label: '확정', evidence: { aiSummarized: false } });
    expect((await draft(me, '보리차 티백 채워 주세요'))[0]).toMatchObject({ variant: 'pantry-same', evidence: { aiSummarized: true } });

    // 미리보기를 보는 사이 같은 품목이 올라오면 게시 직전 재검사(이름 규칙) 카드라 AI 정리가 없어요.
    const mine = postActionOf(await draft(me, '원두 채워 주세요'));
    const other = fakeUser('other');
    await t.ctx.plans.direct(other, postActionOf(await createBoardService(t.ctx).draftForName(other, '원두 1kg')).proposalToken, { itemName: '원두 1kg' });
    const raced = await me.call('POST', '/api/plans/direct', { proposalToken: mine.proposalToken, edits: { itemName: '원두' } });
    expect(raced.body.card).toMatchObject({ variant: 'pantry-same', evidence: { aiSummarized: false } });

    // 묻기는 라우터가 규칙으로 뽑았으면(aiParsed=false, 라우터 게이트웨이는 계약 전) 미리보기 이름도 AI 정리가 아니에요.
    const asked = await me.call('POST', '/api/ask', { text: '종이컵 채워 주세요', kind: 'pantry' });
    expect(asked.body.cards[0]).toMatchObject({ variant: 'pantry-preview', evidence: { aiSummarized: false } });
  });
});
