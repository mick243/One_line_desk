import { EQUIPMENT, kstDate, kstToEpoch, type RoomQuery } from '@one-line-desk/shared';
import { z } from 'zod';
import type { BusyRow, RoomRow } from './repo';

// 빈 방 후보·대안 계산(ADR-06, R5). DB에서 읽은 방·차 있는 구간만 받아 계산해요. 예약자는 모르고 몰라도 돼요.

export const MINUTE = 60_000;
const KST_MS = 9 * 60 * MINUTE;
/** 대안은 30분 단위로 앞뒤 4시간 안, 07:00~22:00 사이에서만 찾아요. */
const STEP_MINUTES = 30;
const MAX_SHIFT_STEPS = 8;
export const DAY_OPEN = '07:00';
export const DAY_CLOSE = '22:00';
export const MAX_CANDIDATES = 3;
export const MAX_ALTERNATIVES = 2;

/** 들어오는 조건은 남의 입력으로 보고 길이·정해진 목록으로 검증해요(ADR-14). */
export const RoomQuerySchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  minutes: z.number().int().min(10).max(600),
  people: z.number().int().min(1).max(200),
  equipment: z.array(z.enum(EQUIPMENT)).max(EQUIPMENT.length),
  floor: z
    .string()
    .regex(/^\d{1,2}층$/)
    .optional(),
});

const KST_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;

/** 'rooms:reserve' plan 매개변수. 하루 안의 한 구간만(반복·여러 날 없음, F2-8). 자유 문장 칸은 없어요. */
export const ReserveParamsSchema = z
  .strictObject({
    roomId: z.string().regex(/^[a-z0-9-]{1,40}$/),
    start: z.string().regex(KST_ISO),
    end: z.string().regex(KST_ISO),
    query: RoomQuerySchema,
  })
  .refine(
    (p) => {
      const start = Date.parse(p.start);
      const end = Date.parse(p.end);
      return end > start && end - start <= 600 * MINUTE && kstDate(start) === p.query.date && kstDate(end - 1) === p.query.date;
    },
    { message: '하루 안의 한 구간만 예약해요' },
  );
export type ReserveParams = z.infer<typeof ReserveParamsSchema>;

/** 'YYYY-MM-DDTHH:MM:SS+09:00' */
export function kstIso(at: number): string {
  return `${new Date(at + KST_MS).toISOString().slice(0, 19)}+09:00`;
}

export function dayBounds(date: string): { from: number; to: number } {
  const from = kstToEpoch(date, '00:00');
  return { from, to: from + 24 * 60 * MINUTE };
}

export type QueryCheck =
  | { ok: true; query: RoomQuery; start: number; end: number }
  | {
      ok: false;
      query: Partial<RoomQuery>;
      missing: string[];
      problem?: string;
      /** 지난 시간이면 'past', 그 밖의 고칠 값은 'bad-time' */ code?: 'past' | 'bad-time';
    };

/** 빠진 값(날짜·시작 시각·인원)과 고칠 값(지난 시간, 하루를 넘는 길이)을 찾아요(F2-1). */
export function checkQuery(partial: Partial<RoomQuery>, now: number): QueryCheck {
  const missing: string[] = [];
  if (!partial.date) missing.push('날짜');
  if (!partial.start) missing.push('시작 시각');
  if (!partial.people) missing.push('인원');
  if (!partial.minutes) missing.push('길이');
  if (missing.length) return { ok: false, query: partial, missing };

  const parsed = RoomQuerySchema.safeParse({ equipment: [], ...partial });
  if (!parsed.success) return { ok: false, query: partial, missing: [], problem: '조건을 알아보지 못했어요. 칩을 고쳐 주세요', code: 'bad-time' };
  const query = parsed.data;
  const start = kstToEpoch(query.date, query.start);
  if (Number.isNaN(start) || kstDate(start) !== query.date)
    return { ok: false, query, missing: [], problem: '없는 날짜예요. 날짜를 고쳐 주세요', code: 'bad-time' };
  const end = start + query.minutes * MINUTE;
  if (kstDate(end - 1) !== query.date)
    return { ok: false, query, missing: [], problem: '하루 안의 시간만 예약할 수 있어요. 길이를 줄여 주세요', code: 'bad-time' };
  if (start < now) return { ok: false, query, missing: [], problem: '이미 지난 시간이에요. 날짜나 시작 시각을 고쳐 주세요', code: 'past' };
  return { ok: true, query, start, end };
}

/** 후보·대안 한 칸. 방 정보와 구간·맞은 조건뿐이에요. */
export interface Slot {
  room: RoomRow;
  start: number;
  end: number;
  matched: string[];
  /** 대안일 때: 같은 방 30분 뒤 · 같은 층 다른 방 · 다른 층 */
  reason?: string;
}

