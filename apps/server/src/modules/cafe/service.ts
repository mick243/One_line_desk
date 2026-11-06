import {
  type CafeBoardResponse,
  cafeLimitText,
  CAFE_LIMITS,
  CAFE_TEXT,
  type CafeMyOrder,
  type CafeOrderStatus,
  type CafeProposeRequest,
  type CafeProposeResponse,
  type CafeResponse,
  type CafeSlot,
  type Card,
  kstDate,
  kstTime,
  type PlanSheet,
  wonText,
} from '@one-line-desk/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import type { Queryable } from '../../core/db';
import { DeskError } from '../../core/errors';
import type { ExecContext, ExecOutcome, PlanHandler } from '../../core/module';
import type { DeskUser } from '../../core/user';
import { CafeBilling, type CafeGate } from './billing';
import { blockedCard, cafeLinkCard, cancelledCard, expiredCard, lineText, linesOf, orderedCard, slotLabel } from './cards';
import { CAFE_MENU_FIXTURES } from './fixtures';
import * as repo from './repo';

// F4 사내 카페 주문 1묶음(11/6, ADR-29): 직원이 주문하면 카페 판으로 가고, 바리스타가 만들어 건네요.
// 2묶음(11/6): 제안·확인 시트·실행 모두 미납 막힘(기한 지난 미납 청구서)과 한 달 한도를 다시 봐요(billing.ts gate).
// - 주문은 'cafeteria:order' plan(확인 시트 한 번)으로만 들어가요. 돈이 걸려서 자동 실행 허용 목록(ADR-19)에 넣지 않아요.
// - 영업 중(바리스타가 [영업 시작]을 누르고 카페 판이 2분 안에 서버에 보임)일 때만 제안·확인 시트·실행이 돼요. 실행은 트랜잭션 안에서 다시 봐요.
// - 금액은 서버가 메뉴 표의 지금 직원가 × 수량으로 계산해요. 토큰·화면이 보낸 값을 쓰지 않아요. AI는 부르지 않아요.
// - 취소(본인·접수 대기만)와 카페 판 쓰기(영업·상태·품절)는 고정 버튼(ctx.fixed)이에요. 카페 판 응답에는 이름·가명 ID·금액이 없어요.

const SLOT_MS = CAFE_LIMITS.slotMinutes * 60_000;
const KST_SLOT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+09:00$/;
const MENU_ID = /^[a-z0-9-]{1,40}$/;

/** 'cafeteria:order' plan 매개변수. 메뉴 ID·잔 수·옵션 이름·픽업 칸뿐이고 자유 문장 칸은 없어요. */
const OrderParamsSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        menuId: z.string().regex(MENU_ID),
        qty: z.number().int().min(1).max(CAFE_LIMITS.maxQty),
        options: z.array(z.string().min(1).max(20)).max(10),
      }),
    )
    .min(1)
    .max(CAFE_LIMITS.maxLines),
  pickupSlot: z.string().regex(KST_SLOT),
  /** 제안할 때 서버가 메뉴 직원가로 셈한 합계. 확인 시트·실행이 지금 값으로 다시 세서 다르면 막아요(본 값 = 실행 값, ADR-03). */
  quotedWon: z.number().int().min(0),
});
type OrderParams = z.infer<typeof OrderParamsSchema>;

const featureOff = () => new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
const closed = () => new DeskError('cafe-closed', 409, CAFE_TEXT.closed);
const slotPast = () => new DeskError('slot-past', 409, '고른 픽업 시간이 지났어요. 다시 골라 주세요');
const priceChanged = () => new DeskError('price-changed', 409, '메뉴 값이 바뀌었어요. 다시 골라 주세요');

/** 미납 막힘·한도 막힘을 오류로(제안·확인 시트). 막히지 않았으면 그대로 돌려줘요. */
function gateError(gate: CafeGate): Exclude<CafeGate, { block: 'unpaid' }> {
  if (gate.block === 'unpaid') throw new DeskError('cafe-unpaid', 409, CAFE_TEXT.unpaid);
  if (gate.block === 'limit') throw new DeskError('cafe-limit', 409, cafeLimitText(gate.limitWon));
  return gate;
}

/** 미납 막힘·한도 막힘을 막힘 카드로(실행). 주문은 들어가지 않아요. */
function gateCard(gate: CafeGate): Card | null {
  if (gate.block === 'unpaid') return blockedCard('unpaid', CAFE_TEXT.unpaid);
  if (gate.block === 'limit') return blockedCard('limit', cafeLimitText(gate.limitWon), [{ name: '남은 한도', value: wonText(gate.leftWon) }]);
  return null;
}

