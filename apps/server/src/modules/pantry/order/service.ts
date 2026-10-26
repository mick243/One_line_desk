import { randomUUID } from 'node:crypto';
import { ORDER_CSV_HEADER, type OrderConfirmResponse, type OrderCycleChange, type OrderLine, type OrderPlanView } from '@one-line-desk/shared';
import type { AppContext } from '../../../context';
import type { Queryable } from '../../../core/db';
import { DeskError, notFound } from '../../../core/errors';
import type { DeskUser } from '../../../core/user';
import { listOpenBundles } from '../bundles';
import { lockCards } from '../repo';
import { editedSentence, type ExplainLine, explainLines, templateSentence } from './explain';
import { buildOrderPlan, checkOrderPlan } from './plan';
import {
  findCurrentPlan,
  findPlan,
  insertPlan,
  type LineRow,
  listLines,
  lockPlanCreation,
  markCardsOrdered,
  markConfirmed,
  type PlanRow,
  readMinShares,
  rollCycle,
  saveExplanations,
  updateLine,
} from './repo';

// 주문안 쓰기는 모두 고정 버튼 실행기(ctx.fixed.run)를 거쳐요(ADR-03, R2). 확정만 화면에서 확인 시트를 한 번 더 거쳐요.
// LLM 호출은 트랜잭션 밖에서 하고, 결과(숫자 검사를 지난 문장)만 저장해요.

const MAX_AMOUNT = 2_000_000_000;
/** 표 프로그램이 한글을 깨뜨리지 않게 CSV 앞에 붙이는 UTF-8 BOM */
const BOM = String.fromCharCode(0xfeff);
const STALE_MESSAGE = '주문안을 만든 뒤 판의 묶음이 바뀌었어요. 주문안을 다시 만들어 주세요';
const CLOSED_MESSAGE = '이미 확정했거나 새 주문안으로 바뀌었어요. 새로 불러왔어요';

type ConfirmSummary = Omit<OrderConfirmResponse, 'plan'>;

export function lineIdOf(lineNo: number): string {
  return `L${lineNo}`;
}

function lineNoOf(lineId: string): number {
  const m = /^L(\d{1,4})$/.exec(lineId);
  if (!m) throw notFound();
  return Number(m[1]);
}

function toExplainLine(l: LineRow): ExplainLine {
  return { lineId: lineIdOf(l.lineNo), itemName: l.itemName, floor: l.floor, votes: l.votes, amount: l.amount, reason: l.reason, rank: l.rank };
}

export function toView(plan: PlanRow, lines: readonly LineRow[]): OrderPlanView {
  const check = checkOrderPlan({ lines }, { budget: plan.budget, floors: plan.floorBasis });
  const viewLines: OrderLine[] = lines.map((l) => ({
    lineId: lineIdOf(l.lineNo),
    floor: l.floor,
    itemName: l.itemName,
    catalogItemId: l.catalogItemId,
    votes: l.votes,
    unitPrice: l.unitPrice,
    packUnit: l.packUnit,
    quantity: l.quantity,
    amount: l.amount,
    included: l.included,
    reason: l.reason,
    rank: l.rank,
    explanation: l.explanation,
    explanationSource: l.explanationSource,
    edited: l.edited,
  }));
  return {
    planId: plan.id,
    status: plan.status,
    budget: plan.budget,
    total: check.total,
    floors: check.floors,
    lines: viewLines,
    warnings: check.warnings,
    locked: plan.status === 'draft' ? check.locked : true,
    explained: plan.explained,
    createdAt: plan.createdAt,
    confirmedAt: plan.confirmedAt,
  };
}

