import loadHighs from 'highs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildOrderPlan, type OrderBundleInput, type OrderPlanInput } from './plan';

// 주문안 풀이와 정수 계획(highs-js) 비교(ADR-08, D8). 정수 계획은 시험에서만 써요(운영 코드는 highs를 import하지 않아요).
// D8 1단계 보정 뒤로는 "정수 계획은 채우는데 주문안이 못 채운 층"이 하나라도 나오면 실패예요(PRD F3 완료 기준).
// 표 합 차이는 기록만 해요. 못 채우는 입력에서는 정수 계획 최적이 최소 몫을 무시한 값이라 차이가 커 보여요.
// 출력 보기: npx vitest run src/modules/pantry/order/plan-compare.test.ts --silent=false

type Highs = Awaited<ReturnType<typeof loadHighs>>;
let highs: Highs;

beforeAll(async () => {
  highs = await loadHighs();
});

/** 같은 씨앗이면 같은 입력이 나와요. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FLOORS = ['2층', '3층', '5층', '7층', '9층'];

/** 넓은 분포: 층 1~4개, 층마다 다른 최소 몫도 섞음, 묶음 단위 최대 24개(한 묶음 금액 300~120,000원) */
function wideInput(rand: () => number): OrderPlanInput {
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const floors = FLOORS.slice(0, int(1, 4));
  const sameMin = rand() < 0.7;
  const baseMin = 5000 * int(2, 16);
  const minShares: Record<string, number> = {};
  const bundles: OrderBundleInput[] = [];
  let id = 1;
  for (const floor of floors) {
    minShares[floor] = sameMin ? baseMin : 5000 * int(1, 16);
    for (let k = int(1, 8); k > 0; k--) {
      const priced = rand() < 0.9;
      bundles.push({
        bundleId: id++,
        floor,
        name: `가상 품목 ${id}`,
        catalogItemId: priced ? `cat-${id}` : null,
        unitPrice: priced ? 100 * int(3, 50) : null,
        packUnit: priced ? [1, 1, 2, 4, 6, 10, 12, 24][int(0, 7)]! : null,
        votes: int(1, 12),
      });
    }
  }
  const minSum = Object.values(minShares).reduce((a, b) => a + b, 0);
  const budget = Math.round((minSum * (0.6 + rand() * 1.6)) / 1000) * 1000;
  return { budget, minShares, bundles };
}

/** 파일럿 모양(D8 "처음엔 같은 금액"): 층 1~3개, 같은 최소 몫 30,000~100,000원, 한 묶음 금액 약 3,000~36,000원 */
function pilotInput(rand: () => number): OrderPlanInput {
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const floors = FLOORS.slice(0, int(1, 3));
  const min = 10000 * int(3, 10);
  const minShares: Record<string, number> = {};
  const bundles: OrderBundleInput[] = [];
  let id = 1;
  for (const floor of floors) {
    minShares[floor] = min;
    for (let k = int(2, 10); k > 0; k--) {
      const priced = rand() < 0.9;
      const pack = [1, 4, 6, 10, 12][int(0, 4)]!;
      bundles.push({
        bundleId: id++,
        floor,
        name: `가상 품목 ${id}`,
        catalogItemId: priced ? `cat-${id}` : null,
        unitPrice: priced ? Math.max(100, Math.round(int(3000, 36000) / pack / 100) * 100) : null,
        packUnit: priced ? pack : null,
        votes: int(1, 15),
      });
    }
  }
  const budget = Math.round((min * floors.length * (0.8 + rand() * 1.4)) / 1000) * 1000;
  return { budget, minShares, bundles };
}

interface IlpResult {
  /** 모든 층이 목표(min(최소 몫, 요청 금액))에 닿는 배정이 있는지 */
  fillable: boolean;
  /** 목표를 지키는 최적 표 합(못 지키면 예산만 지키는 최적 표 합) */
  optimum: number;
}

