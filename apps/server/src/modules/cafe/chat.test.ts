import type { Card, HomeAskResponse, PlanConfirmResponse, PlanCreateResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AiGateway, FakeProvider, type LlmProvider, type ProviderResult, type StructuredRequest } from '../../core/ai/gateway';
import { interpretByRules } from '../../core/home';
import { createTestApp, MOCK } from '../../testing';
import { linesByRules, menuWords, pickupByRules } from './chat';
import { CAFE_MENU_FIXTURES } from './fixtures';

// F4 사내 카페 3묶음(11/6, PRD F4-1·F4-13, ADR-29·ADR-10·ADR-18·ADR-27): 홈 채팅 주문과 "이번 달 커피값".
// - 주문 문장은 [확인하고 주문하기] 카드만 줘요(제안 토큰). 누르면 기존 확인 시트이고, 자동 실행은 없어요(돈).
// - 모델에는 질문 글과 메뉴 이름·옵션 이름만 가요. 금액·청구·내 주문은 가지 않아요. 원문은 어디에도 남지 않아요.
// - 커피값은 서버가 본인 주문·청구서로 계산한 카드예요. 모델에는 질문 글만 가요.
// 시계는 2026-10-26(월) 13:00(한국)이에요. 고를 수 있는 픽업 칸은 13:10~15:00이에요.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const START = Date.parse('2026-10-26T13:00:00+09:00');
const MENU = CAFE_MENU_FIXTURES.map((m) => ({ id: m.id, name: m.name, options: m.options }));
const WORDS = menuWords(MENU);

/** 게이트웨이가 공급자에 넘긴 입력을 적어 두는 시험용 공급자. 목적마다 정해 둔 답을 줘요(없으면 부른 쪽 대안). */
class RecordingProvider implements LlmProvider {
  readonly inputs: { purpose: string; input: string; system: string; grade: number }[] = [];
  constructor(
    readonly name: 'fake' | 'anthropic',
    private readonly answers: Record<string, unknown> = {},
  ) {}
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    this.inputs.push({ purpose: req.purpose, input: req.input, system: req.system, grade: req.grade });
    const out = req.purpose in this.answers ? this.answers[req.purpose] : req.fallback();
    return { output: req.schema.parse(out), inputTokens: 1, outputTokens: 1 };
  }
}

async function setup(o: { contract?: boolean; provider?: LlmProvider; on?: 'on' | 'off' | 'link'; open?: boolean; lines?: string[] } = {}) {
  const t = await createTestApp({
    start: START,
    ...(o.provider ? { provider: o.provider } : {}),
    ...(o.lines ? { logger: { level: 'debug', stream: { write: (line: string) => void o.lines!.push(line) } } } : {}),
  });
  opened.push(t);
  t.ctx.gateway = new AiGateway(o.provider ?? new FakeProvider(), o.contract ?? false, t.db);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 1000 });
  for (const kind of ['rooms', 'navi', 'pantry', 'notices', 'cafeteria'] as const) await t.modules.find((m) => m.kind === kind)!.seed!();
  await t.ctx.ops.setModule('p_test-operator', 'cafeteria', o.on ?? 'on');
  const staff = await t.loginAs(MOCK.staff);
  const barista = await t.loginAs(MOCK.barista);
  if ((o.on ?? 'on') === 'on' && (o.open ?? true)) expect((await barista.call('POST', '/api/cafe/board/open')).status).toBe(200);
  return { t, staff, barista };
}

async function home(me: Session, text: string): Promise<HomeAskResponse> {
  const res = await me.call('POST', '/api/home/ask', { text });
  expect(res.status).toBe(200);
  return res.body;
}

async function counts(t: TestApp) {
  const orders = (await t.db.query<{ n: number }>('select count(*)::int as n from cafe_orders')).rows[0]!.n;
  const plans = (await t.db.query<{ n: number }>("select count(*)::int as n from plans where module = 'cafeteria'")).rows[0]!.n;
  return { orders, plans };
}

/** 카페 페이지 [주문하기]와 같은 길로 주문해요(확인 시트 → 주문하기). */
async function order(me: Session, lines: { menuId: string; qty: number; options: string[] }[]) {
  const slot = (await me.call('GET', '/api/cafe')).body.slots[0].start as string;
  const p = await me.call('POST', '/api/cafe/order/propose', { lines, pickupSlot: slot });
  const created = (await me.call('POST', '/api/plans', { proposalToken: p.body.proposalToken })).body as Extract<PlanCreateResponse, { status: 'sheet' }>;
  const done = (await me.call('POST', `/api/plans/${created.planId}/confirm`)).body as PlanConfirmResponse;
  expect(done.status).toBe('done');
}