/** 바리스타가 영업 중이고(open) 카페 판이 2분 안에 서버에 보였을 때만 주문을 받아요(ADR-29). */
export function acceptingOrders(duty: repo.DutyRow, now: number): boolean {
  return duty.open && duty.lastSeenAt !== null && now - duty.lastSeenAt <= CAFE_LIMITS.boardSeenMs;
}

/** 고를 수 있는 픽업 칸: 지금 다음 10분 칸부터 12칸(칸 시작, ms) */
export function slotStarts(now: number): number[] {
  const first = (Math.floor(now / SLOT_MS) + 1) * SLOT_MS;
  return Array.from({ length: CAFE_LIMITS.slotCount }, (_, i) => first + i * SLOT_MS);
}

const kstIso = (at: number) => `${kstDate(at)}T${kstTime(at)}:00+09:00`;
/** 이번 달 1일(한국 날짜) */
const monthStart = (now: number) => `${kstDate(now).slice(0, 7)}-01`;

type Priced = { items: repo.OrderItem[]; totalWon: number; cups: number };
type PriceProblem = { problem: 'missing' | 'sold-out' | 'option'; name: string };

/** 메뉴 표의 지금 직원가로 줄마다 값을 매겨요. 금액은 여기서만 정해요(토큰·화면 값을 믿지 않아요). */
function price(lines: OrderParams['lines'], menu: Map<string, repo.MenuRow>): Priced | PriceProblem {
  const items: repo.OrderItem[] = [];
  for (const l of lines) {
    const m = menu.get(l.menuId);
    if (!m) return { problem: 'missing', name: '' };
    if (m.soldOut) return { problem: 'sold-out', name: m.name };
    if (new Set(l.options).size !== l.options.length || !l.options.every((o) => m.options.includes(o))) return { problem: 'option', name: m.name };
    // 옵션은 메뉴가 정한 순서로 남겨요.
    items.push({ menuId: m.id, name: m.name, priceWon: m.priceWon, qty: l.qty, options: m.options.filter((o) => l.options.includes(o)) });
  }
  return { items, totalWon: items.reduce((s, i) => s + i.priceWon * i.qty, 0), cups: items.reduce((s, i) => s + i.qty, 0) };
}

function problemError(p: PriceProblem): DeskError {
  if (p.problem === 'sold-out') return new DeskError('sold-out', 409, `품절된 메뉴가 있어요(${p.name}). 다른 메뉴를 골라 주세요`);
  if (p.problem === 'option') return new DeskError('bad-option', 400, `${p.name}에서 고를 수 없는 옵션이에요`);
  return new DeskError('menu-changed', 409, '메뉴가 바뀌었어요. 화면을 새로 고친 뒤 다시 골라 주세요');
}

function problemCard(p: PriceProblem): Card {
  if (p.problem === 'sold-out') return blockedCard('sold-out', '품절된 메뉴가 있어요', [{ name: '품절', value: p.name }]);
  return blockedCard('menu', '메뉴가 바뀌었어요');
}

const ids = (lines: OrderParams['lines']) => [...new Set(lines.map((l) => l.menuId))];

function slotFullMessage(next: number | null): string {
  return next ? `그 픽업 시간은 꽉 찼어요. 다음 칸(${kstTime(next)})을 골라 주세요` : '그 픽업 시간은 꽉 찼어요. 조금 뒤에 다시 골라 주세요';
}

export class CafeDesk {
  readonly billing: CafeBilling;

  constructor(private readonly ctx: AppContext) {
    this.billing = new CafeBilling(ctx);
  }

  /** 비어 있을 때만 가상 메뉴를 넣어요. */
  async seed(): Promise<void> {
    await this.ctx.db.tx(async (q) => {
      if ((await repo.countMenu(q)) === 0) await repo.insertMenu(q, CAFE_MENU_FIXTURES);
    });
  }

  private assertOn(): void {
    if (this.ctx.ops.get().modules.cafeteria !== 'on') throw featureOff();
  }

  private capacity(): number {
    return this.ctx.ops.get().values.cafeSlotCapacity;
  }

  /** 꽉 차지 않은 다음 칸(after 뒤, 고를 수 있는 12칸 안). 없으면 null이에요. */
  private async nextFree(q: Queryable, after: number, cups: number, now: number): Promise<number | null> {
    const starts = slotStarts(now).filter((s) => s > after);
    if (!starts.length) return null;
    const used = await repo.slotCups(q, starts[0]!, starts.at(-1)! + SLOT_MS);
    return starts.find((s) => (used.get(s) ?? 0) + cups <= this.capacity()) ?? null;
  }