/** 묶음마다 0/1(한 묶음 단위)인 정수 계획: 표 합 최대, 예산 이하, 층마다 목표 이상 */
function solveIlp(input: OrderPlanInput): IlpResult {
  const priced = input.bundles.filter((b) => b.catalogItemId !== null && b.unitPrice !== null);
  if (priced.length === 0) return { fillable: true, optimum: 0 };
  const cost = (b: OrderBundleInput) => b.unitPrice! * (b.packUnit ?? 1);
  const all = priced.map((b, i) => ({ b, i }));
  const sum = (items: { c: number; i: number }[]) => items.map(({ c, i }) => `${c} x${i}`).join(' + ');

  const targetRows: string[] = [];
  for (const [k, floor] of [...new Set(priced.map((b) => b.floor))].entries()) {
    const items = all.filter(({ b }) => b.floor === floor);
    const target = Math.min(
      input.minShares[floor] ?? 0,
      items.reduce((s, { b }) => s + cost(b), 0),
    );
    if (target > 0) targetRows.push(` t${k}: ${sum(items.map(({ b, i }) => ({ c: cost(b), i })))} >= ${target}`);
  }
  const model = (extra: string[]) =>
    [
      'Maximize',
      ` obj: ${sum(all.map(({ b, i }) => ({ c: b.votes, i })))}`,
      'Subject To',
      ` budget: ${sum(all.map(({ b, i }) => ({ c: cost(b), i })))} <= ${input.budget}`,
      ...extra,
      'Bounds',
      ...all.map(({ i }) => ` 0 <= x${i} <= 1`),
      'Generals',
      ` ${all.map(({ i }) => `x${i}`).join(' ')}`,
      'End',
    ].join('\n');

  const withTargets = highs.solve(model(targetRows), { output_flag: false });
  if (withTargets.Status === 'Optimal') return { fillable: true, optimum: Math.round(withTargets.ObjectiveValue) };
  const plain = highs.solve(model([]), { output_flag: false });
  if (plain.Status !== 'Optimal') throw new Error(`정수 계획을 풀지 못했어요: ${plain.Status}`);
  return { fillable: false, optimum: Math.round(plain.ObjectiveValue) };
}

/** 탐욕법이 늘 지켜야 하는 것(R1): 예산 초과 0건, 못 채운 층은 모두 경고, 예산 < 최소 몫 합이면 잠금 */
function expectAlwaysSafe(input: OrderPlanInput): ReturnType<typeof buildOrderPlan> {
  const plan = buildOrderPlan(input);
  expect(plan.total).toBeLessThanOrEqual(input.budget);
  for (const f of plan.floors.filter((x) => !x.met)) expect(plan.warnings.some((w) => w.floor === f.floor && !w.locks)).toBe(true);
  if (input.budget < plan.basis.reduce((s, b) => s + b.minShare, 0)) expect(plan.locked).toBe(true);
  return plan;
}