function fitsPeopleAndEquipment(room: RoomRow, q: RoomQuery): boolean {
  return room.capacity >= q.people && q.equipment.every((e) => room.equipment.includes(e));
}

function matches(room: RoomRow, q: RoomQuery): boolean {
  return fitsPeopleAndEquipment(room, q) && (!q.floor || room.floor === q.floor);
}

/** 인원에 가장 꼭 맞는 방부터, 같으면 낮은 층, 같으면 방 ID 순이에요. */
function rankRooms(a: RoomRow, b: RoomRow): number {
  return a.capacity - b.capacity || parseInt(a.floor, 10) - parseInt(b.floor, 10) || a.id.localeCompare(b.id);
}

export function isFree(busy: BusyRow[], roomId: string, start: number, end: number): boolean {
  return !busy.some((b) => b.roomId === roomId && b.start < end && start < b.end);
}

function matchedConditions(room: RoomRow, q: RoomQuery): string[] {
  const matched = [`인원 ${q.people}명`, ...q.equipment];
  if (q.floor && room.floor === q.floor) matched.push(q.floor);
  return matched;
}

export function makeSlot(room: RoomRow, start: number, end: number, q: RoomQuery, reason?: string): Slot {
  return { room, start, end, matched: matchedConditions(room, q), ...(reason ? { reason } : {}) };
}

/** 후보 최대 3개. 없으면 가까운 대안 최대 2개(R5). */
export function searchSlots(input: { rooms: RoomRow[]; busy: BusyRow[]; query: RoomQuery; start: number; end: number; now: number }): {
  candidates: Slot[];
  alternatives: Slot[];
} {
  const { rooms, busy, query, start, end, now } = input;
  const matching = rooms.filter((r) => matches(r, query)).sort(rankRooms);
  const candidates = matching
    .filter((r) => isFree(busy, r.id, start, end))
    .slice(0, MAX_CANDIDATES)
    .map((r) => makeSlot(r, start, end, query));
  if (candidates.length) return { candidates, alternatives: [] };
  return { candidates, alternatives: alternativeSlots({ rooms, busy, query, start, end, now, anchors: matching, floor: query.floor ?? matching[0]?.floor }) };
}

/**
 * 대안 규칙(ADR-06): 같은 방 앞뒤 가까운 시간 → 같은 층 조건 맞는 다른 방 → 다른 층, 최대 2개.
 * anchors는 "같은 방"으로 볼 방이에요. 처음 찾기에선 조건 맞는 방 모두, 막혔을 땐 고른 방 하나예요.
 */
export function alternativeSlots(input: {
  rooms: RoomRow[];
  busy: BusyRow[];
  query: RoomQuery;
  start: number;
  end: number;
  now: number;
  anchors: RoomRow[];
  floor?: string | undefined;
}): Slot[] {
  const { rooms, busy, query, start, end, now, anchors, floor } = input;
  const length = end - start;
  const earliest = Math.max(kstToEpoch(query.date, DAY_OPEN), now);
  const latest = kstToEpoch(query.date, DAY_CLOSE);

  const shifted: { slot: Slot; steps: number; order: number }[] = [];
  anchors.forEach((room, order) => {
    for (const dir of [-1, 1] as const) {
      for (let steps = 1; steps <= MAX_SHIFT_STEPS; steps++) {
        const s = start + dir * steps * STEP_MINUTES * MINUTE;
        const e = s + length;
        if (dir < 0 ? s < earliest : e > latest) break;
        if (s < earliest || e > latest) continue;
        if (isFree(busy, room.id, s, e)) {
          shifted.push({ slot: makeSlot(room, s, e, query, `같은 방 ${steps * STEP_MINUTES}분 ${dir < 0 ? '앞' : '뒤'}`), steps, order });
          break;
        }
      }
    }
  });
  shifted.sort((a, b) => a.steps - b.steps || a.order - b.order);

  const anchorIds = new Set(anchors.map((r) => r.id));
  const others = rooms.filter((r) => !anchorIds.has(r.id) && fitsPeopleAndEquipment(r, query) && isFree(busy, r.id, start, end)).sort(rankRooms);
  const sameFloor = others.filter((r) => r.floor === floor).map((r) => makeSlot(r, start, end, query, '같은 층 다른 방'));
  const otherFloor = others.filter((r) => r.floor !== floor).map((r) => makeSlot(r, start, end, query, '다른 층'));

  const seen = new Set<string>();
  return [...shifted.map((x) => x.slot), ...sameFloor, ...otherFloor]
    .filter((s) => {
      const key = `${s.room.id}@${s.start}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_ALTERNATIVES);
}
