import type {
  Card,
  CardAction,
  MyReservationsResponse,
  OpsSettings,
  RoomCancelResponse,
  RoomCandidate,
  RoomCardsResponse,
  RoomQuery,
  RoomSearchResult,
  Slots,
} from '@one-line-desk/shared';
import type { AppContext } from '../../context';
import type { Queryable } from '../../core/db';
import { DeskError } from '../../core/errors';
import type { PlanHandler } from '../../core/module';
import { linkCard } from '../../core/router';
import type { DeskUser } from '../../core/user';
import { blockedCard, cancelAction, cancelledCard, CONFIRM_LINE, conditionsCard, confirmedCard, noFreeCard, slotCard, whenText } from './cards';
import type { MockRoomLedger } from './ledger-adapter';
import {
  busyBetween,
  countRooms,
  getRoom,
  insertLedger,
  insertReservation,
  listRooms,
  moveToHistory,
  myUpcoming,
  type ReservationRow,
  type RoomRow,
} from './repo';
import {
  alternativeSlots,
  checkQuery,
  dayBounds,
  isFree,
  kstIso,
  makeSlot,
  type QueryCheck,
  RoomQuerySchema,
  type ReserveParams,
  ReserveParamsSchema,
  searchSlots,
  type Slot,
} from './search';

// F2 회의실 찾고 확인 예약(ADR-03·06·14). 읽기(찾기·다시 확인)는 아무것도 쓰지 않고,
// 쓰기는 'rooms:reserve' plan(확인 시트 한 번)과 [취소] 고정 버튼뿐이에요.

type Owner = Pick<DeskUser, 'pseudonymId'>;

/** 예약·취소를 해도 되는 스위치 상태: 회의실 켬 + 회의실 쓰기 켬(R4). */
export function roomsWriteEnabled(s: OpsSettings): boolean {
  return s.modules.rooms === 'on' && s.roomsWrite;
}

/** 라우터 슬롯 → 조건. 길이가 없으면 운영 설정 기본값이에요(F2-1). */
export function slotsToQuery(slots: Slots, defaultMinutes: number): Partial<RoomQuery> {
  return {
    ...(slots.date ? { date: slots.date } : {}),
    ...(slots.start ? { start: slots.start } : {}),
    minutes: slots.minutes ?? defaultMinutes,
    ...(slots.people ? { people: slots.people } : {}),
    equipment: slots.equipment ?? [],
    ...(slots.floor ? { floor: slots.floor } : {}),
  };
}

function toCandidate(s: Slot): RoomCandidate {
  // 칸을 하나씩 골라요. 예약자·회의 제목·방별 일정은 없어요(ADR-14).
  return { roomId: s.room.id, roomName: s.room.name, floor: s.room.floor, start: kstIso(s.start), end: kstIso(s.end), matched: [...s.matched] };
}

interface CardsOptions {
  headline: string;
  evidence: string;
  aiSummarized: boolean;
  wrong?: boolean;
}

/** 빠진 조건 되묻기 · 고칠 조건 안내. 조건 칩 카드에 빠진 칸을 "알려 주세요"로 보여 줘요(F2-1). */
function askAgainCard(check: Extract<QueryCheck, { ok: false }>, o: CardsOptions): Card {
  const headline = check.problem ?? `빠진 조건이 있어요: ${check.missing.join('·')}`;
  return conditionsCard(check.query, { ...o, headline });
}

export class RoomDesk {
  constructor(
    private readonly ctx: AppContext,
    readonly ledger: MockRoomLedger,
  ) {}

  /** 비어 있을 때만 모의 장부를 넣어요. */
  async seed(): Promise<void> {
    if ((await countRooms(this.ctx.db)) > 0) return;
    const rooms = this.ledger.rooms();
    const bookings = this.ledger.bookings(this.ctx.now());
    await this.ctx.db.tx((q) => insertLedger(q, rooms, bookings));
  }

  // ── 찾기(읽기만) ─────────────────────────────────────────────

  private async load(q: Queryable, date: string): Promise<{ rooms: RoomRow[]; busy: Awaited<ReturnType<typeof busyBetween>> }> {
    const { from, to } = dayBounds(date);
    return { rooms: await listRooms(q), busy: await busyBetween(q, from, to) };
  }

  /** 카드 주 버튼. 쓰기가 꺼졌으면 그룹웨어 링크예요. 제안 토큰은 서명만 하고 DB에 쓰지 않아요. */
  private primaryFor(user: Owner, slot: Slot, query: RoomQuery, text: string): CardAction {
    const s = this.ctx.ops.get();
    if (!s.roomsWrite) return { type: 'link', text: '그룹웨어에서 예약하기', href: s.links.rooms };
    return { type: 'propose', text, proposalToken: this.propose(user, { roomId: slot.room.id, start: kstIso(slot.start), end: kstIso(slot.end), query }) };
  }