const proposeOf = (card: Card) => {
  const primary = card.actions.primary;
  if (primary?.type !== 'propose') throw new Error('주문 버튼이 없어요');
  return primary;
};

describe('[F4-1] 주문 문장 나누기(낱말 규칙)', () => {
  it('[F4-1] "2시에 아아 하나 연하게"를 메뉴·옵션·잔 수·픽업 시각으로 나눠요(모델 없이도)', () => {
    expect(linesByRules('2시에 아아 하나 연하게', MENU)).toEqual([{ menuId: 'americano', qty: 1, options: ['아이스', '연하게'] }]);
    expect(pickupByRules('2시에 아아 하나 연하게')).toEqual({ kind: 'at', minutes: 14 * 60 });
  });

  it('[F4-1] 여러 메뉴·별칭·잔 수·옵션·시각 표현을 읽어요', () => {
    expect(linesByRules('아이스 아메리카노 두 잔이랑 따뜻한 라떼 하나', MENU)).toEqual([
      { menuId: 'americano', qty: 2, options: ['아이스'] },
      { menuId: 'latte', qty: 1, options: ['핫'] },
    ]);
    expect(linesByRules('바닐라라떼 3잔 샷 추가해 줘', MENU)).toEqual([{ menuId: 'vanilla-latte', qty: 3, options: ['샷 추가'] }]);
    expect(linesByRules('녹차라떼 하나, 뜨아 하나', MENU)).toEqual([
      { menuId: 'green-tea-latte', qty: 1, options: [] },
      { menuId: 'americano', qty: 1, options: ['핫'] },
    ]);
    // "아이스티"의 "아이스"는 옵션이 아니에요. 같은 메뉴·옵션은 잔 수를 더해요.
    expect(linesByRules('아이스티 하나랑 아이스티 하나', MENU)).toEqual([{ menuId: 'iced-tea', qty: 2, options: [] }]);
    // 메뉴가 고를 수 없는 옵션은 버려요(콜드브루에는 핫이 없어요).
    expect(linesByRules('따뜻한 콜드브루', MENU)).toEqual([{ menuId: 'cold-brew', qty: 1, options: [] }]);
    expect(linesByRules('점심 메뉴 추천해 줘', MENU)).toEqual([]);
    expect(pickupByRules('30분 뒤에 라떼 2잔')).toEqual({ kind: 'after', minutes: 30 });
    expect(pickupByRules('오전 11시 반에 콜드브루')).toEqual({ kind: 'at', minutes: 11 * 60 + 30 });
    expect(pickupByRules('14:30 뜨아')).toEqual({ kind: 'at', minutes: 14 * 60 + 30 });
    expect(pickupByRules('라떼 하나')).toBeNull();
  });
});

