import { randomInt } from 'node:crypto';
import {
  addDays,
  CAFE_BILLING_LIMITS,
  CAFE_TEXT,
  type CafeAdminMenuItem,
  type CafeBill,
  type CafeBillStatus,
  type CafeLimitRequestStatus,
  type CafeMenuInput,
  type CafeMyBilling,
  type CafeSettleResponse,
  checkInput,
  dayLabel,
  formatKstDateTime,
  kstDate,
  recordCutoff,
  wonText,
} from '@one-line-desk/shared';
import type { AppContext } from '../../context';
import type { AccessEntry } from '../../core/access-record';
import type { Queryable } from '../../core/db';
import { DeskError } from '../../core/errors';
import type { DeskUser } from '../../core/user';
import { linesOf } from './cards';
import * as repo from './repo';

// F4 사내 카페 2묶음(11/6, ADR-29): 청구·입금 확인·한 달 한도·미납 막기·알림·보관·총무 정산.
// - 앱은 돈을 받거나 보내지 않아요. 직원이 회사 계좌로 이체하면 총무(facilities)가 통장을 보고 [입금 확인](고정 버튼)을 눌러요.
// - 합계·한도·기한은 서버가 규칙으로 계산해요. AI(ctx.gateway)는 부르지 않고, 금액·청구를 AI에 보내지 않아요.
// - 사람별 청구액은 본인 화면이 원칙이에요. 총무만 정산 화면(S9)에서 이름·청구액·입금 코드·납부 상태를 보고, 볼 때마다 접속기록(가명 ID)에 남아요.
// - 알림 제목은 종류만이에요(금액·메뉴·입금 코드 없음). 청구 알림은 본인에게만, 한도 요청 알림은 총무 역할에만 가요.

/** 입금자명에 넣을 짧은 코드. 헷갈리는 글자(0·O·1·I·2·Z·5·S·8·B)는 빼요. */
const CODE_LETTERS = 'ACDEFGHJKLMNPQRTUVWXY34679';
const CODE_LENGTH = 5;
const DAY_MS = 24 * 60 * 60_000;
const MENU_ID_LETTERS = 'abcdefghijkmnpqrstuvwxyz23456789';

type From = Pick<AccessEntry, 'ip' | 'requestId'>;

/** 주문 문: 기한 지난 미납이 있으면 막고(unpaid), 이번 달 합계 + 이번 주문이 한도를 넘으면 막아요(limit). */
export type CafeGate = { block: 'unpaid' } | { block: 'limit' | null; limitWon: number; leftWon: number; monthWon: number };

const monthOfDay = (day: string) => day.slice(0, 7);

/** 'YYYY-MM' 바로 앞 달 */
export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** "10월"(올해가 아니면 "2025년 12월") */
export function monthLabel(month: string, today: string): string {
  const [y, m] = month.split('-');
  return y === today.slice(0, 4) ? `${Number(m)}월` : `${y}년 ${Number(m)}월`;
}

/** 두 한국 날짜 사이 날 수(b - a) */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

function billStatus(b: Pick<repo.BillRow, 'status' | 'dueOn'>, today: string): CafeBillStatus {
  if (b.status === 'paid') return 'paid';
  return b.dueOn < today ? 'overdue' : 'unpaid';
}

const STATUS_ORDER: Record<CafeBillStatus, number> = { overdue: 0, unpaid: 1, paid: 2 };

function randomText(letters: string, length: number): string {
  return Array.from({ length }, () => letters[randomInt(letters.length)]).join('');
}

const featureOff = () => new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');