  private propose(user: Owner, params: ReserveParams): string {
    const parsed = ReserveParamsSchema.safeParse(params);
    if (!parsed.success) throw new DeskError('bad-request', 400, '예약을 제안할 수 없는 조건이에요');
    return this.ctx.plans.propose(user, 'rooms', 'reserve', parsed.data);
  }

  private slotCards(user: Owner, slots: Slot[], query: RoomQuery, o: { checkedAt: number; aiSummarized: boolean; alternative: boolean; text: string }): Card[] {
    return slots.map((slot) =>
      slotCard(slot, { checkedAt: o.checkedAt, aiSummarized: o.aiSummarized, alternative: o.alternative, primary: this.primaryFor(user, slot, query, o.text) }),
    );
  }

  /** 조건 → 카드. 빠진 값이면 되묻고, 후보가 없으면 "그 시간엔 빈 방이 없어요" + 대안이에요(F2-1~3). */
  async cards(partial: Partial<RoomQuery>, user: Owner, o: CardsOptions, now = this.ctx.now()): Promise<{ checkedAt: number; cards: Card[]; found: boolean }> {
    const check = checkQuery(partial, now);
    if (!check.ok) return { checkedAt: now, cards: [askAgainCard(check, o)], found: false };

    const { rooms, busy } = await this.load(this.ctx.db, check.query.date);
    const found = searchSlots({ rooms, busy, query: check.query, start: check.start, end: check.end, now });
    const cond = conditionsCard(check.query, o);
    if (found.candidates.length) {
      return {
        checkedAt: now,
        cards: [
          cond,
          ...this.slotCards(user, found.candidates, check.query, { checkedAt: now, aiSummarized: o.aiSummarized, alternative: false, text: '이 방으로 예약' }),
        ],
        found: true,
      };
    }
    return {
      checkedAt: now,
      cards: [
        cond,
        noFreeCard(check.start, check.end, found.alternatives.length, now),
        ...this.slotCards(user, found.alternatives, check.query, { checkedAt: now, aiSummarized: o.aiSummarized, alternative: true, text: '이 방으로 예약' }),
      ],
      found: false,
    };
  }

  /** MCP rooms_find_free가 불러요(ADR-14). LLM·DB 쓰기·사용자 없음. 최대 3개 + 없으면 대안 최대 2개. */
  async findFree(input: RoomQuery): Promise<RoomSearchResult> {
    // 도구 입력은 길이·장비가 선택 칸이에요(tool-registry). 비면 운영 설정 기본값·빈 목록으로 채워요.
    const parsed = RoomQuerySchema.safeParse({
      ...input,
      minutes: input.minutes ?? this.ctx.ops.get().values.defaultMeetingMinutes,
      equipment: input.equipment ?? [],
    });
    if (!parsed.success) throw new DeskError('bad-request', 400, '조건 형식이 맞지 않아요');
    const now = this.ctx.now();
    const base = { checkedAt: kstIso(now), mock: this.ledger.capabilities.mock };
    const check = checkQuery(parsed.data, now);
    if (!check.ok) return { ...base, candidates: [], alternatives: [] };
    const { rooms, busy } = await this.load(this.ctx.db, check.query.date);
    const found = searchSlots({ rooms, busy, query: check.query, start: check.start, end: check.end, now });
    return { ...base, candidates: found.candidates.map(toCandidate), alternatives: found.alternatives.map(toCandidate) };
  }

  /** MCP 앱 확인 링크용 제안 토큰(M3). 서명만 하고 DB에 쓰지 않아요. */
  proposeReservation(user: Owner, c: { roomId: string; start: string; end: string; query: RoomQuery }): string {
    return this.propose(user, { roomId: c.roomId, start: c.start, end: c.end, query: c.query });
  }

  /**
   * 앱 확인 링크 다시 확인(M3, ADR-14). 토큰 주인만 열고, 링크를 연 것만으로는 아무것도 쓰지 않아요.
   * 만료면 같은 조건으로 다시 찾고, 그 방이 아직 비면 그 방 카드 한 장(새 토큰), 찼으면 안내 카드 + 대안이에요.
   */
  async recheck(user: DeskUser, token: string): Promise<RoomCardsResponse> {
    const opened = this.ctx.plans.peek(user, token);
    if (opened.module !== 'rooms' || opened.action !== 'reserve') throw new DeskError('bad-request', 400, '회의실 예약 링크가 아니에요');
    const p = ReserveParamsSchema.parse(opened.params);
    const now = this.ctx.now();
    const settings = this.ctx.ops.get();
    if (settings.modules.rooms !== 'on') return { checkedAt: kstIso(now), cards: [linkCard('rooms', settings.links.rooms)] };

    // 링크의 조건은 우리 AI가 뽑은 게 아니라서(Claude가 넘긴 값) "AI 정리"를 붙이지 않아요.
    const linkOptions = { evidence: '앱 확인 링크의 조건 · 칩을 고치면 다시 찾아요', aiSummarized: false };
    const start = Date.parse(p.start);
    const end = Date.parse(p.end);
    if (opened.expired || start < now) {
      const again = await this.cards(p.query, user, { ...linkOptions, headline: '시간이 지나 다시 찾았어요' }, now);
      return { checkedAt: kstIso(now), cards: again.cards };
    }

    const { rooms, busy } = await this.load(this.ctx.db, p.query.date);
    const room = rooms.find((r) => r.id === p.roomId);
    const cond = conditionsCard(p.query, { ...linkOptions, headline: '이 조건으로 다시 확인했어요' });
    if (room && isFree(busy, room.id, start, end)) {
      const card = this.slotCards(user, [makeSlot(room, start, end, p.query)], p.query, {
        checkedAt: now,
        aiSummarized: false,
        alternative: false,
        text: '이 방으로 예약',
      });
      return { checkedAt: kstIso(now), cards: [cond, ...card] };
    }
    const alternatives = alternativeSlots({ rooms, busy, query: p.query, start, end, now, anchors: room ? [room] : [], floor: room?.floor ?? p.query.floor });
    return {
      checkedAt: kstIso(now),
      cards: [
        cond,
        noFreeCard(start, end, alternatives.length, now),
        ...this.slotCards(user, alternatives, p.query, { checkedAt: now, aiSummarized: false, alternative: true, text: '이 방으로 예약' }),
      ],
    };
  }

