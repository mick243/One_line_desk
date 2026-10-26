import { ORDER_MESSAGES } from '@one-line-desk/shared';
import { describe, expect, it } from 'vitest';
import { buildOrderPlan, checkOrderPlan, compareFloors, type OrderBundleInput, type OrderPlanInput } from './plan';

// 주문안 풀이 규칙(ADR-08, R1). 가상 품목·가상 금액이에요.

let nextId = 1;
function bundle(floor: string, name: string, votes: number, unitPrice: number | null, packUnit: number | null = 1): OrderBundleInput {
  const id = nextId++;
  return { bundleId: id, floor, name, catalogItemId: unitPrice === null ? null : `cat-${id}`, unitPrice, packUnit, votes };
}

/** 두 층 모두 최소 몫을 채울 수 있는 입력 */
function twoFloors(budget = 60_000): OrderPlanInput {
  nextId = 1;
  return {
    budget,
    minShares: { '2층': 20_000, '3층': 20_000 },
    bundles: [
      bundle('3층', '가상 녹차 티백', 4, 300, 20), // 6,000원, 4표
      bundle('2층', '가상 탄산수', 9, 500, 24), // 12,000원, 9표
      bundle('2층', '가상 커피 믹스', 5, 1_000, 10), // 10,000원, 5표
      bundle('2층', '가상 과자 상자', 6, 2_000, 12), // 24,000원, 6표
      bundle('3층', '가상 컵라면', 6, 1_200, 12), // 14,400원, 6표
      bundle('3층', '가상 초콜릿', 7, null, null), // 카탈로그에 없음
    ],
  };
}

const pick = (plan: ReturnType<typeof buildOrderPlan>, name: string) => plan.lines.find((l) => l.itemName === name)!;

