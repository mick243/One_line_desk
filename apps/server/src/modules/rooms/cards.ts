import { type Card, type CardAction, formatKstDateTime, kstTime, ROOM_CONDITIONS_VARIANT, roomConditionFields, type RoomQuery } from '@one-line-desk/shared';
import { makeCard } from '../../core/cards';
import type { ReservationRow } from './repo';
import type { Slot } from './search';

// 회의실 카드(화면설계 카드 문법). 남의 예약자 이름·회의 제목은 카드 어디에도 없어요(ADR-06).

const NOT_RESERVED = '아직 예약되지 않았어요';
export const CONFIRM_LINE = "내 이름으로 예약돼요. 다른 사람에게는 '예약됨'으로만 보여요.";

/** "10월 27일(화) 15:00~16:00" */
export function whenText(start: number, end: number): string {
  return `${formatKstDateTime(start)}~${kstTime(end)}`;
}

const roomLine = (room: { name: string; floor: string }) => `${room.name} · ${room.floor}`;
const statusAt = (at: number) => `현황 ${kstTime(at)} 기준`;

/**
 * 조건 칩 카드(S2 "조건 칩 줄"). 웹이 칩으로 그려 고치게 해요(variant). 빠진 값은 "알려 주세요"로 되물어요(F2-1).
 * 칸 값 형식은 shared의 roomConditionFields()·parseRoomConditionFields()가 정해요.
 */
export function conditionsCard(query: Partial<RoomQuery>, o: { headline: string; evidence: string; aiSummarized: boolean; wrong?: boolean }): Card {
  return makeCard({
    id: 'rooms-conditions',
    kind: 'rooms',
    label: '안내',
    variant: ROOM_CONDITIONS_VARIANT,
    headline: o.headline,
    fields: roomConditionFields(query),
    evidence: { text: o.evidence, aiSummarized: o.aiSummarized },
    ...(o.wrong ? { wrong: { predictedKind: 'rooms' as const, candidates: [] } } : {}),
    tail: NOT_RESERVED,
  });
}

/** 후보·대안 카드. 주 버튼은 [이 방으로 예약](제안 토큰) 또는 회의실 쓰기가 꺼졌으면 그룹웨어 링크예요(R4). */
export function slotCard(slot: Slot, o: { checkedAt: number; aiSummarized: boolean; primary: CardAction; alternative: boolean }): Card {
  const fields = [
    { name: '방·층', value: roomLine(slot.room) },
    { name: '날짜·시간', value: whenText(slot.start, slot.end) },
    { name: '맞은 조건', value: slot.matched.join(' · ') },
  ];
  if (slot.reason) fields.push({ name: '대안', value: slot.reason });
  return makeCard({
    id: `rooms-${o.alternative ? 'alt' : 'slot'}-${slot.room.id}-${slot.start}`,
    kind: 'rooms',
    label: '제안',
    headline: o.alternative ? `대안: ${slot.room.name}` : slot.room.name,
    fields,
    evidence: { text: statusAt(o.checkedAt), aiSummarized: o.aiSummarized },
    primary: o.primary,
    tail: NOT_RESERVED,
  });
}

/** 처음부터 빈 방이 없을 때(R5). 막힘이 아니라 안내예요. 대안은 뒤따르는 카드예요. */
export function noFreeCard(start: number, end: number, alternatives: number, checkedAt: number): Card {
  return makeCard({
    id: 'rooms-no-free',
    kind: 'rooms',
    label: '안내',
    headline: '그 시간엔 빈 방이 없어요',
    fields: [
      { name: '찾은 시간', value: whenText(start, end) },
      { name: '대안', value: alternatives ? `가까운 대안 ${alternatives}개` : '대안 없음' },
    ],
    evidence: { text: statusAt(checkedAt), aiSummarized: false },
    tail: alternatives ? NOT_RESERVED : `${NOT_RESERVED} · 조건을 고쳐 다시 찾아 주세요`,
  });
}