/** 메뉴 이름·옵션 다듬기와 검사. 공통 입력 검사(ADR-11)에 걸리면 내용 없이 거부해요. */
function cleanMenu(input: CafeMenuInput): { name: string; priceWon: number; options: string[] } {
  const name = input.name.trim();
  const options = input.options.map((o) => o.trim());
  if (!name || name.length > CAFE_BILLING_LIMITS.menuNameMax)
    throw new DeskError('bad-menu', 400, `메뉴 이름은 1~${CAFE_BILLING_LIMITS.menuNameMax}자로 적어 주세요`);
  if (options.length > CAFE_BILLING_LIMITS.maxOptions || options.some((o) => !o || o.length > CAFE_BILLING_LIMITS.optionNameMax))
    throw new DeskError('bad-menu', 400, `옵션은 ${CAFE_BILLING_LIMITS.maxOptions}개까지, 하나에 ${CAFE_BILLING_LIMITS.optionNameMax}자까지예요`);
  if (new Set(options).size !== options.length) throw new DeskError('bad-menu', 400, '같은 옵션이 두 번 있어요');
  // 메뉴는 모든 직원에게 보여서, 잠그는 글자(주민번호·카드 번호 등)뿐 아니라 가리는 글자(메일·IP 등)·안 보이는 글자도 받지 않아요.
  const blocked = (t: string) => {
    const r = checkInput(t);
    return r.locks.length > 0 || Object.values(r.masked).some((n) => n > 0) || r.text !== t;
  };
  if ([name, ...options].some(blocked)) throw new DeskError('locked', 400, '올릴 수 없는 글자가 있어요');
  if (!Number.isInteger(input.priceWon) || input.priceWon < 0 || input.priceWon > CAFE_BILLING_LIMITS.maxPriceWon)
    throw new DeskError('bad-menu', 400, `직원가는 0~${wonText(CAFE_BILLING_LIMITS.maxPriceWon)} 사이로 적어 주세요`);
  return { name, priceWon: input.priceWon, options };
}

const adminItem = (m: repo.AdminMenuRow): CafeAdminMenuItem => ({
  id: m.id,
  name: m.name,
  priceWon: m.priceWon,
  options: m.options,
  soldOut: m.soldOut,
  active: m.active,
});