describe('[F4-1] 홈 채팅 주문', () => {
  it('[F4-1·ADR-29 시험] 규칙만으로도 "2시에 아아 하나 연하게"를 알아듣고 [확인하고 주문하기] 카드만 줘요. 주문·plan 0건이고, 누르면 기존 확인 시트예요', async () => {
    const { t, staff } = await setup();
    const res = await home(staff, '2시에 아아 하나 연하게');
    expect(res).toMatchObject({ intent: 'move', by: 'rule', read: { understood: '하려는 일 · 카페 주문' } });
    expect(res.cards).toHaveLength(1);
    const card = res.cards[0]!;
    expect(card).toMatchObject({ kind: 'cafeteria', label: '제안', evidence: { aiSummarized: false } });
    expect(card.fields).toEqual([
      { name: '메뉴', value: '아메리카노(아이스·연하게) × 1' },
      { name: '합계', value: '2,000원' },
      { name: '픽업', value: '14:00–14:10' },
    ]);
    expect(proposeOf(card).text).toBe('확인하고 주문하기');
    expect(card.tail).toContain('주문 문장은 메뉴를 고르는 데만 쓰고 저장하지 않아요');
    // 자동 실행 0: 홈 답만으로는 주문도 plan도 생기지 않아요.
    expect(await counts(t)).toEqual({ orders: 0, plans: 0 });

    // [확인하고 주문하기] → 확인 시트(사람이 보는 값) → [주문하기]
    const sheet = (await staff.call('POST', '/api/plans', { proposalToken: proposeOf(card).proposalToken })).body as Extract<
      PlanCreateResponse,
      { status: 'sheet' }
    >;
    expect(sheet.status).toBe('sheet');
    expect(sheet.sheet.lines).toEqual([
      '아메리카노(아이스·연하게) × 1 · 2,000원',
      '합계 2,000원',
      '픽업 14:00–14:10',
      '이번 달 지금까지 0원 · 남은 한도 500,000원',
    ]);
    expect(await counts(t)).toEqual({ orders: 0, plans: 1 });
    const done = (await staff.call('POST', `/api/plans/${sheet.planId}/confirm`)).body as PlanConfirmResponse;
    expect(done.status).toBe('done');
    expect((await counts(t)).orders).toBe(1);
  });

  it('[F4-1] 영업 중이 아니면 "지금은 카페가 주문을 받지 않아요" 안내 카드예요(주문 버튼 없음, 모델도 부르지 않아요)', async () => {
    const provider = new RecordingProvider('anthropic', { 'home-ask': { intent: 'move', period: 'recent', kinds: [], moveTo: 'cafe' } });
    const { t, staff } = await setup({ contract: true, provider, open: false });
    const res = await home(staff, '아아 하나 주문할게');
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]).toMatchObject({
      kind: 'cafeteria',
      label: '안내',
      headline: '지금은 카페가 주문을 받지 않아요',
      actions: { primary: { type: 'navigate', to: 'cafe' } },
    });
    expect(provider.inputs.map((i) => i.purpose)).toEqual(['home-ask']);
    expect(await counts(t)).toEqual({ orders: 0, plans: 0 });
  });

  it('[F4-1] 고를 수 없는 시각·꽉 찬 칸·모르는 메뉴는 주문 버튼 없이 알려 줘요. 미납·한도로 막히면 그 문구 그대로예요', async () => {
    const { t, staff } = await setup();
    expect((await home(staff, '6시에 아아 하나')).cards[0]).toMatchObject({
      label: '안내',
      headline: '그 시각은 아직 고를 수 없어요. 픽업은 지금부터 2시간 안에서 골라요',
    });
    expect((await home(staff, '아아 열 잔 주문해 줘')).cards[0]).toMatchObject({ label: '안내', headline: '한 메뉴는 5잔까지 주문할 수 있어요' });
    // 말한 칸이 꽉 차면 가장 가까운 다음 칸으로 골라요(알아 둘 것에 적어요).
    t.ctx.ops.patchValues({ cafeSlotCapacity: 1 });
    await order(staff, [{ menuId: 'latte', qty: 1, options: [] }]);
    const next = (await home(staff, '1시 10분에 라떼 하나')).cards[0]!;
    expect(next.fields).toContainEqual({ name: '픽업', value: '13:20–13:30' });
    expect(next.fields).toContainEqual({ name: '알아 둘 것', value: '그 칸이 꽉 차서 다음 칸으로 골랐어요' });
    t.ctx.ops.patchValues({ cafeSlotCapacity: 10, cafeMonthlyLimitWon: 10_000 });
    expect((await home(staff, '바닐라라떼 세 잔 주문할게')).cards[0]).toMatchObject({
      label: '안내',
      headline: '이번 달 한도(10,000원)를 넘어서 주문할 수 없어요. 필요하면 한도를 늘려 달라고 할 수 있어요',
    });
    expect((await counts(t)).orders).toBe(1);
  });

  it('[ADR-10·ADR-29 시험] 모델에는 질문 글과 메뉴 이름·옵션 이름만 가요. 금액·청구·내 주문은 0건이고, 모델이 나누면 "AI 정리"가 붙어요', async () => {
    const provider = new RecordingProvider('anthropic', {
      'home-ask': { intent: 'move', period: 'recent', kinds: [], moveTo: 'cafe' },
      'chat-order': {
        items: [
          { menu: '카페라테', qty: 2, options: ['아이스', '모르는 옵션'] },
          { menu: '없는 메뉴', qty: 1, options: [] },
        ],
        pickup: '13:40',
      },
    });
    const { staff } = await setup({ contract: true, provider });
    // 이미 주문한 것(금액·픽업 번호)이 있어도 모델로 가지 않아요.
    await order(staff, [{ menuId: 'vanilla-latte', qty: 1, options: ['샷 추가'] }]);
    provider.inputs.length = 0;
    const text = '이따 라떼 두 잔 차갑게 부탁해';
    const card = (await home(staff, text)).cards[0]!;
    expect(card.fields).toEqual([
      { name: '메뉴', value: '카페라테(아이스) × 2' },
      { name: '합계', value: '5,000원' },
      { name: '픽업', value: '13:40–13:50' },
    ]);
    expect(card.evidence.aiSummarized).toBe(true);
    expect(provider.inputs.map((i) => [i.purpose, i.grade])).toEqual([
      ['home-ask', 1],
      ['chat-order', 1],
    ]);
    expect(provider.inputs[0]!.input).toBe(text);
    const sent = provider.inputs[1]!;
    expect(sent.input).toContain(`문장: ${text}`);
    expect(sent.input).toContain('- 아메리카노 (옵션: 아이스, 핫, 연하게, 샷 추가)');
    // 값(직원가)·합계·이번 달 합계·한도·내 주문(바닐라라테 3,000원·픽업 번호)은 어디에도 없어요.
    const all = JSON.stringify(provider.inputs.map((i) => i.input));
    for (const secret of ['원', '2000', '2,000', '2500', '2,500', '3000', '3,000', '500,000', '500000', '한도', '청구', '픽업 번호', '가상 직원', '재무팀'])
      expect(all, secret).not.toContain(secret);
  });

  it('[ADR-10 시험] 주문 문장 카나리는 DB·로그·감사 로그·응답에 0건이에요', async () => {
    const lines: string[] = [];
    const provider = new RecordingProvider('anthropic', {
      'home-ask': { intent: 'move', period: 'recent', kinds: [], moveTo: 'cafe' },
      'chat-order': { items: [{ menu: '아메리카노', qty: 1, options: ['아이스'] }], pickup: null },
    });
    const { t, staff } = await setup({ contract: true, provider, lines });
    const canary = '카나리카페QZ7';
    for (const text of [`2시에 아아 하나 연하게 ${canary}`, `${canary} 이번 달 커피값 얼마야?`]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/home/ask',
        headers: { cookie: staff.cookie, 'x-csrf-token': staff.csrf },
        payload: { text },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(canary);
      expect(JSON.stringify(res.headers)).not.toContain(canary);
      // 카드의 제안 토큰을 열어 확인 시트를 만들어도 문장은 plan에 들어가지 않아요.
      const card = (res.json() as HomeAskResponse).cards.find((c) => c.actions.primary?.type === 'propose');
      if (card) expect((await staff.call('POST', '/api/plans', { proposalToken: proposeOf(card).proposalToken })).status).toBe(200);
    }
    const { rows: tables } = await t.db.query<{ table_name: string }>('select table_name from information_schema.tables where table_schema = current_schema()');
    expect(tables.length).toBeGreaterThan(10);
    for (const { table_name } of tables) {
      const { rows } = await t.db.query(`select * from ${table_name}`);
      expect(JSON.stringify(rows), table_name).not.toContain(canary);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(canary);
    expect(JSON.stringify(await t.ctx.audit.recent(50))).not.toContain(canary);
  });

  it('[ADR-12] 카페가 링크만이면 카페 안내 링크 카드, 꺼져 있으면 카페로 보지 않아요(모델이 카페라고 해도)', async () => {
    const link = await setup({ on: 'link' });
    expect((await home(link.staff, '2시에 아아 하나 연하게')).cards[0]).toMatchObject({ id: 'link-cafeteria', label: '안내' });
    const provider = new RecordingProvider('anthropic', { 'home-ask': { intent: 'move', period: 'recent', kinds: [], moveTo: 'cafe' } });
    const off = await setup({ on: 'off', contract: true, provider });
    const res = await home(off.staff, '2시에 아아 하나 연하게');
    expect(res.by).toBe('rule');
    expect(JSON.stringify(res.cards)).not.toContain('cafeteria');
    expect(provider.inputs.map((i) => i.purpose)).toEqual(['home-ask']);
    // 카페가 꺼져 있으면 지시문에 카페 줄이 없어요(예전과 같아요).
    expect(provider.inputs[0]!.system).not.toContain('사내 카페');
    expect(await counts(off.t)).toEqual({ orders: 0, plans: 0 });
  });
});