  // ── 직원(S7) ─────────────────────────────────────────

  /** 카페 페이지. 끔이면 닫히고(409), 링크만이면 카페 안내 링크 카드예요. */
  async view(user: DeskUser): Promise<CafeResponse> {
    const s = this.ctx.ops.get();
    if (s.modules.cafeteria === 'off') throw featureOff();
    if (s.modules.cafeteria === 'link') return { status: 'link', card: cafeLinkCard(s.links.cafeteria) };
    const db = this.ctx.db;
    const now = this.ctx.now();
    const duty = await repo.getDuty(db);
    const menu = await repo.listMenu(db);
    const starts = slotStarts(now);
    const used = await repo.slotCups(db, starts[0]!, starts.at(-1)! + SLOT_MS);
    const cap = this.capacity();
    const slots: CafeSlot[] = starts.map((start) => {
      const left = Math.max(0, cap - (used.get(start) ?? 0));
      return { start: kstIso(start), label: kstTime(start), left, full: left === 0 };
    });
    const orders: CafeMyOrder[] = (await repo.myOrdersOn(db, user.pseudonymId, kstDate(now))).map((o) => ({
      id: o.id,
      pickupNo: o.pickupNo,
      lines: linesOf(o.items),
      pickupLabel: slotLabel(o.slot),
      status: o.status,
      totalWon: o.totalWon,
      cancellable: o.status === 'waiting',
    }));
    const monthTotalWon = await repo.monthTotal(db, user.pseudonymId, monthStart(now));
    return {
      status: 'on',
      open: acceptingOrders(duty, now),
      menu: menu.map((m) => ({ id: m.id, name: m.name, priceWon: m.priceWon, options: m.options, soldOut: m.soldOut })),
      slots,
      orders,
      monthTotalWon,
      billing: await this.billing.mine(user, monthTotalWon),
    };
  }

  /** [주문하기]: 고른 메뉴·픽업 칸을 검사하고 제안 토큰만 돌려줘요. DB에는 쓰지 않아요(확인 시트가 plan을 만들어요). */
  async propose(user: DeskUser, body: CafeProposeRequest): Promise<CafeProposeResponse> {
    this.assertOn();
    const db = this.ctx.db;
    const now = this.ctx.now();
    if (!acceptingOrders(await repo.getDuty(db), now)) throw closed();

    const keys = body.lines.map((l) => `${l.menuId}|${[...l.options].sort().join('·')}`);
    if (new Set(keys).size !== keys.length) throw new DeskError('bad-lines', 400, '같은 메뉴·옵션은 수량으로 골라 주세요');
    const slot = Date.parse(body.pickupSlot);
    if (!KST_SLOT.test(body.pickupSlot) || !slotStarts(now).includes(slot))
      throw new DeskError('bad-slot', 400, '고를 수 없는 픽업 시간이에요. 다시 골라 주세요');

    const priced = price(body.lines, await repo.menuByIds(db, ids(body.lines)));
    if ('problem' in priced) throw problemError(priced);
    gateError(await this.billing.gate(db, user.pseudonymId, now, priced.totalWon));
    const used = (await repo.slotCups(db, slot, slot + SLOT_MS)).get(slot) ?? 0;
    if (used + priced.cups > this.capacity()) throw new DeskError('slot-full', 409, slotFullMessage(await this.nextFree(db, slot, priced.cups, now)));

    const params: OrderParams = OrderParamsSchema.parse({
      lines: body.lines.map((l) => ({ menuId: l.menuId, qty: l.qty, options: l.options })),
      pickupSlot: kstIso(slot),
      quotedWon: priced.totalWon,
    });
    return { proposalToken: this.ctx.plans.propose(user, 'cafeteria', 'order', params) };
  }

