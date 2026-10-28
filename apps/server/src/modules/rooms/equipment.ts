import {
  type Card,
  type CardAction,
  type Equipment,
  type FacilityStatus,
  kstDate,
  LOAN_KINDS,
  type LoanKind,
  type MyLoansResponse,
  type RoomCancelResponse,
} from '@one-line-desk/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import type { PlanHandler } from '../../core/module';
import type { DeskUser } from '../../core/user';
import { endLoanAction, loanBlockedCard, loanCard, loanEndedCard, roomEquipmentCard, stockCard, whenText, withSubject } from './cards';
import { DEMO_EQUIPMENT, DEMO_FACILITY_STATUS } from './fixtures/equipment';
import {
  countEquipment,
  endLoan,
  freeItems,
  getMyReservation,
  getRoom,
  insertEquipment,
  insertLoan,
  loanStock,
  myLoans,
  seedFacilityStatus,
  setFacilityStatus,
} from './repo';
import { KST_ISO, kstIso, MINUTE } from './search';
import { roomsWriteEnabled } from './service';

// 장비 대여·방 설비 상태(10/28, ADR-19).
// - 대여는 'rooms:rent' plan으로만 들어가요. 채팅 명령이면 자동 실행(허용 목록), 카드 [빌리기]면 확인 시트 한 번이에요.
// - 대여 취소·반납은 고정 버튼(확인 시트 뒤)이에요. 신청하면 바로 확정이고, 누가 빌렸는지는 다른 사람에게 보이지 않아요.
// - 방 설비 상태(점검 중)는 총무만 바꿔요.

type Owner = Pick<DeskUser, 'pseudonymId'>;

/** "지금 바로"는 10분 단위로 올린 시각이라 조금 지났을 수 있어요. 그만큼은 받아요. */
const LATE_START = 10 * MINUTE;

/** 'rooms:rent' plan 매개변수. 하루 안의 한 구간만이고, 회의에 붙이면 그 예약 ID가 들어가요. 자유 문장 칸은 없어요. */
export const RentParamsSchema = z
  .strictObject({
    kind: z.enum(LOAN_KINDS),
    start: z.string().regex(KST_ISO),
    end: z.string().regex(KST_ISO),
    reservationId: z
      .string()
      .regex(/^[0-9]{1,18}$/)
      .optional(),
  })
  .refine(
    (p) => {
      const start = Date.parse(p.start);
      const end = Date.parse(p.end);
      return end > start && end - start <= 600 * MINUTE && kstDate(start) === kstDate(end - 1);
    },
    { message: '하루 안의 한 구간만 빌려요' },
  );
export type RentParams = z.infer<typeof RentParamsSchema>;

export class RoomEquipment {
  constructor(private readonly ctx: AppContext) {}

  /** 비어 있을 때만 시연 장비를 넣어요. 설비 상태도 처음 한 번만이에요. */
  async seed(): Promise<void> {
    await this.ctx.db.tx(async (q) => {
      if ((await countEquipment(q)) === 0) await insertEquipment(q, DEMO_EQUIPMENT);
      await seedFacilityStatus(q, DEMO_FACILITY_STATUS);
    });
  }

  // ── 읽기 ───────────────────────────────────────────────

  /** 종류별 남은 수 카드. 종류 하나를 물었고 남아 있으면 [빌리기](확인 시트)를 붙여요. 아무것도 쓰지 않아요. */
  async stock(user: Owner, kinds: LoanKind[], from: number, to: number, o: { aiSummarized: boolean; reservationId?: string }): Promise<Card> {
    const now = this.ctx.now();
    const stock = await loanStock(this.ctx.db, from, to);
    const one = kinds.length === 1 ? stock.find((s) => s.kind === kinds[0]) : undefined;
    let primary: CardAction | undefined;
    if (one && one.free > 0 && roomsWriteEnabled(this.ctx.ops.get()) && to > now) {
      const params: RentParams = {
        kind: one.kind,
        start: kstIso(from),
        end: kstIso(to),
        ...(o.reservationId ? { reservationId: o.reservationId } : {}),
      };
      primary = { type: 'propose', text: '빌리기', proposalToken: this.ctx.plans.propose(user, 'rooms', 'rent', RentParamsSchema.parse(params)) };
    }
    return stockCard(stock, from, to, { kinds, checkedAt: now, aiSummarized: o.aiSummarized, primary });
  }

  async myLoans(user: Owner): Promise<MyLoansResponse> {
    const enabled = roomsWriteEnabled(this.ctx.ops.get());
    if (!enabled) return { enabled, items: [] };
    const now = this.ctx.now();
    const rows = await myLoans(this.ctx.db, user.pseudonymId, now);
    return {
      enabled,
      items: rows.map((l) => ({
        id: l.id,
        kind: l.kind,
        itemName: l.itemName,
        home: l.home,
        start: kstIso(l.start),
        end: kstIso(l.end),
        when: whenText(l.start, l.end),
        roomName: l.roomName,
        endAction: endLoanAction(l, now),
      })),
    };
  }