describe('[F4-1·ADR-27] 카페 문장이 다른 의도를 빼앗지 않아요', () => {
  it('[F4-1·ADR-27 시험] 카페가 켜져 있어도 회의실·탕비실·고장·문의·공지·내 일·팀 일정 문장은 그대로예요', () => {
    const keep: [string, string][] = [
      ['내일 3시에 6명 회의실 잡아 줘', 'move:rooms'],
      ['탕비실에 커피 좀 채워 줘', 'move:board'],
      ['탕비실에 믹스커피 넣어 주세요', 'move:board'],
      ['법인카드 잃어버렸는데 어디에 말해?', 'move:navi'],
      ['다음 주 금요일 연차 쓰고 싶어', 'move:navi'],
      ['연말 행사 공지 어디 있어?', 'move:notices'],
      ['이번 주 내 일정 알려 줘', 'mine'],
      ['오늘 우리 팀 누가 없어?', 'team-schedule'],
      ['점심 메뉴 추천해 줘', 'unknown'],
    ];
    const key = (r: { intent: string; moveTo: string | null }) => (r.intent === 'move' ? `move:${r.moveTo}` : r.intent);
    for (const [text, expected] of keep) {
      expect(key(interpretByRules(text, [], WORDS)), text).toBe(expected);
      expect(interpretByRules(text, [], WORDS), text).toEqual(interpretByRules(text, [], null));
    }
    // 커피머신 고장은 카페 주문이 아니에요.
    expect(interpretByRules('카페라테 기계가 고장 났어요', [], WORDS).moveTo).not.toBe('cafe');
    expect(key(interpretByRules('2시에 아아 하나 연하게', [], WORDS))).toBe('move:cafe');
    expect(key(interpretByRules('2시에 아아 하나 연하게', [], null))).not.toBe('move:cafe');
  });
});