/** 무작위 입력으로 비교해요. 못 받은 층은 돌려줘서 시험이 실패로 세고, 표 합 차이는 기록만 해요. */
function compare(label: string, seed: number, count: number, make: (rand: () => number) => OrderPlanInput) {
  const rand = mulberry32(seed);
  const s = { criterion: 0, ilpFillable: 0, greedyFills: 0, missedFloors: 0, optimalSame: 0, gapSum: 0, gapMax: 0 };
  const missed: { index: number; floors: string[]; input: OrderPlanInput }[] = [];
  // 표 합 차이를 입력 종류별로 나눠 봐요: 채울 수 있음 / 예산 < 최소 몫 합 / 묶음 단위 때문에 못 채움
  const gaps: Record<'채울 수 있음' | '예산 모자람' | '묶음 단위', number[]> = { '채울 수 있음': [], '예산 모자람': [], '묶음 단위': [] };

  for (let n = 0; n < count; n++) {
    const input = make(rand);
    const plan = expectAlwaysSafe(input);
    const ilp = solveIlp(input);
    const votes = plan.lines.filter((l) => l.included).reduce((sum, l) => sum + l.votes, 0);
    const gap = ilp.optimum > 0 ? Math.max(0, (ilp.optimum - votes) / ilp.optimum) : 0;
    if (votes >= ilp.optimum) s.optimalSame++;
    s.gapSum += gap;
    s.gapMax = Math.max(s.gapMax, gap);
    const poor = input.budget < plan.basis.reduce((sum, b) => sum + b.minShare, 0);
    gaps[ilp.fillable ? '채울 수 있음' : poor ? '예산 모자람' : '묶음 단위'].push(gap);

    // PRD 완료 기준의 대상: 예산 ≥ 최소 몫 합이고 정수 계획이 "채울 수 있음"인 입력의, 요청 금액 ≥ 최소 몫인 층
    if (input.budget < plan.basis.reduce((sum, b) => sum + b.minShare, 0)) continue;
    s.criterion++;
    if (!ilp.fillable) continue;
    s.ilpFillable++;
    const floors = plan.floors.filter((f) => f.requested >= f.minShare && !f.met).map((f) => f.floor);
    if (floors.length === 0) s.greedyFills++;
    else {
      s.missedFloors += floors.length;
      missed.push({ index: n, floors, input });
    }
  }

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(
    `[ADR-08 비교·${label}] 입력 ${count}개 · 예산 ≥ 최소 몫 합 ${s.criterion}개 · 정수 계획 "채울 수 있음" ${s.ilpFillable}개 · ` +
      `주문안도 모든 층 채움 ${s.greedyFills}개 · 정수 계획은 채우는데 주문안이 못 채운 입력 ${missed.length}개(층 ${s.missedFloors}개)`,
  );
  console.log(
    `[ADR-08 비교·${label}] 표 합이 최적과 같음 ${s.optimalSame}/${count} · 최적 대비 평균 차이 ${pct(s.gapSum / count)} · 최대 차이 ${pct(s.gapMax)}`,
  );
  for (const [kind, g] of Object.entries(gaps)) {
    if (g.length === 0) continue;
    const avg = g.reduce((a, b) => a + b, 0) / g.length;
    console.log(
      `[ADR-08 비교·${label}] ${kind} ${g.length}개 · 최적과 같음 ${g.filter((x) => x === 0).length}개 · 평균 차이 ${pct(avg)} · 최대 ${pct(Math.max(...g))}`,
    );
  }
  for (const m of missed.slice(0, 3)) console.log(`[ADR-08 다시 볼 입력·${label}] #${m.index} 못 받은 층 ${m.floors.join(', ')} · ${JSON.stringify(m.input)}`);
  return { ...s, missed: missed.length };
}