  /** 확인 시트. 영업·품절·값·미납·한도·칸을 다시 보고, 메뉴·옵션·수량·합계·픽업 칸·이번 달 지금까지·남은 한도를 보여 줘요. */
  private async sheet(p: OrderParams, user: DeskUser): Promise<PlanSheet> {
    const db = this.ctx.db;
    const now = this.ctx.now();
    if (!acceptingOrders(await repo.getDuty(db), now)) throw closed();
    const slot = Date.parse(p.pickupSlot);
    if (slot + SLOT_MS <= now) throw slotPast();
    const priced = price(p.lines, await repo.menuByIds(db, ids(p.lines)));
    if ('problem' in priced) throw problemError(priced);
    if (priced.totalWon !== p.quotedWon) throw priceChanged();
    const gate = gateError(await this.billing.gate(db, user.pseudonymId, now, priced.totalWon));
    const used = (await repo.slotCups(db, slot, slot + SLOT_MS)).get(slot) ?? 0;
    if (used + priced.cups > this.capacity()) throw new DeskError('slot-full', 409, slotFullMessage(await this.nextFree(db, slot, priced.cups, now)));
    return {
      title: '이대로 주문할까요?',
      lines: [
        ...priced.items.map((i) => `${lineText(i)} · ${wonText(i.priceWon * i.qty)}`),
        `합계 ${wonText(priced.totalWon)}`,
        `픽업 ${slotLabel(slot)}`,
        `이번 달 지금까지 ${wonText(gate.monthWon)} · 남은 한도 ${wonText(gate.leftWon)}`,
      ],
      confirmLabel: '주문하기',
      note: CAFE_TEXT.sheetTail,
    };
  }

  /**
   * [주문하기] 실행(plan 트랜잭션 ex.q 안). 주문 잠금을 잡고 영업 중·품절·값·미납·한도·칸 상한을 다시 본 뒤 주문 행을 만들어요.
   * 같은 칸 동시 주문·같은 날 픽업 번호·한 사람의 두 탭 동시 주문(한 달 한도)은 잠금 하나로 한 번에 하나씩만 세요.
   * 청구서 발행도 같은 잠금을 잡아서, 말일 자정에 들어가는 주문이 청구에서 빠지지 않아요.
   */
  private async execute(p: OrderParams, ex: ExecContext): Promise<ExecOutcome> {
    await repo.lockOrders(ex.q);
    if (!acceptingOrders(await repo.getDuty(ex.q), ex.now)) return { status: 'blocked', card: blockedCard('closed', CAFE_TEXT.closed) };
    const slot = Date.parse(p.pickupSlot);
    if (slot + SLOT_MS <= ex.now) return { status: 'blocked', card: blockedCard('slot-past', '고른 픽업 시간이 지났어요') };
    const priced = price(p.lines, await repo.menuByIds(ex.q, ids(p.lines)));
    if ('problem' in priced) return { status: 'blocked', card: problemCard(priced) };
    if (priced.totalWon !== p.quotedWon)
      return { status: 'blocked', card: blockedCard('price', '메뉴 값이 바뀌었어요', [{ name: '지금 합계', value: wonText(priced.totalWon) }]) };
    const gated = gateCard(await this.billing.gate(ex.q, ex.user.pseudonymId, ex.now, priced.totalWon));
    if (gated) return { status: 'blocked', card: gated };
    const used = (await repo.slotCups(ex.q, slot, slot + SLOT_MS)).get(slot) ?? 0;
    if (used + priced.cups > this.capacity()) {
      const next = await this.nextFree(ex.q, slot, priced.cups, ex.now);
      return {
        status: 'blocked',
        card: blockedCard('slot-full', '그 픽업 시간은 꽉 찼어요', next ? [{ name: '비어 있는 다음 칸', value: slotLabel(next) }] : []),
      };
    }
    const day = kstDate(ex.now);
    const pickupNo = await repo.nextPickupNo(ex.q, day);
    const id = await repo.insertOrder(ex.q, {
      pseudonymId: ex.user.pseudonymId,
      subject: ex.user.idpSubject,
      planId: ex.planId,
      day,
      pickupNo,
      items: priced.items,
      totalWon: priced.totalWon,
      cups: priced.cups,
      slot,
      now: ex.now,
    });
    if (!id) throw new DeskError('in-progress', 409, '이미 들어간 주문이에요');
    return { status: 'done', card: orderedCard({ id, pickupNo, items: priced.items, totalWon: priced.totalWon, slot }) };
  }

  /** 'cafeteria:order' plan 처리기. 자동 실행 허용 목록이 아니에요(돈이 걸려요, ADR-29). */
  orderHandler(): PlanHandler<OrderParams> {
    return {
      module: 'cafeteria',
      action: 'order',
      schema: OrderParamsSchema,
      sheet: (p, user) => this.sheet(p, user),
      execute: (p, ex) => this.execute(p, ex),
      reSearch: async () => [expiredCard()],
    };
  }