describe('[F4-13] "이번 달 커피값 얼마야?"', () => {
  it('[F4-13·ADR-18 시험] 서버가 본인 이번 달 지금까지·남은 한도·미납 청구서(기한·입금 코드)를 계산해 카드로 줘요. 남의 값은 0건이에요', async () => {
    const { t, staff } = await setup();
    await order(staff, [{ menuId: 'latte', qty: 2, options: [] }]);
    const dev = await t.loginAs(MOCK.dev);
    await order(dev, [{ menuId: 'americano', qty: 1, options: [] }]);
    const res = await home(staff, '이번 달 커피값 얼마야?');
    expect(res).toMatchObject({ intent: 'mine', kinds: ['cafe'], headline: '이번 달 카페 값은 지금까지 5,000원이에요', items: [] });
    expect(res.cards).toEqual([
      expect.objectContaining({
        id: 'cafe-spend',
        kind: 'cafeteria',
        label: '안내',
        fields: [
          { name: '이번 달 지금까지', value: '5,000원' },
          { name: '남은 한도', value: '495,000원(이번 달 한도 500,000원)' },
        ],
        evidence: { text: '내 주문 기록과 청구서로 서버가 계산했어요', aiSummarized: false },
        tail: '나에게만 보여요. 카페 값은 서버가 주문 기록으로 계산하고 AI로 보내지 않아요',
      }),
    ]);
    expect(JSON.stringify(res)).not.toContain('2,000');

    // 11월 2일: 10월 청구서(미납)가 기한·입금 코드와 같이 보여요.
    t.advance(Date.parse('2026-11-01T00:30:00+09:00') - t.now());
    expect(await t.runRetention()).toEqual([]);
    t.advance(24 * 60 * 60_000);
    const again = await t.loginAs(MOCK.staff);
    const { rows } = await t.db.query<{ code: string }>('select code from cafe_bills where total_won = 5000');
    const card = (await home(again, '카페 청구서 얼마 남았어?')).cards[0]!;
    expect(card.headline).toBe('이번 달 카페 값은 지금까지 0원이에요');
    expect(card.fields).toContainEqual({ name: '10월 청구서', value: `5,000원 · 11월 7일(토)까지 · 입금 코드 ${rows[0]!.code}` });
  });

  it('[F4-13·ADR-18 시험] 모델에는 질문 글만 가고 금액은 0건이에요. 카드 숫자는 서버 계산이라 "AI 정리"가 붙지 않아요', async () => {
    const provider = new RecordingProvider('anthropic', { 'home-ask': { intent: 'mine', period: 'recent', kinds: ['cafe'], moveTo: null } });
    const { staff } = await setup({ contract: true, provider });
    await order(staff, [{ menuId: 'latte', qty: 2, options: [] }]);
    provider.inputs.length = 0;
    const res = await home(staff, '나 이번 달에 카페에서 얼마나 썼지?');
    expect(res).toMatchObject({ by: 'ai', kinds: ['cafe'] });
    expect(res.cards[0]).toMatchObject({ id: 'cafe-spend', evidence: { aiSummarized: false } });
    expect(provider.inputs.map((i) => [i.purpose, i.input])).toEqual([['home-ask', '나 이번 달에 카페에서 얼마나 썼지?']]);
    for (const secret of ['5,000', '5000', '500,000', '원']) expect(JSON.stringify(provider.inputs.map((i) => i.input))).not.toContain(secret);
  });
});