describe('주문안 풀이(ADR-08, D8 1단계 보정)', () => {
  it('층 번호 순으로 정렬해요(지하는 앞, 숫자 없는 층은 뒤)', () => {
    expect(['10층', '3층', '본관', 'B1', '2층'].sort(compareFloors)).toEqual(['B1', '2층', '3층', '10층', '본관']);
  });

  it('[R1] 층 최소 몫을 먼저 채우고, 남은 예산은 표 대비 값 순으로 채워요', () => {
    const plan = buildOrderPlan(twoFloors());
    expect(plan.lines.map((l) => [l.floor, l.itemName, l.reason, l.included, l.rank])).toEqual([
      ['2층', '가상 탄산수', '층 최소 몫', true, 1],
      ['2층', '가상 커피 믹스', '층 최소 몫', true, 2],
      ['2층', '가상 과자 상자', '예산 초과로 뺌', false, 3],
      ['3층', '가상 녹차 티백', '층 최소 몫', true, 1],
      ['3층', '가상 컵라면', '층 최소 몫', true, 2],
      ['3층', '가상 초콜릿', '카탈로그에 없음', false, 3],
    ]);
    expect(plan.lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.total).toBe(12_000 + 10_000 + 6_000 + 14_400);
    expect(plan.floors.map((f) => [f.floor, f.total, f.met])).toEqual([
      ['2층', 22_000, true],
      ['3층', 20_400, true],
    ]);
    expect(plan.warnings).toEqual([]);
    expect(plan.locked).toBe(false);
  });

  it('수량은 기본 한 묶음 단위이고 금액은 단가 × 개수예요', () => {
    const plan = buildOrderPlan(twoFloors());
    expect(pick(plan, '가상 탄산수')).toMatchObject({ quantity: 24, amount: 12_000 });
    expect(pick(plan, '가상 과자 상자')).toMatchObject({ quantity: 12, amount: 24_000, included: false });
    expect(pick(plan, '가상 초콜릿')).toMatchObject({ quantity: 0, amount: 0, included: false });
  });

  it('[R1] 예산이 넉넉하면 2단계에서 표 대비 값으로 더 담아요', () => {
    const plan = buildOrderPlan(twoFloors(100_000));
    expect(pick(plan, '가상 과자 상자')).toMatchObject({ reason: '표 대비 값', included: true });
    expect(plan.total).toBe(66_400);
  });

  it('[R1] 다른 층이 아직 못 채운 몫만큼 예산을 남겨 두고 건너뛰어요', () => {
    nextId = 1;
    const plan = buildOrderPlan({
      budget: 40_000,
      minShares: { '2층': 15_000, '3층': 15_000 },
      bundles: [
        bundle('2층', '가상 큰 상자', 30, 1_000, 30), // 30,000원, 표 대비 값이 가장 커요
        bundle('2층', '가상 작은 상자', 10, 500, 30), // 15,000원
        bundle('3층', '가상 물', 5, 500, 30), // 15,000원
      ],
    });
    // 큰 상자를 넣으면 남는 10,000원이 3층 몫 15,000원보다 작아져서 건너뛰어요.
    expect(pick(plan, '가상 큰 상자')).toMatchObject({ included: false, reason: '예산 초과로 뺌' });
    expect(pick(plan, '가상 작은 상자')).toMatchObject({ included: true, reason: '층 최소 몫' });
    expect(pick(plan, '가상 물')).toMatchObject({ included: true, reason: '층 최소 몫' });
    expect(plan.floors.every((f) => f.met)).toBe(true);
    expect(plan.total).toBeLessThanOrEqual(40_000);
  });

  it('[R1] 예산이 최소 몫 합보다 작으면 주문안은 만들되 경고하고 확정을 잠가요', () => {
    const plan = buildOrderPlan(twoFloors(30_000));
    expect(plan.lines.length).toBe(6);
    expect(plan.lines.some((l) => l.included)).toBe(true);
    expect(plan.total).toBeLessThanOrEqual(30_000);
    expect(plan.warnings).toContainEqual({ kind: 'budget-below-min-sum', message: ORDER_MESSAGES.budgetBelowMinSum, locks: true });
    expect(plan.locked).toBe(true);
  });

  it('[R1] 요청 금액이 최소 몫보다 작은 층은 있는 만큼만 담고 경고만 붙여요(잠그지 않음)', () => {
    nextId = 1;
    const plan = buildOrderPlan({
      budget: 50_000,
      minShares: { '2층': 20_000, '3층': 20_000 },
      bundles: [bundle('2층', '가상 탄산수', 9, 500, 24), bundle('2층', '가상 커피 믹스', 5, 1_000, 10), bundle('3층', '가상 녹차 티백', 4, 300, 20)],
    });
    expect(pick(plan, '가상 녹차 티백')).toMatchObject({ included: true });
    const third = plan.floors.find((f) => f.floor === '3층')!;
    expect(third).toMatchObject({ requested: 6_000, target: 6_000, total: 6_000, met: false });
    expect(plan.warnings).toEqual([{ kind: 'floor-request-short', floor: '3층', message: ORDER_MESSAGES.floorRequestShort, locks: false }]);
    expect(plan.locked).toBe(false);
  });

  it('[R1] 묶음 단위 때문에 최소 몫에 못 닿은 층도 경고가 붙어요', () => {
    nextId = 1;
    const plan = buildOrderPlan({ budget: 22_000, minShares: { '2층': 20_000 }, bundles: [bundle('2층', '가상 생수 상자', 3, 1_250, 20)] });
    expect(plan.total).toBe(0);
    expect(plan.warnings).toEqual([{ kind: 'floor-short', floor: '2층', message: ORDER_MESSAGES.floorShort, locks: false }]);
    expect(plan.locked).toBe(false);
  });

  it('[D8 1단계 보정] 표 대비 값이 큰 작은 묶음이 층 몫을 막으면 건너뛰고, 혼자 몫을 채우는 큰 묶음을 넣어요', () => {
    nextId = 1;
    // 한 층, 예산 = 최소 몫. 작은 묶음(표 대비 값 1위)을 넣으면 남은 18,000원으로 20,000원 묶음을 못 사요.
    const plan = buildOrderPlan({
      budget: 20_000,
      minShares: { '2층': 20_000 },
      bundles: [bundle('2층', '가상 사탕', 5, 2_000, 1), bundle('2층', '가상 생수 상자', 6, 1_000, 20)],
    });
    expect(pick(plan, '가상 사탕')).toMatchObject({ included: false, reason: '예산 초과로 뺌' });
    expect(pick(plan, '가상 생수 상자')).toMatchObject({ included: true, reason: '층 최소 몫', amount: 20_000 });
    expect(plan.floors[0]).toMatchObject({ total: 20_000, met: true });
    expect(plan.warnings).toEqual([]);
  });

  it('[D8 1단계 보정] 묶음 단위 때문에 모든 층을 채울 수 없으면, 층 번호 순으로 채울 수 있는 층부터 채우고 나머지는 경고예요', () => {
    nextId = 1;
    // 최소 몫 합 40,000원 ≤ 예산 50,000원이지만 층마다 30,000원 묶음뿐이라 두 층을 다 채울 수는 없어요.
    const plan = buildOrderPlan({
      budget: 50_000,
      minShares: { '2층': 20_000, '3층': 20_000 },
      bundles: [bundle('3층', '가상 컵라면 상자', 9, 1_500, 20), bundle('2층', '가상 과자 상자', 2, 2_500, 12)],
    });
    expect(plan.floors.map((f) => [f.floor, f.total, f.met])).toEqual([
      ['2층', 30_000, true],
      ['3층', 0, false],
    ]);
    expect(plan.warnings).toEqual([{ kind: 'floor-short', floor: '3층', message: ORDER_MESSAGES.floorShort, locks: false }]);
    expect(plan.locked).toBe(false);
  });

  it('[D8 1단계 보정] 단가가 1원 단위여도 계산이 금방 끝나요', () => {
    nextId = 1;
    const bundles = Array.from({ length: 30 }, (_, i) => bundle(i % 2 ? '3층' : '2층', `가상 품목 ${i}`, 1 + (i % 7), 1_001 + i * 37, 1 + (i % 5)));
    const started = performance.now();
    const plan = buildOrderPlan({ budget: 400_000, minShares: { '2층': 150_000, '3층': 150_000 }, bundles });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(plan.total).toBeLessThanOrEqual(400_000);
  });

  it('[R1] 예산 초과 0건: 어떤 입력에서도 합계가 예산을 넘지 않아요', () => {
    for (const budget of [0, 5_000, 20_000, 39_999, 40_000, 60_000, 1_000_000]) {
      const plan = buildOrderPlan(twoFloors(budget));
      expect(plan.total).toBeLessThanOrEqual(budget);
    }
  });

  it('최소 몫이 없는 층은 0원으로 보고, 열린 묶음이 없는 층은 주문안에 넣지 않아요', () => {
    nextId = 1;
    const plan = buildOrderPlan({ budget: 10_000, minShares: { '7층': 50_000 }, bundles: [bundle('2층', '가상 탄산수', 9, 500, 4)] });
    expect(plan.basis).toEqual([{ floor: '2층', minShare: 0, requested: 2_000 }]);
    expect(plan.warnings).toEqual([]);
  });
});