  /** [취소](고정 버튼, 확인 시트 뒤): 내 주문이고 카페가 받기 전(접수 대기)일 때만이에요. */
  async cancel(user: DeskUser, id: string): Promise<{ status: 'done'; card: Card }> {
    return this.ctx.fixed.run(user, {
      module: 'cafeteria',
      action: 'order-cancel',
      idempotencyKey: id,
      async run(q, now) {
        const row = await repo.cancelMine(q, id, user.pseudonymId, now);
        if (row) return { status: 'done' as const, card: cancelledCard(row) };
        const status = await repo.myOrderStatus(q, id, user.pseudonymId);
        if (!status) throw new DeskError('not-found', 404, '취소할 주문을 찾지 못했어요');
        throw new DeskError('cafe-taken', 409, status === 'cancelled' ? '이미 취소한 주문이에요' : '카페가 이미 받아서 취소할 수 없어요');
      },
    });
  }

  // ── 바리스타(S8) ─────────────────────────────────────

  /** 카페 판(3초마다). 영업 중이면 부를 때마다 "판이 보였어요"를 남겨요. 응답에는 이름·가명 ID·금액이 없어요. */
  async board(): Promise<CafeBoardResponse> {
    this.assertOn();
    const db = this.ctx.db;
    const now = this.ctx.now();
    const duty = await repo.getDuty(db);
    if (duty.open) await repo.touchSeen(db, now);
    const orders = await repo.boardOrders(db, kstDate(now));
    const menu = await repo.listMenu(db);
    return {
      open: duty.open,
      orders: orders.map((o) => ({
        id: o.id,
        pickupNo: o.pickupNo,
        lines: linesOf(o.items),
        pickupLabel: slotLabel(o.slot),
        status: o.status as 'waiting' | 'making' | 'ready',
        orderedAt: kstTime(o.createdAt),
      })),
      menu: menu.map((m) => ({ id: m.id, name: m.name, soldOut: m.soldOut })),
    };
  }

  /** [영업 시작]·[영업 끝](고정 버튼) */
  async setOpen(user: DeskUser, open: boolean): Promise<{ open: boolean }> {
    return this.ctx.fixed.run(user, {
      module: 'cafeteria',
      action: open ? 'duty-open' : 'duty-close',
      async run(q, now) {
        await repo.setOpen(q, open, now);
        return { open };
      },
    });
  }

  /**
   * 주문 상태 한 단계(고정 버튼): 접수 대기 → 만드는 중 → 나왔어요 → 가져감. 건너뛰거나 되돌리지 않아요(409).
   * 바로 앞 상태일 때만 바꿔서(조건부 UPDATE) 두 번 눌러도 한 번만 바뀌어요. 이미 그 상태면 바꾸지 않고 그대로 돌려줘요(알림도 다시 안 가요).
   * 나왔어요가 되면 주문한 사람에게만 앱 알림이 가요. 알림 제목은 "주문한 음료가 나왔어요"(종류만)이고 메뉴·금액은 없어요. 기기 알림은 늘 "새 알림이 있어요"예요(ADR-16).
   */
  async advance(user: DeskUser, id: string, to: 'making' | 'ready' | 'picked'): Promise<{ id: string; status: CafeOrderStatus }> {
    const from: CafeOrderStatus = to === 'making' ? 'waiting' : to === 'ready' ? 'making' : 'ready';
    const notify = this.ctx.notify;
    let how: string = to;
    return this.ctx.fixed.run(user, {
      module: 'cafeteria',
      action: 'order-status',
      resultCode: () => how,
      async run(q, now) {
        const orderer = await repo.advanceStatus(q, id, from, to, now);
        if (!orderer) {
          const status = await repo.orderStatus(q, id);
          if (!status) throw new DeskError('not-found', 404, '주문을 찾지 못했어요');
          if (status !== to) throw new DeskError('bad-transition', 409, '이미 바뀐 주문이에요. 판을 새로 볼게요');
          how = 'same';
          return { id, status: to };
        }
        if (to === 'ready') await notify.toUser(q, orderer, { module: 'cafeteria', title: CAFE_TEXT.notify, page: 'cafe' });
        return { id, status: to };
      },
    });
  }

  /** 품절 바꾸기(고정 버튼). 품절이면 새 제안·실행이 막혀요. */
  async setSoldOut(user: DeskUser, id: string, soldOut: boolean): Promise<{ id: string; soldOut: boolean }> {
    return this.ctx.fixed.run(user, {
      module: 'cafeteria',
      action: 'menu-sold-out',
      resultCode: () => (soldOut ? 'sold-out' : 'available'),
      async run(q) {
        if (!(await repo.setSoldOut(q, id, soldOut))) throw new DeskError('not-found', 404, '없는 메뉴예요');
        return { id, soldOut };
      },
    });
  }
}
