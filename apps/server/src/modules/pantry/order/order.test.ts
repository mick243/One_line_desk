import { ORDER_MESSAGES, type OrderConfirmResponse, type OrderCurrentResponse, type OrderPlanView } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AiGateway, type LlmProvider, type ProviderResult, type StructuredRequest } from '../../../core/ai/gateway';
import { createTestApp, MOCK } from '../../../testing';
import { listOpenBundles } from '../bundles';
import { editedSentence, templateSentence } from './explain';

// 주문안 경로 시험(F3 세부 11~14, ADR-08, R1·R16). 가상 품목·가명 투표자(p_…)만 써요.

type Line = { lineId: string; itemName: string; floor: string; votes: number; amount: number; reason: string; rank: number };

/** 줄마다 정해 둔 문장을 돌려주는 모의 모델. L1은 맞는 숫자, L2는 틀린 숫자, L3은 한글 수사, 나머지는 빠뜨려요. */
class ScriptedProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  inputs: string[] = [];
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    this.inputs.push(req.input);
    const { lines } = JSON.parse(req.input) as { lines: Line[] };
    const out = lines.flatMap((l) => {
      if (l.lineId === 'L1') return [{ lineId: l.lineId, sentence: `${l.floor}에서 표 ${l.votes}개로 층 안 ${l.rank}위라 먼저 넣었어요.` }];
      if (l.lineId === 'L2') return [{ lineId: l.lineId, sentence: `표 ${l.votes + 40}개라 넣었어요.` }];
      if (l.lineId === 'L3') return [{ lineId: l.lineId, sentence: '표 여섯 개라 예산을 넘어서 뺐어요.' }];
      return [];
    });
    return { output: req.schema.parse({ lines: out }), inputTokens: 1, outputTokens: 1 };
  }
}

const SEED = `
  insert into pantry_catalog (id, name, unit_price, pack_unit) values
    ('cat-water', '가상 탄산수 상자', 500, 24),
    ('cat-coffee', '가상 커피 믹스', 1000, 10),
    ('cat-snack', '가상 과자 상자', 2000, 12),
    ('cat-tea', '가상 녹차 티백', 300, 20),
    ('cat-noodle', '가상 컵라면', 1200, 12);
  insert into pantry_floor_settings (floor, min_share_won, per_person_limit) values ('2층', 20000, 5), ('3층', 20000, 4);
  insert into pantry_cycles (floor, cycle_no, state, per_person_limit) values ('2층', 1, 'open', 5), ('3층', 1, 'open', 4);
  insert into pantry_cards (id, floor, item_name, catalog_item_id, author_pseudonym_id, bundle_version) values
    (1, '2층', '가상 탄산수', 'cat-water', 'p_a', 1),
    (2, '2층', '탄산수 큰 병', null, 'p_b', 0),
    (3, '2층', '가상 커피 믹스', 'cat-coffee', 'p_c', 0),
    (4, '2층', '가상 과자 상자', 'cat-snack', 'p_d', 0),
    (5, '3층', '가상 녹차 티백', 'cat-tea', 'p_e', 0),
    (6, '3층', '가상 컵라면', 'cat-noodle', 'p_f', 0),
    (7, '3층', '가상 초콜릿', null, 'p_g', 0);
  select setval(pg_get_serial_sequence('pantry_cards', 'id'), 7);
  insert into pantry_merges (merged_card_id, representative_card_id, facilities_pseudonym_id) values (2, 1, 'p_fac');
  insert into pantry_votes (pseudonym_id, card_id) values
    ('p_a', 1), ('p_x', 1), ('p_y', 1), ('p_b', 2), ('p_a', 2),
    ('p_c', 3), ('p_x', 3),
    ('p_d', 4), ('p_x', 4), ('p_y', 4),
    ('p_e', 5), ('p_x', 5),
    ('p_f', 6), ('p_y', 6), ('p_z', 6),
    ('p_g', 7);
`;

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(opts: { contract?: boolean } = {}) {
  const provider = new ScriptedProvider();
  const t = await createTestApp({ provider });
  close = t.close;
  // 품목 이름은 등급 1이라 무보관 계약 확인 뒤에만 모델로 가요(H1). AI 문장을 보는 시험만 계약을 확인한 게이트웨이로 바꿔 끼워요.
  if (opts.contract) t.ctx.gateway = new AiGateway(provider, true, t.db);
  await t.db.exec(SEED);
  const facilities = await t.loginAs(MOCK.facilities);
  const staff = await t.loginAs(MOCK.staff);
  const create = async (budget: number) => {
    const res = await facilities.call('POST', '/api/pantry/order/plans', { budget });
    expect(res.status).toBe(200);
    return res.body as OrderPlanView;
  };
  const cardStates = async () =>
    (await t.db.query<{ id: number; state: string }>('select id, state from pantry_cards order by id')).rows.map((r) => [Number(r.id), r.state]);
  return { ...t, provider, facilities, staff, create, cardStates };
}