/** CSV 칸. 스프레드시트 수식으로 읽히지 않게 =·+·-·@로 시작하는 글자 앞에 '를 붙여요. */
function csvCell(value: string | number): string {
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** 엑셀이 한글을 깨뜨리지 않게 붙이는 UTF-8 표시 */
const BOM = String.fromCharCode(0xfeff);
const SALES_CSV_HEADER = ['날짜', '메뉴', '잔 수', '금액(원)'];

export class CafeBilling {
  constructor(private readonly ctx: AppContext) {}

  private assertOn(): void {
    if (this.ctx.ops.get().modules.cafeteria !== 'on') throw featureOff();
  }

  /** 이 사람의 그 달 한도: 운영 값과 그 달 늘린 한도 중 큰 값 */
  async limitOf(q: Queryable, pseudonymId: string, month: string): Promise<number> {
    const raised = await repo.monthLimit(q, pseudonymId, month);
    return Math.max(this.ctx.ops.get().values.cafeMonthlyLimitWon, raised ?? 0);
  }

  /**
   * 주문 문(제안·확인 시트·실행이 같이 써요). 실행은 주문 잠금(lockOrders) 안에서 불러서, 두 탭에서 동시에 주문해도 한도를 넘지 않아요.
   * 1. 기한이 지난 미납 청구서가 있으면 막아요(기한 다음 날부터, [입금 확인]을 누르면 바로 풀려요).
   * 2. 이번 달 지금까지(주문 행, 취소 뺌) + 이번 주문이 이번 달 한도를 넘으면 막아요.
   */
  async gate(q: Queryable, pseudonymId: string, now: number, addWon: number): Promise<CafeGate> {
    const today = kstDate(now);
    if (await repo.hasOverdue(q, pseudonymId, today)) return { block: 'unpaid' };
    const month = monthOfDay(today);
    const monthWon = await repo.monthTotal(q, pseudonymId, `${month}-01`);
    const limitWon = await this.limitOf(q, pseudonymId, month);
    const leftWon = Math.max(0, limitWon - monthWon);
    return { block: monthWon + addWon > limitWon ? 'limit' : null, limitWon, leftWon, monthWon };
  }

  // ── 직원(S7 내 청구) ─────────────────────────────────

  /** 내 청구(본인만): 이번 달 한도·남은 한도·지난 청구서(건별 내역)·회사 계좌 안내·내 한도 요청 */
  async mine(user: DeskUser, monthWon: number): Promise<CafeMyBilling> {
    const db = this.ctx.db;
    const settings = this.ctx.ops.get();
    const today = kstDate(this.ctx.now());
    const month = monthOfDay(today);
    const limitWon = await this.limitOf(db, user.pseudonymId, month);
    // 0원 청구서는 낼 게 없어서 보여 주지 않아요(처음부터 입금 확인이고 7일 뒤 지워져요).
    const rows = (await repo.myBills(db, user.pseudonymId)).filter((b) => b.totalWon > 0);
    const orders = rows.length
      ? await repo.billOrders(
          db,
          user.pseudonymId,
          rows.map((b) => b.month),
        )
      : [];
    const bills: CafeBill[] = rows.map((b) => ({
      id: b.id,
      month: b.month,
      monthLabel: monthLabel(b.month, today),
      totalWon: b.totalWon,
      count: b.count,
      code: b.code,
      dueLabel: dayLabel(b.dueOn),
      status: billStatus(b, today),
      orders: orders.filter((o) => o.month === b.month).map((o) => ({ dayLabel: dayLabel(o.day), lines: linesOf(o.items), totalWon: o.totalWon })),
    }));
    const request = await repo.myLimitRequest(db, user.pseudonymId, month);
    return {
      limitWon,
      leftWon: Math.max(0, limitWon - monthWon),
      blocked: bills.some((b) => b.status === 'overdue'),
      bills,
      account: settings.cafeAccount || CAFE_TEXT.accountFallback,
      dueDays: settings.values.cafeDueDays,
      request: request ? { amountWon: request.amountWon, status: request.status } : null,
    };
  }

  /**
   * [한도 늘려 달라고 하기](고정 버튼): 그 달 한도로 바라는 금액만 받아요(사유 글 없음). 지금 한도보다 커야 하고, 대기 중 요청은 하나뿐이에요.
   * 총무 역할에게 "카페 한도 요청이 왔어요"(이름·금액 없음)가 가요.
   */
  async requestLimit(user: DeskUser, amountWon: number): Promise<{ status: CafeLimitRequestStatus; amountWon: number }> {
    const ctx = this.ctx;
    return ctx.fixed.run(user, {
      module: 'cafeteria',
      action: 'limit-request',
      run: async (q, now) => {
        const month = monthOfDay(kstDate(now));
        const limit = await this.limitOf(q, user.pseudonymId, month);
        if (amountWon <= limit) throw new DeskError('bad-amount', 400, `지금 한도(${wonText(limit)})보다 큰 금액을 적어 주세요`);
        const id = await repo.insertLimitRequest(q, { pseudonymId: user.pseudonymId, subject: user.idpSubject, month, amountWon, now });
        if (!id) throw new DeskError('already-requested', 409, '이미 보낸 한도 요청이 있어요. 총무가 처리하면 알려 드려요');
        await ctx.notify.toRole(q, 'facilities', { module: 'cafeteria', title: CAFE_TEXT.notifyLimitRequest, page: 'cafe-settle' }, user.pseudonymId);
        return { status: 'pending' as const, amountWon };
      },
    });
  }

  // ── 총무(S9 카페 정산) ───────────────────────────────

  /** 디렉터리에서 이름을 그때 붙여요(저장하지 않아요). 퇴사했거나 주체가 없으면 "찾지 못한 사람"이에요. */
  private async namesOf(subjects: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(subjects.filter((s): s is string => s !== null))];
    const profiles = await Promise.all(unique.map((s) => this.ctx.adapters.directory.getProfile(s)));
    return new Map(unique.map((s, i) => [s, profiles[i]?.displayName ?? '찾지 못한 사람']));
  }

  /**
   * 정산 화면(총무만, 등급 2 예외): 고른 달 청구서(이름·청구액·입금 코드·납부 상태)와 한도 요청, 메뉴·직원가 관리.
   * 열 때마다 접속기록 cafe.settle에 본 사람들의 가명 ID만 남겨요(금액·이름 없음).
   */
  async settle(user: DeskUser, month: string | undefined, from: From): Promise<CafeSettleResponse> {
    this.assertOn();
    const db = this.ctx.db;
    const today = kstDate(this.ctx.now());
    const thisMonth = monthOfDay(today);
    const lastMonth = prevMonth(thisMonth);
    const chosen = month ?? lastMonth;
    const bills = (await repo.billsOfMonth(db, chosen)).filter((b) => b.totalWon > 0);
    const requests = await repo.limitRequests(db);
    const names = await this.namesOf([...bills.map((b) => b.subject), ...requests.map((r) => r.subject)]);
    const nameOf = (subject: string | null) => (subject ? (names.get(subject) ?? '찾지 못한 사람') : '찾지 못한 사람');
    const limits = await Promise.all(requests.map((r) => this.limitOf(db, r.pseudonymId, r.month)));
    const months = [...new Set([thisMonth, lastMonth, chosen, ...(await repo.billMonths(db))])].sort().reverse();

    const rows = bills
      .map((b) => ({
        id: b.id,
        name: nameOf(b.subject),
        totalWon: b.totalWon,
        count: b.count,
        code: b.code,
        dueLabel: dayLabel(b.dueOn),
        status: billStatus(b, today),
        paidLabel: b.paidAt === null ? null : formatKstDateTime(b.paidAt),
      }))
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name, 'ko') || Number(a.id) - Number(b.id));

    await this.ctx.access.recordMany({
      pseudonymId: user.pseudonymId,
      action: 'cafe.settle',
      subjectRefs: [...new Set([...bills.map((b) => b.pseudonymId), ...requests.map((r) => r.pseudonymId)])].map((p) => `person:${p}`),
      ...from,
    });

    return {
      month: chosen,
      monthLabel: monthLabel(chosen, today),
      months: months.map((m) => ({ month: m, label: monthLabel(m, today) })),
      bills: rows,
      summary: {
        count: rows.length,
        totalWon: rows.reduce((s, b) => s + b.totalWon, 0),
        paidWon: rows.filter((b) => b.status === 'paid').reduce((s, b) => s + b.totalWon, 0),
        overdue: rows.filter((b) => b.status === 'overdue').length,
      },
      requests: requests.map((r, i) => ({
        id: r.id,
        name: nameOf(r.subject),
        monthLabel: monthLabel(r.month, today),
        amountWon: r.amountWon,
        limitWon: limits[i]!,
        status: r.status,
        createdLabel: formatKstDateTime(r.createdAt),
        current: r.month === thisMonth,
      })),
      menu: (await repo.listAllMenu(db)).map(adminItem),
      salesMonth: lastMonth,
      salesMonthLabel: monthLabel(lastMonth, today),
    };
  }

  /**
   * [입금 확인](고정 버튼, 총무): 통장에 들어온 것을 본 총무가 눌러요. 누르면 그 사람의 주문 막힘이 바로 풀려요.
   * 두 번 눌러도 한 번이에요. 본인에게 "카페 값 입금을 확인했어요"(금액 없음)가 가고, 접속기록 cafe.update에 가명 ID가 남아요.
   */
  async markPaid(user: DeskUser, id: string, from: From): Promise<{ id: string; status: 'paid' }> {
    const ctx = this.ctx;
    let how = 'paid';
    return ctx.fixed.run(user, {
      module: 'cafeteria',
      action: 'bill-paid',
      idempotencyKey: id,
      resultCode: () => how,
      async run(q, now) {
        const owner = await repo.markPaid(q, id, now);
        if (owner) {
          await ctx.notify.toUser(q, owner, { module: 'cafeteria', title: CAFE_TEXT.notifyPaid, page: 'cafe' });
          await ctx.access.record({ pseudonymId: user.pseudonymId, action: 'cafe.update', subjectRefs: [`person:${owner}`], ...from }, q);
          return { id, status: 'paid' as const };
        }
        const row = await repo.billOwner(q, id);
        if (!row) throw new DeskError('not-found', 404, '청구서를 찾지 못했어요');
        how = 'same';
        return { id, status: 'paid' as const };
      },
    });
  }

  /**
   * [늘려 주기]·[안 돼요](고정 버튼, 총무). 늘린 한도는 그 달에만 써서, 지난달 요청은 늘릴 수 없어요.
   * 내 요청은 내가 처리하지 않아요(다른 총무가 해요). 요청한 사람에게 결과 알림(금액 없음)이 가요.
   */
  async decideLimit(user: DeskUser, id: string, decision: 'approved' | 'rejected', from: From): Promise<{ id: string; status: CafeLimitRequestStatus }> {
    const ctx = this.ctx;
    let how: string = decision;
    return ctx.fixed.run(user, {
      module: 'cafeteria',
      action: decision === 'approved' ? 'limit-approve' : 'limit-reject',
      idempotencyKey: id,
      resultCode: () => how,
      async run(q, now) {
        const r = await repo.limitRequest(q, id);
        if (!r) throw new DeskError('not-found', 404, '한도 요청을 찾지 못했어요');
        if (r.pseudonymId === user.pseudonymId) throw new DeskError('own-request', 403, '내 한도 요청은 다른 총무가 처리해요');
        if (r.status !== 'pending') {
          if (r.status !== decision) throw new DeskError('already-decided', 409, '이미 처리한 한도 요청이에요');
          how = 'same';
          return { id, status: r.status };
        }
        if (decision === 'approved' && r.month !== monthOfDay(kstDate(now)))
          throw new DeskError('past-month', 409, '지난달 요청이라 늘릴 수 없어요. 늘린 한도는 그 달에만 써요');
        if (!(await repo.decideLimitRequest(q, id, decision, now))) throw new DeskError('already-decided', 409, '이미 처리한 한도 요청이에요');
        if (decision === 'approved') await repo.raiseMonthLimit(q, r.pseudonymId, r.month, r.amountWon);
        await ctx.notify.toUser(q, r.pseudonymId, {
          module: 'cafeteria',
          title: decision === 'approved' ? CAFE_TEXT.notifyLimitApproved : CAFE_TEXT.notifyLimitRejected,
          page: 'cafe',
        });
        await ctx.access.record({ pseudonymId: user.pseudonymId, action: 'cafe.update', subjectRefs: [`person:${r.pseudonymId}`], ...from }, q);
        return { id, status: decision };
      },
    });
  }

  /** 메뉴 더하기(고정 버튼, 총무). 이름·옵션은 공통 입력 검사를 지나야 해요. 감사 로그에는 이름·값이 없어요. */
  async addMenu(user: DeskUser, input: CafeMenuInput): Promise<CafeAdminMenuItem> {
    const m = cleanMenu(input);
    return this.ctx.fixed.run(user, {
      module: 'cafeteria',
      action: 'menu-add',
      async run(q) {
        const row = await repo.addMenu(q, { id: `m-${randomText(MENU_ID_LETTERS, 8)}`, ...m, sort: await repo.nextMenuSort(q) });
        if (!row) throw new DeskError('in-progress', 409, '지금 더하지 못했어요. 다시 눌러 주세요');
        return adminItem(row);
      },
    });
  }

  /**
   * 메뉴 이름·직원가·옵션·파는지 바꾸기(고정 버튼, 총무). 값이 바뀌면 이미 연 확인 시트는 실행 때 "본 값 = 실행 값" 검사로 막혀요(1묶음).
   * 쓰지 않게 하면 메뉴에서 빠져요(지난 주문·청구서에는 주문한 때 이름·값이 남아 있어요).
   */
  async updateMenu(user: DeskUser, id: string, input: CafeMenuInput): Promise<CafeAdminMenuItem> {
    const m = cleanMenu(input);
    return this.ctx.fixed.run(user, {
      module: 'cafeteria',
      action: 'menu-update',
      async run(q) {
        const row = await repo.updateMenu(q, id, { ...m, active: input.active ?? true });
        if (!row) throw new DeskError('not-found', 404, '없는 메뉴예요');
        return adminItem(row);
      },
    });
  }

  /**
   * [지난달 매출 합계 내려받기](총무): 날·메뉴별 잔 수·금액 CSV. 이름·가명 ID는 없어요. 회사 장부 5년은 회사 회계가 맡아요.
   * [입금 확인] 7일 뒤 주문 상세를 지워서, 청구서가 나온 뒤 7일 안에 받아야 그 달 주문이 모두 들어 있어요. 접속기록 cafe.sales에 남아요.
   */
  async salesCsv(user: DeskUser, month: string, from: From): Promise<{ filename: string; body: string }> {
    this.assertOn();
    const rows = await repo.salesOf(this.ctx.db, month);
    await this.ctx.access.record({ pseudonymId: user.pseudonymId, action: 'cafe.sales', ...from });
    const total = rows.reduce((s, r) => ({ cups: s.cups + r.cups, won: s.won + r.won }), { cups: 0, won: 0 });
    const lines = [
      SALES_CSV_HEADER.map(csvCell).join(','),
      ...rows.map((r) => [r.day, r.name, r.cups, r.won].map(csvCell).join(',')),
      ['합계', '', total.cups, total.won].map(csvCell).join(','),
    ];
    return { filename: `cafe-sales-${month}.csv`, body: `${BOM}${lines.join('\r\n')}\r\n` };
  }

  // ── 정해진 시각 작업(서버의 한 시간 회차, app.ts runRetention → 모듈 retention) ──

  /**
   * 한 시간마다 서버가 불러요. 회차가 한 시간이라 1일 청구·기한 알림은 정한 때보다 최대 한 시간 늦을 수 있어요.
   * 1. 청구서 발행: 1일 0시(한국) 뒤 처음 돌 때 지난달(과 그 앞에 못 낸) 주문으로 청구서를 만들어요. (사람, 달) unique라 다시 돌아도 한 번이에요.
   * 2. 알림: 기한 다음 날 한 번, 그 뒤 주 1회(미납인 동안). 보낸 기록이 있어 다시 돌아도 한 번이에요.
   * 1·2는 카페가 '켬'일 때만 해요(끔·링크만이면 청구 화면이 없어서요). 켜지면 밀린 달을 한꺼번에 청구해요.
   * 3. 보관 지우기는 늘 해요: 취소 주문 7일, [입금 확인] 7일 뒤 청구서·그 달 주문, 한도 요청 7일, 지난달 늘린 한도.
   */
  async run(): Promise<void> {
    const db = this.ctx.db;
    const now = this.ctx.now();
    const cutoff = recordCutoff(now);
    await repo.purgeCancelled(db, cutoff);
    if (this.ctx.ops.get().modules.cafeteria === 'on') {
      await this.issue(now);
      await this.remind(now);
    }
    await repo.purgePaid(db, cutoff);
    await repo.purgeLimitRequests(db, cutoff);
    await repo.purgeMonthLimits(db, monthOfDay(kstDate(now)));
  }

  /** 지난달까지 청구서가 없는 주문을 청구해요. 주문 잠금 안에서 해서, 막 들어오는 주문과 섞이지 않아요. */
  private async issue(now: number): Promise<void> {
    const ctx = this.ctx;
    const today = kstDate(now);
    // 기한은 청구한 날부터 cafeDueDays일째까지예요(1일 청구·7일이면 7일까지, 8일부터 막힘).
    const dueOn = addDays(today, ctx.ops.get().values.cafeDueDays - 1);
    await ctx.db.tx(async (q) => {
      await repo.lockOrders(q);
      for (const m of await repo.unbilledMonths(q, `${monthOfDay(today)}-01`)) {
        const paid = m.totalWon === 0;
        const id = await repo.insertBill(q, { ...m, code: await this.newCode(q), issuedAt: now, dueOn, paid });
        if (!id || paid) continue;
        await repo.insertNotice(q, id, 'issued', 0, now);
        await ctx.notify.toUser(q, m.pseudonymId, { module: 'cafeteria', title: CAFE_TEXT.notifyBill, page: 'cafe' });
      }
    });
  }

  /** 기한 다음 날(seq 0), 그 뒤 7일마다(seq 1, 2, …) 미납이면 본인에게 알려요. 놓친 회차는 몰아서 보내지 않고 지금 회차 하나만 보내요. */
  private async remind(now: number): Promise<void> {
    const ctx = this.ctx;
    const today = kstDate(now);
    for (const b of await repo.overdueBills(ctx.db, today)) {
      const seq = Math.floor(daysBetween(addDays(b.dueOn, 1), today) / 7);
      await ctx.db.tx(async (q) => {
        if (await repo.insertNotice(q, b.id, 'overdue', seq, now))
          await ctx.notify.toUser(q, b.pseudonymId, { module: 'cafeteria', title: CAFE_TEXT.notifyOverdue, page: 'cafe' });
      });
    }
  }

  /** 아직 쓰지 않은 입금 코드. 청구서는 주문 잠금 안에서만 만들어서 미리 본 코드가 겹치지 않아요. */
  private async newCode(q: Queryable): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const code = randomText(CODE_LETTERS, CODE_LENGTH);
      if (!(await repo.codeTaken(q, code))) return code;
    }
    throw new Error('입금 코드를 만들지 못했어요');
  }
}
