import { ORDER_MESSAGES, type OrderFloorSummary, type OrderReasonCode, type OrderWarning } from '@one-line-desk/shared';

// 주문안 풀이(ADR-08, R1, D8 1단계 보정). DB·시계·LLM을 쓰지 않는 순수 함수예요.
// - 층 목표 = min(최소 몫, 그 층 카탈로그 요청 금액 합)
// - 꼭 채울 층: 층마다 "목표를 채우는 가장 싼 조합"의 금액(최소 비용)을 정확히 구해요(동적 계획법).
//   층 번호 순으로 최소 비용을 더해 예산 안에 드는 층이 꼭 채울 층이에요. 정수 계획이 "채울 수 있음"이면 모든 층이에요.
// - 1단계: 층 번호 순으로 그 층 묶음을 "표 ÷ 금액(한 묶음 단위)" 큰 순으로 넣어요. 넣은 뒤에도 남은 예산으로
//   "이 층의 남은 묶음으로 목표 채우기 + 뒤에 올 꼭 채울 층의 최소 비용"을 낼 수 있을 때만 넣고, 아니면 건너뛰어요.
//   층 금액이 목표에 닿으면 다음 층으로 가요(층 최소 몫). 이 검사가 정확해서 꼭 채울 층은 늘 목표에 닿아요.
// - 2단계: 남은 예산을 모든 층의 남은 묶음에 같은 순서로 채워요(표 대비 값). 못 넣은 건 예산 초과로 뺌이에요.
// - 카탈로그에 없는 묶음은 금액을 몰라 넣지 않아요(카탈로그에 없음).

export interface OrderBundleInput {
  /** 대표 카드 ID */
  bundleId: number;
  floor: string;
  name: string;
  catalogItemId: string | null;
  /** 개당 단가(원) */
  unitPrice: number | null;
  /** 한 묶음 단위 개수 */
  packUnit: number | null;
  votes: number;
  bundleVersion?: number;
}

export interface OrderPlanInput {
  budget: number;
  /** 층별 최소 몫(원). 없는 층은 0원이에요. */
  minShares: Readonly<Record<string, number>>;
  /** 열린 묶음. 주문안에 들어가는 층은 열린 묶음이 있는 층이에요. */
  bundles: readonly OrderBundleInput[];
}

/** 주문안을 만들 때 굳혀 두는 층별 기준. 총무가 줄을 고친 뒤 검사기도 이걸로 돌려요. */
export interface FloorBasis {
  floor: string;
  minShare: number;
  requested: number;
}

export interface OrderCheckInput {
  budget: number;
  floors: readonly FloorBasis[];
}

export interface PlannedLine {
  lineNo: number;
  bundleId: number;
  bundleVersion: number;
  floor: string;
  itemName: string;
  catalogItemId: string | null;
  votes: number;
  unitPrice: number | null;
  packUnit: number | null;
  quantity: number;
  amount: number;
  included: boolean;
  reason: OrderReasonCode;
  rank: number;
  edited: boolean;
}

/** 검사기가 보는 줄 칸 */
export type CheckedLine = Pick<PlannedLine, 'floor' | 'amount' | 'included'>;

export interface OrderCheck {
  total: number;
  floors: OrderFloorSummary[];
  warnings: OrderWarning[];
  locked: boolean;
}

export interface BuiltOrderPlan extends OrderCheck {
  budget: number;
  basis: FloorBasis[];
  lines: PlannedLine[];
}

interface Candidate {
  bundle: OrderBundleInput;
  /** 한 묶음 단위 금액 */
  cost: number;
  quantity: number;
}