describe('주문안 풀이와 정수 계획 비교(ADR-08, D8 1단계 보정)', () => {
  it('[R1] 시연 모양 입력: 정수 계획이 "채울 수 있음"이라고 한 입력에서 최소 몫을 못 받은 층이 없어요', () => {
    const v = (floor: string, votes: number, unitPrice: number, packUnit: number, id: number): OrderBundleInput => ({
      bundleId: id,
      floor,
      name: `가상 품목 ${id}`,
      catalogItemId: `cat-${id}`,
      unitPrice,
      packUnit,
      votes,
    });
    const inputs: OrderPlanInput[] = [
      // 두 층, 같은 최소 몫
      {
        budget: 60_000,
        minShares: { '2층': 20_000, '3층': 20_000 },
        bundles: [v('2층', 9, 500, 24, 1), v('2층', 5, 1_000, 10, 2), v('2층', 6, 2_000, 12, 3), v('3층', 4, 300, 20, 4), v('3층', 6, 1_200, 12, 5)],
      },
      // 표 대비 값이 큰 묶음이 다른 층 몫을 먹지 않게 건너뛰어요
      {
        budget: 40_000,
        minShares: { '2층': 15_000, '3층': 15_000 },
        bundles: [v('2층', 30, 1_000, 30, 1), v('2층', 10, 500, 30, 2), v('3층', 5, 500, 30, 3)],
      },
      // 세 층, 예산이 최소 몫 합과 같아요
      {
        budget: 90_000,
        minShares: { '2층': 30_000, '3층': 30_000, '5층': 30_000 },
        bundles: [
          v('2층', 8, 1_000, 12, 1),
          v('2층', 3, 9_000, 2, 2),
          v('3층', 9, 2_500, 12, 3),
          v('3층', 1, 1_000, 6, 4),
          v('5층', 5, 1_500, 10, 5),
          v('5층', 4, 1_500, 10, 6),
        ],
      },
      // 한 층(파일럿)
      { budget: 50_000, minShares: { '2층': 40_000 }, bundles: [v('2층', 9, 900, 24, 1), v('2층', 6, 1_000, 10, 2), v('2층', 2, 800, 12, 3)] },
    ];
    for (const input of inputs) {
      expect(solveIlp(input).fillable).toBe(true);
      const plan = expectAlwaysSafe(input);
      expect(plan.floors.filter((f) => f.requested >= f.minShare && !f.met)).toEqual([]);
    }
  });

  it('[D8 1단계 보정] 작은 묶음을 먼저 넣으면 큰 묶음 자리가 모자라던 입력도 이제 모든 층을 채워요', () => {
    const v = (floor: string, votes: number, cost: number, id: number): OrderBundleInput => ({
      bundleId: id,
      floor,
      name: `가상 품목 ${id}`,
      catalogItemId: `cat-${id}`,
      unitPrice: cost,
      packUnit: 1,
      votes,
    });
    const input: OrderPlanInput = {
      budget: 90_000,
      minShares: { '2층': 30_000, '3층': 30_000, '5층': 30_000 },
      bundles: [v('2층', 8, 12_000, 1), v('2층', 3, 18_000, 2), v('3층', 7, 30_000, 3), v('3층', 2, 6_000, 4), v('5층', 5, 15_000, 5), v('5층', 4, 15_000, 6)],
    };
    expect(solveIlp(input).fillable).toBe(true);
    const plan = expectAlwaysSafe(input);
    // 예전 규칙: 3층이 표 대비 값이 큰 6,000원 묶음을 먼저 넣고, 30,000원 묶음은 5층 몫을 남기느라 건너뛰어 6,000원에 그쳤어요.
    // 보정 뒤: 6,000원 묶음을 넣으면 남은 묶음(30,000원)과 5층 몫을 낼 수 없어서 건너뛰고, 30,000원 묶음을 넣어요.
    expect(plan.floors.map((f) => [f.floor, f.total, f.met])).toEqual([
      ['2층', 30_000, true],
      ['3층', 30_000, true],
      ['5층', 30_000, true],
    ]);
    expect(plan.warnings).toEqual([]);
    expect(plan.lines.find((l) => l.bundleId === 4)).toMatchObject({ included: false, reason: '예산 초과로 뺌' });
  });

  it('[R1·ADR-08 시험] 넓은 분포 무작위 입력 400개: 정수 계획이 "채울 수 있음"이면 못 받은 층 0건이에요', () => {
    const r = compare('넓은 분포', 20261026, 400, wideInput);
    expect(r.ilpFillable).toBeGreaterThan(0);
    expect(r.missed).toBe(0);
  }, 60_000);

  it('[R1·ADR-08 시험] 파일럿 모양 무작위 입력 400개: 정수 계획이 "채울 수 있음"이면 못 받은 층 0건이에요', () => {
    const r = compare('파일럿 모양', 20261027, 400, pilotInput);
    expect(r.ilpFillable).toBeGreaterThan(0);
    expect(r.missed).toBe(0);
  }, 60_000);
});