/** 확인 순간 재확인에서 막혔을 때만(R5). 대안은 뒤따르는 카드예요. */
export function blockedCard(
  room: { id: string; name: string; floor: string } | null,
  start: number,
  end: number,
  alternatives: number,
  checkedAt: number,
): Card {
  return makeCard({
    id: `rooms-blocked-${room?.id ?? 'gone'}-${start}`,
    kind: 'rooms',
    label: '막힘',
    headline: '확인하는 사이에 다른 예약이 들어왔어요',
    fields: [
      ...(room ? [{ name: '방·층', value: roomLine(room) }] : []),
      { name: '날짜·시간', value: whenText(start, end) },
      { name: '대안', value: alternatives ? `가까운 대안 ${alternatives}개` : '대안 없음' },
    ],
    evidence: { text: statusAt(checkedAt), aiSummarized: false },
    tail: '아무것도 바뀌지 않았어요',
  });
}

/** [취소]: 확인 시트를 먼저 띄우는 고정 버튼(ADR-03, F2-7). */
export function cancelAction(r: ReservationRow): CardAction {
  return {
    type: 'fixed',
    text: '취소',
    method: 'DELETE',
    path: `/api/rooms/reservations/${r.id}`,
    confirm: {
      title: '예약을 취소할까요?',
      lines: [roomLine({ name: r.roomName, floor: r.floor }), whenText(r.start, r.end)],
      confirmLabel: '취소하기',
      note: '취소한 기록은 남아요',
    },
  };
}

/** 확정 카드: "HH:MM에 다시 확인하고 예약했어요" + 취소(F2-7). */
export function confirmedCard(r: ReservationRow, checkedAt: number): Card {
  return makeCard({
    id: `rooms-reservation-${r.id}`,
    kind: 'rooms',
    label: '확정',
    headline: '예약했어요',
    fields: [
      { name: '방·층', value: roomLine({ name: r.roomName, floor: r.floor }) },
      { name: '날짜·시간', value: whenText(r.start, r.end) },
      { name: '상태', value: '내 예약' },
    ],
    evidence: { text: `${kstTime(checkedAt)}에 다시 확인하고 예약했어요`, aiSummarized: false },
    primary: { type: 'navigate', text: '내 것에서 보기', to: 'mine' },
    secondary: [cancelAction(r)],
    tail: '예약 기록이 남아요',
  });
}

/** 취소 뒤: 확정 카드가 "취소됨"으로 바뀌어요. */
export function cancelledCard(r: ReservationRow, at: number): Card {
  return makeCard({
    id: `rooms-reservation-${r.id}`,
    kind: 'rooms',
    label: '확정',
    headline: '예약을 취소했어요',
    fields: [
      { name: '방·층', value: roomLine({ name: r.roomName, floor: r.floor }) },
      { name: '날짜·시간', value: whenText(r.start, r.end) },
      { name: '상태', value: '취소됨' },
    ],
    evidence: { text: `${kstTime(at)}에 취소했어요`, aiSummarized: false },
    tail: '취소한 기록은 남아요',
  });
}

/** 방 자세히에서 고른 시간이 이미 차 있을 때. 같은 방 가까운 시간 대안이 뒤따라요. */
export function roomTakenCard(room: { name: string; floor: string }, start: number, end: number, alternatives: number, checkedAt: number): Card {
  return makeCard({
    id: 'rooms-taken',
    kind: 'rooms',
    label: '안내',
    headline: '그 시간에는 이미 예약이 있어요',
    fields: [
      { name: '방·층', value: roomLine(room) },
      { name: '고른 시간', value: whenText(start, end) },
      { name: '대안', value: alternatives ? `같은 방 가까운 시간 ${alternatives}개` : '대안 없음' },
    ],
    evidence: { text: statusAt(checkedAt), aiSummarized: false },
    tail: alternatives ? NOT_RESERVED : `${NOT_RESERVED} · 다른 시간을 골라 주세요`,
  });
}

/** 방 자세히에서 고른 시간을 쓸 수 없을 때(지난 시간 등) */
export function roomTimeCard(headline: string): Card {
  return makeCard({
    id: 'rooms-time',
    kind: 'rooms',
    label: '안내',
    headline,
    evidence: { text: '일정에서 빈 시간을 골라 주세요', aiSummarized: false },
    tail: NOT_RESERVED,
  });
}