  /** 방 하나의 장비 카드 */
  async roomCard(roomId: string, aiSummarized: boolean): Promise<Card | null> {
    const room = await getRoom(this.ctx.db, roomId);
    return room ? roomEquipmentCard(room, aiSummarized) : null;
  }

  // ── 쓰기 ───────────────────────────────────────────────

  /** 'rooms:rent' plan 처리기. 채팅 명령이면 자동 실행 허용 목록이에요(ADR-19). 실행은 plan 트랜잭션 q로만 해요. */
  rentHandler(): PlanHandler<RentParams> {
    return {
      module: 'rooms',
      action: 'rent',
      schema: RentParamsSchema,
      enabled: roomsWriteEnabled,
      autoAllowed: true,
      sheet: async (p) => ({
        title: '이 장비를 빌릴까요?',
        lines: [p.kind, whenText(Date.parse(p.start), Date.parse(p.end)), '신청하면 바로 확정이에요. 가져갈 곳은 확정 카드에 보여요.'],
        confirmLabel: '빌리기',
        note: '[빌리기]를 누르는 순간 남은 장비를 다시 확인해요',
      }),
      execute: async (p, ex) => {
        const start = Date.parse(p.start);
        const end = Date.parse(p.end);
        if (end <= ex.now || start < ex.now - LATE_START) {
          return { status: 'blocked', card: loanBlockedCard(p.kind, start, end, '이미 지난 시간이에요', ex.now) };
        }
        let roomName: string | null = null;
        if (p.reservationId) {
          // 회의에 붙여 빌릴 때는 내 예약이고 그 시간 안이어야 해요.
          const r = await getMyReservation(ex.q, p.reservationId, ex.user.pseudonymId, ex.now);
          if (!r || start < r.start || end > r.end)
            return { status: 'blocked', card: loanBlockedCard(p.kind, start, end, '그 회의 예약을 찾지 못했어요', ex.now) };
          roomName = r.roomName;
        }
        // 확정 = 재확인: 남은 장비를 다시 보고, 겹침 제약이 막으면 다음 장비를 봐요.
        for (const item of await freeItems(ex.q, p.kind, start, end)) {
          const id = await insertLoan(ex.q, {
            itemId: item.id,
            start,
            end,
            pseudonymId: ex.user.pseudonymId,
            planId: ex.planId,
            reservationId: p.reservationId ?? null,
          });
          if (id) {
            const row = { id, kind: p.kind, itemName: item.name, home: item.home, start, end, reservationId: p.reservationId ?? null, roomName };
            return { status: 'done', card: loanCard(row, ex.now) };
          }
        }
        return { status: 'blocked', card: loanBlockedCard(p.kind, start, end, `그 시간에 빌릴 수 있는 ${withSubject(p.kind)} 없어요`, ex.now) };
      },
      reSearch: async (p, user) => [
        await this.stock(user, [p.kind], Date.parse(p.start), Date.parse(p.end), { aiSummarized: false, reservationId: p.reservationId }),
      ],
    };
  }

  /** [대여 취소]·[반납](고정 버튼, 확인 시트 뒤). 내 대여만이에요. */
  async endLoan(user: DeskUser, id: string): Promise<RoomCancelResponse> {
    let how = 'done';
    return this.ctx.fixed.run<RoomCancelResponse>(user, {
      module: 'rooms',
      action: 'loan-end',
      idempotencyKey: id,
      enabled: roomsWriteEnabled,
      resultCode: () => how,
      async run(q, now) {
        const ended = await endLoan(q, id, user.pseudonymId, now);
        if (!ended) throw new DeskError('not-found', 404, '끝낼 대여를 찾지 못했어요');
        how = ended.how;
        return { status: 'done', card: loanEndedCard(ended.row, ended.how, now) };
      },
    });
  }

  /** 방 설비 상태 바꾸기(총무, 고정 버튼). 그 방에 있는 설비만 바꿔요. */
  async setFacility(user: DeskUser, roomId: string, facility: Equipment, status: FacilityStatus): Promise<{ status: 'done'; card: Card }> {
    return this.ctx.fixed.run(user, {
      module: 'rooms',
      action: 'facility-set',
      resultCode: () => status,
      async run(q, now) {
        const room = await getRoom(q, roomId);
        if (!room) throw new DeskError('not-found', 404, '없는 회의실이에요');
        if (![...room.equipment, ...room.repairs].includes(facility)) throw new DeskError('bad-request', 400, '그 방에 없는 설비예요');
        await setFacilityStatus(q, roomId, facility, status, now);
        const updated = await getRoom(q, roomId);
        return { status: 'done', card: roomEquipmentCard(updated!, false) };
      },
    });
  }
}