/** "3층" → 3, "B1"·"지하1층" → -1. 숫자가 없으면 뒤로 가고 이름 순이에요. */
export function compareFloors(a: string, b: string): number {
  const key = (floor: string): number => {
    const basement = /^(?:B|지하)\s*(\d+)/i.exec(floor.trim());
    if (basement) return -Number(basement[1]);
    const n = /(\d+)/.exec(floor);
    return n ? Number(n[1]) : Number.POSITIVE_INFINITY;
  };
  const ka = key(a);
  const kb = key(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.localeCompare(b, 'ko');
}

/** 표 ÷ 금액 큰 순. 같으면 표 많은 순 → 금액 작은 순 → 먼저 만든 묶음(작은 ID) 순이에요. */
function compareValue(a: Candidate, b: Candidate): number {
  const cross = b.bundle.votes * a.cost - a.bundle.votes * b.cost;
  if (cross !== 0) return cross;
  if (a.bundle.votes !== b.bundle.votes) return b.bundle.votes - a.bundle.votes;
  if (a.cost !== b.cost) return a.cost - b.cost;
  return a.bundle.bundleId - b.bundle.bundleId;
}

function isPriced(b: OrderBundleInput): b is OrderBundleInput & { catalogItemId: string; unitPrice: number } {
  return b.catalogItemId !== null && b.unitPrice !== null && b.unitPrice > 0;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * 한 층의 "뒤에서부터 묶음을 골라 x원 이상 채우는 가장 싼 금액" 표(덮기 문제, 동적 계획법).
 * cover(i, x) = i번째부터 끝까지의 묶음으로 x원 이상을 채우는 최소 금액이에요. 못 채우면 Infinity예요.
 * 금액은 모든 묶음 금액의 최대공약수로 나눠 표 크기를 줄여요(카탈로그 단가는 보통 100원 단위예요).
 */
class FloorCover {
  private readonly unit: number;
  private readonly units: number[];
  /** table[i][u] = i번째부터 u단위 이상을 채우는 최소 단위 수 */
  private readonly table: Float64Array[];

  constructor(costs: readonly number[], target: number) {
    this.unit = costs.reduce((g, c) => gcd(g, c), 0) || 1;
    this.units = costs.map((c) => c / this.unit);
    const size = Math.ceil(target / this.unit);
    this.table = Array.from({ length: costs.length + 1 }, () => new Float64Array(size + 1));
    this.table[costs.length]!.fill(Number.POSITIVE_INFINITY);
    this.table[costs.length]![0] = 0;
    for (let i = costs.length - 1; i >= 0; i--) {
      const next = this.table[i + 1]!;
      const row = this.table[i]!;
      const c = this.units[i]!;
      for (let u = 0; u <= size; u++) row[u] = Math.min(next[u]!, c + next[Math.max(0, u - c)]!);
    }
  }

  /** i번째부터의 묶음으로 need원 이상 채우는 최소 금액(원) */
  cost(i: number, need: number): number {
    if (need <= 0) return 0;
    return this.table[i]![Math.ceil(need / this.unit)]! * this.unit;
  }
}

export function buildOrderPlan(input: OrderPlanInput): BuiltOrderPlan {
  const budget = Math.max(0, Math.trunc(input.budget));
  const floors = [...new Set(input.bundles.map((b) => b.floor))].sort(compareFloors);

  const priced = new Map<string, Candidate[]>();
  const unpriced = new Map<string, OrderBundleInput[]>();
  for (const floor of floors) {
    priced.set(floor, []);
    unpriced.set(floor, []);
  }
  for (const bundle of input.bundles) {
    if (isPriced(bundle)) {
      const quantity = Math.max(1, bundle.packUnit ?? 1);
      priced.get(bundle.floor)!.push({ bundle, quantity, cost: bundle.unitPrice * quantity });
    } else {
      unpriced.get(bundle.floor)!.push(bundle);
    }
  }
  for (const list of priced.values()) list.sort(compareValue);
  for (const list of unpriced.values()) list.sort((a, b) => b.votes - a.votes || a.bundleId - b.bundleId);

  const basis: FloorBasis[] = floors.map((floor) => ({
    floor,
    minShare: Math.max(0, Math.trunc(input.minShares[floor] ?? 0)),
    requested: priced.get(floor)!.reduce((sum, c) => sum + c.cost, 0),
  }));
  const target = new Map(basis.map((b) => [b.floor, Math.min(b.minShare, b.requested)]));
  const covers = new Map(
    floors.map(
      (f) =>
        [
          f,
          new FloorCover(
            priced.get(f)!.map((c) => c.cost),
            target.get(f)!,
          ),
        ] as const,
    ),
  );

  // 꼭 채울 층: 층 번호 순으로 최소 비용이 예산 안에 드는 층이에요. 정수 계획이 "채울 수 있음"이면 모든 층이 들어가요.
  const mustFill = new Set<string>();
  let reserved = 0;
  for (const floor of floors) {
    const least = covers.get(floor)!.cost(0, target.get(floor)!);
    if (reserved + least <= budget) {
      mustFill.add(floor);
      reserved += least;
    }
  }
  const laterReserve = (index: number) => floors.slice(index + 1).reduce((sum, f) => (mustFill.has(f) ? sum + covers.get(f)!.cost(0, target.get(f)!) : sum), 0);

  const chosen = new Map<number, OrderReasonCode>();
  let remaining = budget;

  // 1단계: 층 최소 몫. 넣어도 이 층(꼭 채울 층이면)과 뒤 꼭 채울 층을 끝까지 채울 수 있을 때만 넣어요.
  floors.forEach((floor, index) => {
    const list = priced.get(floor)!;
    const cover = covers.get(floor)!;
    const goal = target.get(floor)!;
    const later = laterReserve(index);
    let filled = 0;
    list.forEach((c, i) => {
      if (filled >= goal) return;
      const ownAfter = mustFill.has(floor) ? cover.cost(i + 1, goal - filled - c.cost) : 0;
      if (remaining - c.cost < ownAfter + later) return;
      chosen.set(c.bundle.bundleId, '층 최소 몫');
      remaining -= c.cost;
      filled += c.cost;
    });
  });

  // 2단계: 표 대비 값
  const rest = floors
    .flatMap((f) => priced.get(f)!)
    .filter((c) => !chosen.has(c.bundle.bundleId))
    .sort(compareValue);
  for (const c of rest) {
    if (c.cost <= remaining) {
      chosen.set(c.bundle.bundleId, '표 대비 값');
      remaining -= c.cost;
    } else {
      chosen.set(c.bundle.bundleId, '예산 초과로 뺌');
    }
  }

  const lines: PlannedLine[] = [];
  for (const floor of floors) {
    const ranked = priced.get(floor)!;
    ranked.forEach((c, i) => {
      const reason = chosen.get(c.bundle.bundleId)!;
      lines.push(
        toLine(lines.length + 1, c.bundle, {
          quantity: c.quantity,
          amount: c.cost,
          included: reason !== '예산 초과로 뺌',
          reason,
          rank: i + 1,
        }),
      );
    });
    unpriced.get(floor)!.forEach((bundle, i) => {
      lines.push(toLine(lines.length + 1, bundle, { quantity: 0, amount: 0, included: false, reason: '카탈로그에 없음', rank: ranked.length + i + 1 }));
    });
  }

  return { budget, basis, lines, ...checkOrderPlan({ lines }, { budget, floors: basis }) };
}

function toLine(lineNo: number, bundle: OrderBundleInput, rest: Pick<PlannedLine, 'quantity' | 'amount' | 'included' | 'reason' | 'rank'>): PlannedLine {
  return {
    lineNo,
    bundleId: bundle.bundleId,
    bundleVersion: bundle.bundleVersion ?? 0,
    floor: bundle.floor,
    itemName: bundle.name,
    catalogItemId: bundle.catalogItemId,
    votes: bundle.votes,
    unitPrice: bundle.unitPrice,
    packUnit: bundle.packUnit,
    edited: false,
    ...rest,
  };
}

/**
 * 검사기(R1). 처음 만든 주문안에도, 총무가 줄을 고친 뒤에도 돌려요.
 * 예산 < 최소 몫 합 → 경고 + 잠금, 합계 > 예산 → "예산을 넘었어요" + 잠금,
 * 최소 몫을 못 받은 층 → 층 경고(잠그지 않음). 못 채운 층에는 모두 경고가 붙어요.
 */
export function checkOrderPlan(plan: { lines: readonly CheckedLine[] }, input: OrderCheckInput): OrderCheck {
  const included = plan.lines.filter((l) => l.included);
  const total = included.reduce((sum, l) => sum + l.amount, 0);
  const floors: OrderFloorSummary[] = input.floors.map((b) => {
    const floorTotal = included.filter((l) => l.floor === b.floor).reduce((sum, l) => sum + l.amount, 0);
    return {
      floor: b.floor,
      minShare: b.minShare,
      requested: b.requested,
      target: Math.min(b.minShare, b.requested),
      total: floorTotal,
      met: floorTotal >= b.minShare,
    };
  });

  const warnings: OrderWarning[] = [];
  const minShareSum = input.floors.reduce((sum, b) => sum + b.minShare, 0);
  if (input.budget < minShareSum) warnings.push({ kind: 'budget-below-min-sum', message: ORDER_MESSAGES.budgetBelowMinSum, locks: true });
  if (total > input.budget) warnings.push({ kind: 'over-budget', message: ORDER_MESSAGES.overBudget, locks: true });
  for (const f of floors) {
    if (f.met) continue;
    const short = f.requested < f.minShare;
    warnings.push({
      kind: short ? 'floor-request-short' : 'floor-short',
      floor: f.floor,
      message: short ? ORDER_MESSAGES.floorRequestShort : ORDER_MESSAGES.floorShort,
      locks: false,
    });
  }
  return { total, floors, warnings, locked: warnings.some((w) => w.locks) };
}