  // ── 쓰기: 확인 시트 한 번(plan)과 [취소] 고정 버튼 ─────────────────

  /** 'rooms:reserve' plan 처리기(ADR-03). 실행은 plan 트랜잭션 q로만 해요. */
  reserveHandler(): PlanHandler<ReserveParams> {
    return {
      module: 'rooms',
      action: 'reserve',
      schema: ReserveParamsSchema,
      enabled: roomsWriteEnabled,
      sheet: async (p) => {
        const room = await getRoom(this.ctx.db, p.roomId);
        return {
          title: '이 방으로 예약할까요?',
          lines: [room ? `${room.name} · ${room.floor}` : p.roomId, whenText(Date.parse(p.start), Date.parse(p.end)), CONFIRM_LINE],
          confirmLabel: '예약하기',
          note: '[예약하기]를 누르는 순간 빈 방인지 다시 확인해요',
        };
      },
      execute: async (p, ex) => {
        const start = Date.parse(p.start);
        const end = Date.parse(p.end);
        const room = await getRoom(ex.q, p.roomId);
        // 확정 = 재확인(ADR-06): 겹침 제약이 막으면 아무것도 넣지 않아요. 확인하는 사이 시작 시각이 지났으면 넣지 않아요.
        const id =
          room && start >= ex.now ? await insertReservation(ex.q, { roomId: room.id, start, end, pseudonymId: ex.user.pseudonymId, planId: ex.planId }) : null;
        if (room && id) {
          const row: ReservationRow = { id, roomId: room.id, roomName: room.name, floor: room.floor, start, end };
          return { status: 'done', card: confirmedCard(row, ex.now) };
        }
        const { rooms, busy } = await this.load(ex.q, p.query.date);
        const alternatives = alternativeSlots({
          rooms,
          busy,
          query: p.query,
          start,
          end,
          now: ex.now,
          anchors: room ? [room] : [],
          floor: room?.floor ?? p.query.floor,
        });
        return {
          status: 'blocked',
          card: blockedCard(room, start, end, alternatives.length, ex.now),
          alternatives: this.slotCards(ex.user, alternatives, p.query, { checkedAt: ex.now, aiSummarized: false, alternative: true, text: '대안으로 예약' }),
        };
      },
      reSearch: async (p, user) =>
        (
          await this.cards(p.query, user, {
            headline: '같은 조건으로 다시 찾았어요',
            evidence: '처음 찾은 조건 · 칩을 고치면 다시 찾아요',
            aiSummarized: false,
          })
        ).cards,
    };
  }

  async myReservations(user: Owner): Promise<MyReservationsResponse> {
    const enabled = roomsWriteEnabled(this.ctx.ops.get());
    if (!enabled) return { enabled, items: [] };
    const rows = await myUpcoming(this.ctx.db, user.pseudonymId, this.ctx.now());
    return {
      enabled,
      items: rows.map((r) => ({
        id: r.id,
        roomName: r.roomName,
        floor: r.floor,
        start: kstIso(r.start),
        end: kstIso(r.end),
        when: whenText(r.start, r.end),
        cancel: cancelAction(r),
      })),
    };
  }

  /** 취소(고정 버튼, 확인 시트 뒤). 내 예약만, 예약 표에서 이력 표로 옮겨요(ADR-06). */
  async cancel(user: DeskUser, id: string): Promise<RoomCancelResponse> {
    return this.ctx.fixed.run<RoomCancelResponse>(user, {
      module: 'rooms',
      action: 'cancel',
      idempotencyKey: id,
      enabled: roomsWriteEnabled,
      async run(q, now) {
        const moved = await moveToHistory(q, id, user.pseudonymId, now);
        if (!moved) throw new DeskError('not-found', 404, '취소할 예약을 찾지 못했어요');
        return { status: 'done', card: cancelledCard(moved, now) };
      },
    });
  }
}
