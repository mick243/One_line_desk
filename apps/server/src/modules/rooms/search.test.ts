import { kstToEpoch, type RoomQuery } from '@one-line-desk/shared';
import { describe, expect, it } from 'vitest';
import type { BusyRow, RoomRow } from './repo';
import { alternativeSlots, checkQuery, kstIso, MINUTE, ReserveParamsSchema, searchSlots } from './search';

const NOW = Date.parse('2026-10-26T09:00:00+09:00');
const DATE = '2026-10-27';
const at = (hhmm: string) => kstToEpoch(DATE, hhmm);

const rooms: RoomRow[] = [
  { id: 'a', name: 'A', floor: '3층', capacity: 6, equipment: ['화면'], repairs: [], facilities: [], photoUrl: null },
  { id: 'b', name: 'B', floor: '3층', capacity: 8, equipment: ['화면'], repairs: [], facilities: [], photoUrl: null },
  { id: 'c', name: 'C', floor: '5층', capacity: 10, equipment: ['화면', '화상회의'], repairs: [], facilities: [], photoUrl: null },
  { id: 'd', name: 'D', floor: '3층', capacity: 4, equipment: [], repairs: [], facilities: [], photoUrl: null },
];
const query: RoomQuery = { date: DATE, start: '15:00', minutes: 60, people: 6, equipment: ['화면'] };
const busy = (roomId: string, from: string, to: string): BusyRow => ({ roomId, start: at(from), end: at(to) });

describe('빈 방 찾기 계산(ADR-06, R5)', () => {
  it('[F2-2] 조건에 맞는 빈 방만, 인원에 꼭 맞는 방부터 최대 3개예요', () => {
    const found = searchSlots({ rooms, busy: [busy('a', '15:00', '16:00')], query, start: at('15:00'), end: at('16:00'), now: NOW });
    expect(found.candidates.map((s) => s.room.id)).toEqual(['b', 'c']);
    expect(found.candidates[0]!.matched).toEqual(['인원 6명', '화면']);
    expect(found.alternatives).toEqual([]);
  });

  it('[F2-3] 처음부터 빈 방이 없으면 같은 방 앞뒤 가까운 시간을 먼저 대안으로 줘요', () => {
    const allBusy = [busy('a', '14:30', '16:00'), busy('b', '15:00', '17:00'), busy('c', '15:00', '16:00')];
    const found = searchSlots({ rooms, busy: allBusy, query, start: at('15:00'), end: at('16:00'), now: NOW });
    expect(found.candidates).toEqual([]);
    // a는 90분 앞·60분 뒤, b는 60분 앞, c는 60분 앞·뒤가 비어요. 가까운 순 → 인원에 꼭 맞는 방 순이에요.
    expect(found.alternatives.map((s) => [s.room.id, kstIso(s.start), s.reason])).toEqual([
      ['a', '2026-10-27T16:00:00+09:00', '같은 방 60분 뒤'],
      ['b', '2026-10-27T14:00:00+09:00', '같은 방 60분 앞'],
    ]);
  });

  it('[ADR-06 시험] 막힌 방 하나가 기준이면 같은 방 앞뒤 → 같은 층 다른 방 → 다른 층 순이에요', () => {
    const blocked = rooms[0]!;
    const onlyFloor = alternativeSlots({
      rooms,
      busy: [busy('a', '13:00', '17:00')],
      query,
      start: at('15:00'),
      end: at('16:00'),
      now: NOW,
      anchors: [blocked],
      floor: '3층',
    });
    expect(onlyFloor.map((s) => [s.room.id, s.reason])).toEqual([
      ['a', '같은 방 120분 뒤'],
      ['a', '같은 방 180분 앞'],
    ]);

    const fullDay = alternativeSlots({
      rooms,
      busy: [busy('a', '07:00', '22:00')],
      query,
      start: at('15:00'),
      end: at('16:00'),
      now: NOW,
      anchors: [blocked],
      floor: '3층',
    });
    expect(fullDay.map((s) => [s.room.id, s.reason])).toEqual([
      ['b', '같은 층 다른 방'],
      ['c', '다른 층'],
    ]);
  });

  it('[F2-3] 대안도 없으면 빈 목록이에요(화면은 "대안 없음")', () => {
    const big = { ...query, people: 30 };
    expect(searchSlots({ rooms, busy: [], query: big, start: at('15:00'), end: at('16:00'), now: NOW })).toEqual({ candidates: [], alternatives: [] });
  });

  it('대안은 지난 시간과 07:00~22:00 밖으로 가지 않아요', () => {
    const early = { ...query, start: '07:30', date: DATE };
    const alts = alternativeSlots({
      rooms: [rooms[0]!],
      busy: [busy('a', '07:30', '08:30')],
      query: early,
      start: at('07:30'),
      end: at('08:30'),
      now: NOW,
      anchors: [rooms[0]!],
    });
    expect(alts.map((s) => kstIso(s.start))).toEqual(['2026-10-27T08:30:00+09:00']);
  });
});

describe('조건 검사(F2-1)', () => {
  it('[F2-1] 날짜·시작 시각·인원이 빠지면 무엇이 빠졌는지 알려 줘요', () => {
    expect(checkQuery({ minutes: 60, equipment: [] }, NOW)).toMatchObject({ ok: false, missing: ['날짜', '시작 시각', '인원'] });
    expect(checkQuery({ date: DATE, minutes: 60 }, NOW)).toMatchObject({ ok: false, missing: ['시작 시각', '인원'] });
  });

  it('[F2-8] 지난 시간과 하루를 넘는 길이는 고쳐 달라고 해요', () => {
    expect(checkQuery({ ...query, date: '2026-10-26', start: '08:00' }, NOW)).toMatchObject({
      ok: false,
      problem: '이미 지난 시간이에요. 날짜나 시작 시각을 고쳐 주세요',
    });
    expect(checkQuery({ ...query, start: '23:30', minutes: 60 }, NOW)).toMatchObject({
      ok: false,
      problem: '하루 안의 시간만 예약할 수 있어요. 길이를 줄여 주세요',
    });
    expect(checkQuery(query, NOW)).toMatchObject({ ok: true, start: at('15:00'), end: at('15:00') + 60 * MINUTE });
  });

  it('[F2-8] 예약 매개변수는 하루 안의 한 구간만 받아요(여러 날·자유 문장 칸 없음)', () => {
    const ok = { roomId: 'a', start: '2026-10-27T15:00:00+09:00', end: '2026-10-27T16:00:00+09:00', query };
    expect(ReserveParamsSchema.safeParse(ok).success).toBe(true);
    expect(ReserveParamsSchema.safeParse({ ...ok, end: '2026-10-28T16:00:00+09:00' }).success).toBe(false);
    expect(ReserveParamsSchema.safeParse({ ...ok, start: '2026-10-28T15:00:00+09:00', end: '2026-10-28T16:00:00+09:00' }).success).toBe(false);
    expect(ReserveParamsSchema.safeParse({ ...ok, note: '회의 제목' }).success).toBe(false);
  });
});