const line = (plan: OrderPlanView, lineId: string) => plan.lines.find((l) => l.lineId === lineId)!;

// 시험마다 새 PGlite를 띄워서, 전체 시험을 함께 돌릴 때 5초를 넘을 수 있어요.
describe('주문안 경로', { timeout: 30_000 }, () => {
  it('[F3] 총무가 아닌 역할은 주문안 만들기·보기·고치기·확정·내보내기가 모두 거부돼요', async () => {
    const t = await setup();
    const plan = await t.create(60_000);
    for (const [method, url, body] of [
      ['POST', '/api/pantry/order/plans', { budget: 60_000 }],
      ['GET', '/api/pantry/order/plans/current', undefined],
      ['GET', `/api/pantry/order/plans/${plan.planId}`, undefined],
      ['PUT', `/api/pantry/order/plans/${plan.planId}/lines/L3`, { quantity: 12 }],
      ['DELETE', `/api/pantry/order/plans/${plan.planId}/lines/L1`, undefined],
      ['POST', `/api/pantry/order/plans/${plan.planId}/confirm`, undefined],
      ['GET', `/api/pantry/order/plans/${plan.planId}/export.csv`, undefined],
    ] as const) {
      const res = await t.staff.call(method, url, body);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect(await t.cardStates()).toEqual([1, 2, 3, 4, 5, 6, 7].map((id) => [id, 'open']));
    expect((await t.db.query("select count(*)::int as n from pantry_cycles where state = 'closed'")).rows[0]).toEqual({ n: 0 });
  });

  it('[R1] 예산을 넣으면 층 최소 몫 → 표 대비 값 순으로 줄·이유 코드·합계가 나오고, 투표자는 없어요', async () => {
    const t = await setup();
    const plan = await t.create(60_000);
    expect(plan.lines.map((l) => [l.lineId, l.floor, l.itemName, l.votes, l.quantity, l.amount, l.included, l.reason, l.rank])).toEqual([
      ['L1', '2층', '가상 탄산수', 4, 24, 12_000, true, '층 최소 몫', 1],
      ['L2', '2층', '가상 커피 믹스', 2, 10, 10_000, true, '층 최소 몫', 2],
      ['L3', '2층', '가상 과자 상자', 3, 12, 24_000, false, '예산 초과로 뺌', 3],
      ['L4', '3층', '가상 녹차 티백', 2, 20, 6_000, true, '층 최소 몫', 1],
      ['L5', '3층', '가상 컵라면', 3, 12, 14_400, true, '층 최소 몫', 2],
      ['L6', '3층', '가상 초콜릿', 1, 0, 0, false, '카탈로그에 없음', 3],
    ]);
    expect(plan).toMatchObject({ status: 'draft', budget: 60_000, total: 42_400, locked: false, explained: false, warnings: [] });
    expect(plan.floors.map((f) => [f.floor, f.minShare, f.total, f.met])).toEqual([
      ['2층', 20_000, 22_000, true],
      ['3층', 20_000, 20_400, true],
    ]);
    expect(plan.lines.every((l) => l.explanationSource === 'template' && !l.edited)).toBe(true);
    expect(JSON.stringify(plan)).not.toMatch(/p_[a-z]/);

    const current = (await t.facilities.call('GET', '/api/pantry/order/plans/current')).body as OrderCurrentResponse;
    expect(current.plan?.planId).toBe(plan.planId);
  });

  it('[H1] 무보관 계약 전에는 설명 채우기가 공급자를 부르지 않고 모든 줄이 틀 문장이에요', async () => {
    const t = await setup();
    const plan = await t.create(60_000);
    const explained = (await t.facilities.call('POST', `/api/pantry/order/plans/${plan.planId}/explain`)).body as OrderPlanView;
    expect(t.provider.inputs).toEqual([]);
    expect(explained.explained).toBe(true);
    expect(explained.lines.every((l) => l.explanationSource === 'template')).toBe(true);
  });

  it('[ADR-08] 설명 채우기: 숫자 검사를 지난 문장만 AI 문장이고, 나머지는 틀 문장이에요(무보관 계약 뒤)', async () => {
    const t = await setup({ contract: true });
    const plan = await t.create(60_000);
    const res = await t.facilities.call('POST', `/api/pantry/order/plans/${plan.planId}/explain`);
    expect(res.status).toBe(200);
    const explained = res.body as OrderPlanView;
    expect(explained.explained).toBe(true);
    expect(line(explained, 'L1')).toMatchObject({ explanation: '2층에서 표 4개로 층 안 1위라 먼저 넣었어요.', explanationSource: 'ai' });
    expect(line(explained, 'L2')).toMatchObject({ explanation: templateSentence(line(plan, 'L2')), explanationSource: 'template' });
    expect(line(explained, 'L3')).toMatchObject({ explanation: templateSentence(line(plan, 'L3')), explanationSource: 'template' });
    expect(line(explained, 'L4')).toMatchObject({ explanation: templateSentence(line(plan, 'L4')), explanationSource: 'template' });

    // LLM 입력: 줄 ID·품목 이름·층·표 수·금액·이유 코드·순위뿐이에요.
    const sent = JSON.parse(t.provider.inputs[0]!) as { lines: Record<string, unknown>[] };
    expect(sent.lines).toHaveLength(6);
    for (const l of sent.lines) expect(Object.keys(l).sort()).toEqual(['amount', 'floor', 'itemName', 'lineId', 'rank', 'reason', 'votes']);
    expect(t.provider.inputs[0]).not.toMatch(/p_[a-z]/);

    // 두 번 불러도 다시 묻지 않아요.
    await t.facilities.call('POST', `/api/pantry/order/plans/${plan.planId}/explain`);
    expect(t.provider.inputs).toHaveLength(1);
  });

  it('[R1] 줄을 바꿔 예산을 넘으면 "예산을 넘었어요"로 확정이 잠기고, 고친 줄은 "총무가 고침" + 틀 문장이에요(이유 코드는 그대로)', async () => {
    const t = await setup();
    const plan = await t.create(60_000);
    const changed = await t.facilities.call('PUT', `/api/pantry/order/plans/${plan.planId}/lines/L3`, { quantity: 12 });
    expect(changed.status).toBe(200);
    const over = changed.body as OrderPlanView;
    expect(line(over, 'L3')).toMatchObject({
      included: true,
      quantity: 12,
      amount: 24_000,
      edited: true,
      reason: '예산 초과로 뺌',
      explanation: editedSentence({ included: true, quantity: 12, amount: 24_000 }),
      explanationSource: 'template',
    });
    expect(over.total).toBe(66_400);
    expect(over.locked).toBe(true);
    expect(over.warnings).toContainEqual({ kind: 'over-budget', message: ORDER_MESSAGES.overBudget, locks: true });

    const refused = await t.facilities.call('POST', `/api/pantry/order/plans/${plan.planId}/confirm`);
    expect(refused).toMatchObject({ status: 409, body: { error: 'order-locked', message: ORDER_MESSAGES.overBudget } });
    expect(await t.cardStates()).toEqual([1, 2, 3, 4, 5, 6, 7].map((id) => [id, 'open']));

    // 묶음 단위가 아닌 개수, 카탈로그에 없는 줄은 바꿀 수 없어요.
    expect((await t.facilities.call('PUT', `/api/pantry/order/plans/${plan.planId}/lines/L3`, { quantity: 13 })).body).toMatchObject({
      error: 'bad-quantity',
      message: '묶음 단위(12개)로 넣어 주세요',
    });
    expect((await t.facilities.call('PUT', `/api/pantry/order/plans/${plan.planId}/lines/L6`, { quantity: 1 })).status).toBe(409);

    // 빼면 다시 예산 안이에요. 고쳐서 최소 몫에 못 미치면 경고만 떠요.
    const removed = (await t.facilities.call('DELETE', `/api/pantry/order/plans/${plan.planId}/lines/L5`)).body as OrderPlanView;
    expect(line(removed, 'L5')).toMatchObject({ included: false, edited: true, reason: '층 최소 몫', explanation: '총무가 주문안에서 뺐어요.' });
    const back = (await t.facilities.call('DELETE', `/api/pantry/order/plans/${plan.planId}/lines/L3`)).body as OrderPlanView;
    expect(back.total).toBe(28_000);
    expect(back.warnings).toEqual([{ kind: 'floor-short', floor: '3층', message: ORDER_MESSAGES.floorShort, locks: false }]);
    expect(back.locked).toBe(false);

    // 설명을 나중에 채워도 총무가 고친 줄은 틀 문장 그대로예요.
    const explained = (await t.facilities.call('POST', `/api/pantry/order/plans/${plan.planId}/explain`)).body as OrderPlanView;
    expect(line(explained, 'L3')).toMatchObject({ edited: true, explanation: '총무가 주문안에서 뺐어요.', explanationSource: 'template' });
  });

  it('[R1] 예산이 최소 몫 합보다 작으면 주문안은 보여 주고 경고와 함께 확정을 잠가요. 예산을 고쳐 다시 만들면 풀려요', async () => {
    const t = await setup();
    const small = await t.create(30_000);
    expect(small.lines.length).toBe(6);
    expect(small.total).toBeLessThanOrEqual(30_000);
    expect(small.locked).toBe(true);
    expect(small.warnings).toContainEqual({ kind: 'budget-below-min-sum', message: ORDER_MESSAGES.budgetBelowMinSum, locks: true });
    const refused = await t.facilities.call('POST', `/api/pantry/order/plans/${small.planId}/confirm`);
    expect(refused).toMatchObject({ status: 409, body: { error: 'order-locked', message: ORDER_MESSAGES.budgetBelowMinSum } });

    const fixed = await t.create(60_000);
    expect(fixed.locked).toBe(false);
    // 앞의 주문안은 밀려나서 고칠 수 없어요.
    expect((await t.facilities.call('DELETE', `/api/pantry/order/plans/${small.planId}/lines/L1`)).body).toMatchObject({ error: 'order-closed' });
    expect(((await t.facilities.call('GET', '/api/pantry/order/plans/current')).body as OrderCurrentResponse).plan?.planId).toBe(fixed.planId);
  });

  it('[R16] 확정하면 주문에 들어간 묶음 카드가 주문됨이 되고, 층마다 주기가 닫히고 새 주기가 열려요. 나머지는 그대로 넘어가요', async () => {
    const t = await setup();
    const plan = await t.create(60_000);
    const votesBefore = (await t.db.query('select count(*)::int as n from pantry_votes')).rows[0];

    const res = await t.facilities.call('POST', `/api/pantry/order/plans/${plan.planId}/confirm`);
    expect(res.status).toBe(200);
    const body = res.body as OrderConfirmResponse;
    expect(body).toMatchObject({
      orderedBundles: 4,
      carriedOverBundles: 2,
      cycles: [
        { floor: '2층', closedCycleNo: 1, openedCycleNo: 2 },
        { floor: '3층', closedCycleNo: 1, openedCycleNo: 2 },
      ],
    });
    expect(body.plan).toMatchObject({ status: 'confirmed', locked: true });
    expect(body.plan.confirmedAt).not.toBeNull();

    // 합쳐진 카드(2)도 묶음째 주문됨이에요. 과자 상자(4)·초콜릿(7)은 열린 채로 넘어가요.
    expect(await t.cardStates()).toEqual([
      [1, 'ordered'],
      [2, 'ordered'],
      [3, 'ordered'],
      [4, 'open'],
      [5, 'ordered'],
      [6, 'ordered'],
      [7, 'open'],
    ]);
    const cycles = await t.db.query<{ floor: string; cycle_no: number; state: string; per_person_limit: number }>(
      'select floor, cycle_no, state, per_person_limit from pantry_cycles order by floor, cycle_no',
    );
    expect(cycles.rows).toEqual([
      { floor: '2층', cycle_no: 1, state: 'closed', per_person_limit: 5 },
      { floor: '2층', cycle_no: 2, state: 'open', per_person_limit: 5 },
      { floor: '3층', cycle_no: 1, state: 'closed', per_person_limit: 4 },
      { floor: '3층', cycle_no: 2, state: 'open', per_person_limit: 4 },
    ]);
    // 표 행은 지우지 않아요(넘어간 표는 그대로).
    expect((await t.db.query('select count(*)::int as n from pantry_votes')).rows[0]).toEqual(votesBefore);

    // 같은 확정을 다시 눌러도 한 번만 실행돼요. 확정한 주문안은 고칠 수 없어요.
    const again = await t.facilities.call('POST', `/api/pantry/order/plans/${plan.planId}/confirm`);
    expect(again.status).toBe(200);
    expect((await t.db.query("select count(*)::int as n from pantry_cycles where state = 'open'")).rows[0]).toEqual({ n: 2 });
    expect((await t.facilities.call('PUT', `/api/pantry/order/plans/${plan.planId}/lines/L3`, { quantity: 12 })).body).toMatchObject({ error: 'order-closed' });
    expect((await t.db.query("select count(*)::int as n from audit_log where action = 'order.confirm'")).rows[0]).toEqual({ n: 1 });
  });

  it('[I6] 주문됨 묶음은 열린 묶음에서 빠져서 +1 대상이 아니에요(카드 상태로 확인)', async () => {
    const t = await setup();
    const plan = await t.create(60_000);
    await t.facilities.call('POST', `/api/pantry/order/plans/${plan.planId}/confirm`);
    const open = await listOpenBundles(t.db);
    expect(open.map((b) => [b.bundleId, b.name]).sort()).toEqual([
      [4, '가상 과자 상자'],
      [7, '가상 초콜릿'],
    ]);
    const ordered = await t.db.query<{ n: number }>("select count(*)::int as n from pantry_cards where id in (1, 2, 3, 5, 6) and state = 'ordered'");
    expect(ordered.rows[0]?.n).toBe(5);
    // 다음 주문안에는 넘어간 묶음만 들어가요.
    const next = await t.create(60_000);
    expect(next.lines.map((l) => l.itemName)).toEqual(['가상 과자 상자', '가상 초콜릿']);
  });

  it('[F3] 파일 내보내기는 확정한 뒤에만 되고, 층·품목·카탈로그 ID·수량·금액만 있어요(투표자·표 수 없음)', async () => {
    const t = await setup();
    await t.db.query("update pantry_cards set item_name = '=가상 커피 믹스' where id = 3");
    const plan = await t.create(60_000);
    const exportUrl = `/api/pantry/order/plans/${plan.planId}/export.csv`;
    expect((await t.facilities.call('GET', exportUrl)).body).toMatchObject({ error: 'order-not-confirmed' });

    await t.facilities.call('POST', `/api/pantry/order/plans/${plan.planId}/confirm`);
    const res = await t.app.inject({ method: 'GET', url: exportUrl, headers: { cookie: t.facilities.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="pantry-order-\d{8}\.csv"$/);
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    expect(res.body.slice(1).split('\r\n')).toEqual([
      '층,품목,카탈로그 ID,수량,금액',
      '2층,가상 탄산수,cat-water,24,12000',
      "2층,'=가상 커피 믹스,cat-coffee,10,10000",
      '3층,가상 녹차 티백,cat-tea,20,6000',
      '3층,가상 컵라면,cat-noodle,12,14400',
      '',
    ]);
    expect(res.body).not.toMatch(/p_[a-z]|표/);
  });

  it('[R3] 주문안을 만든 뒤 판의 묶음이 바뀌면(합치기·되돌리기) 확정을 거부하고 아무것도 바꾸지 않아요', async () => {
    const t = await setup();
    const plan = await t.create(60_000);
    await t.db.query('update pantry_cards set bundle_version = bundle_version + 1 where id = 1');
    const res = await t.facilities.call('POST', `/api/pantry/order/plans/${plan.planId}/confirm`);
    expect(res).toMatchObject({ status: 409, body: { error: 'order-stale' } });
    expect(await t.cardStates()).toEqual([1, 2, 3, 4, 5, 6, 7].map((id) => [id, 'open']));
    expect((await t.db.query("select count(*)::int as n from pantry_cycles where state = 'closed'")).rows[0]).toEqual({ n: 0 });
  });

  it('같이 채워요가 꺼져 있으면 주문안 경로도 막혀요', async () => {
    const t = await setup();
    await t.ctx.ops.setModule('p_operator', 'pantry', 'off');
    expect((await t.facilities.call('POST', '/api/pantry/order/plans', { budget: 60_000 })).body).toMatchObject({ error: 'feature-off' });
    expect((await t.facilities.call('GET', '/api/pantry/order/plans/current')).body).toMatchObject({ error: 'feature-off' });
  });
});