describe('검사기(R1): 총무가 고친 뒤에도 다시 돌려요', () => {
  it('[R1] 고친 뒤 예산을 넘으면 "예산을 넘었어요"로 확정을 잠가요', () => {
    const plan = buildOrderPlan(twoFloors());
    const edited = plan.lines.map((l) => (l.itemName === '가상 과자 상자' ? { ...l, included: true } : l));
    const check = checkOrderPlan({ lines: edited }, { budget: plan.budget, floors: plan.basis });
    expect(check.total).toBe(66_400);
    expect(check.warnings).toContainEqual({ kind: 'over-budget', message: ORDER_MESSAGES.overBudget, locks: true });
    expect(check.locked).toBe(true);
  });

  it('[R1] 고쳐서 최소 몫에 못 미치면 경고만 띄워요', () => {
    const plan = buildOrderPlan(twoFloors());
    const edited = plan.lines.map((l) => (l.itemName === '가상 컵라면' ? { ...l, included: false } : l));
    const check = checkOrderPlan({ lines: edited }, { budget: plan.budget, floors: plan.basis });
    expect(check.warnings).toEqual([{ kind: 'floor-short', floor: '3층', message: ORDER_MESSAGES.floorShort, locks: false }]);
    expect(check.locked).toBe(false);
  });

  it('[R1] 못 채운 층에는 모두 경고가 붙어요', () => {
    const plan = buildOrderPlan(twoFloors());
    const none = plan.lines.map((l) => ({ ...l, included: false }));
    const check = checkOrderPlan({ lines: none }, { budget: plan.budget, floors: plan.basis });
    expect(check.floors.filter((f) => !f.met).map((f) => f.floor)).toEqual(['2층', '3층']);
    expect(check.warnings.map((w) => w.floor)).toEqual(['2층', '3층']);
  });
});