/** CSV 칸. 스프레드시트 수식으로 읽히지 않게 =·+·-·@로 시작하는 글자 앞에 '를 붙여요. */
function csvCell(value: string | number): string {
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export class OrderService {
  constructor(private readonly ctx: AppContext) {}

  private ensureOn(): void {
    if (this.ctx.ops.get().modules.pantry !== 'on') throw new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
  }

  async view(planId: string, q: Queryable = this.ctx.db): Promise<OrderPlanView> {
    this.ensureOn();
    const plan = await findPlan(q, planId);
    if (!plan) throw notFound();
    return toView(plan, await listLines(q, planId));
  }

  async current(): Promise<OrderPlanView | null> {
    this.ensureOn();
    const plan = await findCurrentPlan(this.ctx.db);
    return plan ? toView(plan, await listLines(this.ctx.db, plan.id)) : null;
  }

  /** 예산을 받아 주문안을 짜요. 층별 최소 몫은 층 설정에서, 묶음은 listOpenBundles()에서 읽어요. 설명은 틀 문장으로 시작해요. */
  async create(user: DeskUser, budget: number): Promise<OrderPlanView> {
    const planId = await this.ctx.fixed.run(user, {
      module: 'pantry',
      action: 'order.create',
      run: async (q, now) => {
        // 동시에 두 번 만들어도 차례로 처리해요(L10). 묶음은 잠금 뒤에 읽어서 앞의 만들기가 끝난 뒤 상태예요.
        await lockPlanCreation(q);
        const bundles = await listOpenBundles(q);
        const minShares = await readMinShares(q);
        const built = buildOrderPlan({ budget, minShares, bundles });
        const id = randomUUID();
        await insertPlan(
          q,
          { id, budget: built.budget, floorBasis: built.basis, createdAt: new Date(now) },
          built.lines.map((l) => ({ ...l, explanation: templateSentence(l) })),
        );
        return id;
      },
    });
    return this.view(planId);
  }

  /** 줄 표가 먼저 나오고 설명 문장은 뒤에 채워요(화면설계 S4 로딩). 숫자 검사에 걸린 줄은 틀 문장이에요. */
  async explain(user: DeskUser, planId: string): Promise<OrderPlanView> {
    this.ensureOn();
    const plan = await findPlan(this.ctx.db, planId);
    if (!plan) throw notFound();
    if (plan.status !== 'draft' || plan.explained) return this.view(planId);

    const lines = (await listLines(this.ctx.db, planId)).filter((l) => !l.edited);
    const explained = await explainLines(this.ctx.gateway, lines.map(toExplainLine));
    const byLineNo = new Map(lines.map((l) => [l.lineNo, explained.get(lineIdOf(l.lineNo)) ?? { sentence: templateSentence(l), source: 'template' as const }]));
    await this.ctx.fixed.run(user, {
      module: 'pantry',
      action: 'order.explain',
      run: async (q) => {
        await saveExplanations(q, planId, byLineNo);
      },
    });
    return this.view(planId);
  }

  /** [빼기]. 고친 줄은 "총무가 고침" + 틀 문장이 되고 이유 코드는 그대로예요. */
  async removeLine(user: DeskUser, planId: string, lineId: string): Promise<OrderPlanView> {
    const lineNo = lineNoOf(lineId);
    await this.ctx.fixed.run(user, {
      module: 'pantry',
      action: 'order.line-remove',
      run: async (q) => {
        const line = await this.editableLine(q, planId, lineNo);
        if (!line.included) return;
        await updateLine(q, planId, lineNo, {
          included: false,
          quantity: line.quantity,
          amount: line.amount,
          explanation: editedSentence({ included: false, quantity: line.quantity, amount: line.amount }),
        });
      },
    });
    return this.view(planId);
  }

  /** [바꾸기]. 개수는 묶음 단위의 배수예요. 뺀 줄·예산 초과로 뺀 줄도 개수를 넣으면 다시 들어가요. */
  async changeLine(user: DeskUser, planId: string, lineId: string, quantity: number): Promise<OrderPlanView> {
    const lineNo = lineNoOf(lineId);
    await this.ctx.fixed.run(user, {
      module: 'pantry',
      action: 'order.line-change',
      run: async (q) => {
        const line = await this.editableLine(q, planId, lineNo);
        if (line.catalogItemId === null || line.unitPrice === null) throw new DeskError('not-in-catalog', 409, '카탈로그에 없는 품목은 수량을 바꿀 수 없어요');
        const pack = Math.max(1, line.packUnit ?? 1);
        if (quantity % pack !== 0) throw new DeskError('bad-quantity', 400, `묶음 단위(${pack}개)로 넣어 주세요`);
        const amount = line.unitPrice * quantity;
        if (amount > MAX_AMOUNT) throw new DeskError('bad-quantity', 400, '수량이 너무 커요');
        await updateLine(q, planId, lineNo, { included: true, quantity, amount, explanation: editedSentence({ included: true, quantity, amount }) });
      },
    });
    return this.view(planId);
  }

  private async editableLine(q: Queryable, planId: string, lineNo: number): Promise<LineRow> {
    const plan = await findPlan(q, planId, { lock: true });
    if (!plan) throw notFound();
    if (plan.status !== 'draft') throw new DeskError('order-closed', 409, CLOSED_MESSAGE);
    const line = (await listLines(q, planId)).find((l) => l.lineNo === lineNo);
    if (!line) throw notFound();
    return line;
  }

  /**
   * 확정(R16·D8). 검사기가 잠그면 거부해요. 주문에 들어간 묶음의 카드는 주문됨(표 닫힘)이 되고,
   * 주문안에 든 층마다 주기를 닫고 새 주기를 열어요. 나머지 카드와 표는 그대로 다음 주기로 넘어가요.
   */
  async confirm(user: DeskUser, planId: string): Promise<OrderConfirmResponse> {
    const summary = await this.ctx.fixed.run<ConfirmSummary>(user, {
      module: 'pantry',
      action: 'order.confirm',
      idempotencyKey: planId,
      resultCode: () => 'confirmed',
      run: async (q, now) => {
        const plan = await findPlan(q, planId, { lock: true });
        if (!plan) throw notFound();
        if (plan.status !== 'draft') throw new DeskError('order-closed', 409, CLOSED_MESSAGE);
        const lines = await listLines(q, planId);
        const check = checkOrderPlan({ lines }, { budget: plan.budget, floors: plan.floorBasis });
        if (check.locked) {
          throw new DeskError(
            'order-locked',
            409,
            check.warnings
              .filter((w) => w.locks)
              .map((w) => w.message)
              .join(' '),
          );
        }
        const included = lines.filter((l) => l.included);
        if (included.length === 0) throw new DeskError('order-empty', 409, '주문에 넣은 품목이 없어요');

        // 넣을 묶음의 대표 카드(와 지금 묶음 카드)를 ID 순서로 FOR UPDATE 잠근 뒤 묶음·버전을 다시 읽어요(M3, R3).
        // 합치기·되돌리기도 같은 순서로 잠가서, 겹치면 한쪽이 기다렸다가 바뀐 버전·상태를 보고 409가 돼요.
        // +1·거두기·게시는 대표 카드를 FOR SHARE로 잡아서 확정이 끝날 때까지 기다려요(M2).
        // 묶음 카드까지 같이 잠그는 건, 되돌리기가 묶인 카드를 먼저 잠그고 대표를 기다리는 동안 확정이 묶인 카드를 바꾸려다 서로 기다리지 않게 하려는 거예요.
        const seen = new Map((await listOpenBundles(q)).map((b) => [b.bundleId, b]));
        const locked = new Set(
          (
            await lockCards(
              q,
              included.flatMap((l) => [l.bundleId, ...(seen.get(l.bundleId)?.cardIds ?? [])]),
            )
          ).map((c) => c.id),
        );
        const open = new Map((await listOpenBundles(q)).map((b) => [b.bundleId, b]));
        const cardIds: number[] = [];
        for (const l of included) {
          const bundle = open.get(l.bundleId);
          if (!bundle || bundle.bundleVersion !== l.bundleVersion || bundle.floor !== l.floor) throw new DeskError('order-stale', 409, STALE_MESSAGE);
          // 버전이 같으면 묶음 카드도 같아요. 그래도 잠그지 못한 카드가 끼어 있으면 바꾸지 않아요.
          if (bundle.cardIds.some((id) => !locked.has(id))) throw new DeskError('order-stale', 409, STALE_MESSAGE);
          cardIds.push(...bundle.cardIds);
        }
        await markCardsOrdered(q, cardIds);

        const cycles: OrderCycleChange[] = [];
        for (const f of plan.floorBasis) cycles.push(await rollCycle(q, f.floor));
        await markConfirmed(q, planId, new Date(now));

        const ordered = new Set(included.map((l) => l.bundleId));
        const floors = new Set(plan.floorBasis.map((f) => f.floor));
        const carriedOverBundles = [...open.values()].filter((b) => floors.has(b.floor) && !ordered.has(b.bundleId)).length;
        return { orderedBundles: included.length, carriedOverBundles, cycles };
      },
    });
    return { plan: await this.view(planId), ...summary };
  }

  /** 파일 내보내기(CSV: 층·품목·카탈로그 ID·수량·금액). 투표자·표 수는 넣지 않아요. 확정한 주문안만 내보내요. */
  async exportCsv(planId: string): Promise<{ filename: string; body: string }> {
    this.ensureOn();
    const plan = await findPlan(this.ctx.db, planId);
    if (!plan) throw notFound();
    if (plan.status !== 'confirmed') throw new DeskError('order-not-confirmed', 409, '확정한 뒤에 내보낼 수 있어요');
    const lines = (await listLines(this.ctx.db, planId)).filter((l) => l.included);
    const rows = [
      ORDER_CSV_HEADER.map(csvCell).join(','),
      ...lines.map((l) => [l.floor, l.itemName, l.catalogItemId ?? '', l.quantity, l.amount].map(csvCell).join(',')),
    ];
    const day = (plan.confirmedAt ?? plan.createdAt).slice(0, 10).replaceAll('-', '');
    return { filename: `pantry-order-${day}.csv`, body: `${BOM}${rows.join('\r\n')}\r\n` };
  }
}
