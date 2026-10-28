import {
  type Card,
  type CardAction,
  formatKstDateTime,
  kstTime,
  type LoanKind,
  type MyReservation,
  ROOM_CONDITIONS_VARIANT,
  roomConditionFields,
  type RoomListResponse,
  type RoomQuery,
} from '@one-line-desk/shared';
import { makeCard } from '../../core/cards';
import type { LoanRow, LoanStockRow, ReservationRow, RoomRow } from './repo';
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

/** 캘린더 파일 받기 주소(ADR-17) */
export const icsPath = (reservationId: string) => `/api/rooms/reservations/${reservationId}/ics`;

/** 확정 카드·내 예약의 [참석자 초대](ADR-17). 고르기 양식은 화면이 띄우고, 보내기는 확인 시트를 거쳐요. */
export function inviteAction(r: { id: string; roomName: string; start: number; end: number }): CardAction {
  return { type: 'invite', text: '참석자 초대', reservationId: r.id, roomName: r.roomName, when: whenText(r.start, r.end) };
}

/** 확정 카드: "HH:MM에 다시 확인하고 예약했어요" + 참석자 초대 · 캘린더 파일 · 취소(F2-7, ADR-17). */
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
    primary: inviteAction(r),
    secondary: [{ type: 'link', text: '캘린더 파일 받기', href: icsPath(r.id) }, cancelAction(r)],
    tail: '예약 기록이 남아요 · 내 예약은 내 것에서 봐요',
  });
}

/** 취소 뒤: 확정 카드가 "취소됨"으로 바뀌어요. 회의에 붙여 빌린 장비도 함께 취소돼요(ADR-19). */
export function cancelledCard(r: ReservationRow, at: number, loans: LoanKind[] = []): Card {
  return makeCard({
    id: `rooms-reservation-${r.id}`,
    kind: 'rooms',
    label: '확정',
    headline: '예약을 취소했어요',
    fields: [
      { name: '방·층', value: roomLine({ name: r.roomName, floor: r.floor }) },
      { name: '날짜·시간', value: whenText(r.start, r.end) },
      { name: '상태', value: '취소됨' },
      ...(loans.length ? [{ name: '같이 빌린 장비', value: `${loans.join('·')} 대여도 취소했어요` }] : []),
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

// ── 회의실 채팅·장비 대여(ADR-19) ─────────────────────────────────

/** "빔프로젝터가" · "노트북이": 받침이 있으면 '이', 없으면 '가'예요. */
export function withSubject(word: string): string {
  const last = word.charCodeAt(word.length - 1);
  const hangul = last >= 0xac00 && last <= 0xd7a3;
  return `${word}${hangul && (last - 0xac00) % 28 !== 0 ? '이' : '가'}`;
}

const loanLine = (l: { kind: string; itemName: string }) => `${l.kind} · ${l.itemName}`;

/** [대여 취소](시작 전)·[반납](쓰는 중): 확인 시트를 먼저 띄우는 고정 버튼이에요. */
export function endLoanAction(l: LoanRow, now: number): CardAction {
  const started = l.start < now;
  return {
    type: 'fixed',
    text: started ? '반납' : '대여 취소',
    method: 'DELETE',
    path: `/api/rooms/loans/${l.id}`,
    confirm: {
      title: started ? '장비를 반납할까요?' : '대여를 취소할까요?',
      lines: [loanLine(l), whenText(l.start, l.end)],
      confirmLabel: started ? '반납하기' : '취소하기',
      note: started ? `${l.home}에 돌려놓아 주세요` : '취소하면 다른 사람이 빌릴 수 있어요',
    },
  };
}

/** 대여 확정 카드: 신청하면 바로 확정이에요. 가져갈 곳과 [대여 취소]·[반납]이 붙어요. listed면 "내 대여" 목록 한 장이에요. */
export function loanCard(l: LoanRow, checkedAt: number, listed = false): Card {
  return makeCard({
    id: `rooms-loan-${l.id}`,
    kind: 'rooms',
    label: '확정',
    headline: listed ? '내 대여' : '장비를 빌렸어요',
    fields: [
      { name: '장비', value: loanLine(l) },
      { name: '날짜·시간', value: whenText(l.start, l.end) },
      { name: '가져갈 곳', value: l.home },
      ...(l.roomName ? [{ name: '회의', value: l.roomName }] : []),
    ],
    evidence: { text: listed ? '내 대여 목록' : `${kstTime(checkedAt)}에 남은 장비를 확인하고 빌렸어요`, aiSummarized: false },
    secondary: [endLoanAction(l, checkedAt)],
    tail: '대여 기록이 남아요 · 쓰고 나면 제자리에 돌려놓아 주세요',
  });
}

/** 대여 취소·반납 뒤 */
export function loanEndedCard(l: LoanRow, how: 'cancelled' | 'returned', at: number): Card {
  return makeCard({
    id: `rooms-loan-${l.id}`,
    kind: 'rooms',
    label: '확정',
    headline: how === 'cancelled' ? '대여를 취소했어요' : '반납했어요',
    fields: [
      { name: '장비', value: loanLine(l) },
      { name: '날짜·시간', value: whenText(l.start, l.end) },
      { name: '상태', value: how === 'cancelled' ? '취소됨' : '반납함' },
    ],
    evidence: { text: `${kstTime(at)}에 ${how === 'cancelled' ? '취소' : '반납'}했어요`, aiSummarized: false },
    tail: how === 'cancelled' ? '취소한 기록은 남아요' : `${l.home}에 돌려놓아 주세요`,
  });
}

/** 빌리지 못했을 때(남은 장비 없음·지난 시간·예약 없음). 아무것도 쓰지 않았어요. */
export function loanBlockedCard(kind: LoanKind, start: number, end: number, headline: string, checkedAt: number): Card {
  return makeCard({
    id: `rooms-loan-blocked-${kind}-${start}`,
    kind: 'rooms',
    label: '막힘',
    headline,
    fields: [
      { name: '장비', value: kind },
      { name: '날짜·시간', value: whenText(start, end) },
    ],
    evidence: { text: statusAt(checkedAt), aiSummarized: false },
    tail: '아무것도 바뀌지 않았어요',
  });
}

/** 빌릴 수 있는 장비 수. 종류 하나를 물었고 남아 있으면 [빌리기](확인 시트)가 붙어요. 누가 빌렸는지는 없어요. */
export function stockCard(
  stock: LoanStockRow[],
  from: number,
  to: number,
  o: { kinds: LoanKind[]; checkedAt: number; aiSummarized: boolean; primary?: CardAction },
): Card {
  const shown = o.kinds.length ? stock.filter((s) => o.kinds.includes(s.kind)) : stock;
  return makeCard({
    id: `rooms-stock-${o.kinds.join('-') || 'all'}-${from}`,
    kind: 'rooms',
    label: o.primary ? '제안' : '안내',
    headline: o.kinds.length === 1 ? `${o.kinds[0]} 남은 수예요` : '빌릴 수 있는 장비예요',
    fields: shown.map((s) => ({ name: s.kind, value: s.free ? `${s.free}대 남음 · 전체 ${s.total}대` : `모두 대여 중 · 전체 ${s.total}대` })),
    evidence: { text: `${whenText(from, to)} 기준 · ${statusAt(o.checkedAt)}`, aiSummarized: o.aiSummarized },
    ...(o.primary ? { primary: o.primary } : {}),
    tail: o.primary ? '아직 빌리지 않았어요' : '빌리려면 "내일 3시 빔프로젝터 빌려 줘"처럼 말해 주세요',
  });
}

/** 방 하나의 장비 현황: 쓸 수 있는 설비·점검 중·비품 */
export function roomEquipmentCard(room: RoomRow, aiSummarized: boolean): Card {
  return makeCard({
    id: `rooms-equipment-${room.id}`,
    kind: 'rooms',
    label: '안내',
    headline: `${room.name} 장비예요`,
    fields: [
      { name: '방·층', value: `${roomLine(room)} · 정원 ${room.capacity}명` },
      { name: '설비', value: room.equipment.join(' · ') || '없음' },
      { name: '점검 중', value: room.repairs.join(' · ') || '없음' },
      { name: '비품', value: room.facilities.join(' · ') || '없음' },
    ],
    evidence: { text: '회의실 장부 · 점검 상태는 총무가 바꿔요', aiSummarized },
    tail: '이동식 장비(빔프로젝터·노트북 등)는 따로 빌릴 수 있어요',
  });
}

/** 회의실별 장비 현황 한 장. 점검 중인 설비는 "(점검 중)"을 붙여요. */
export function equipmentOverviewCard(rooms: RoomRow[], aiSummarized: boolean): Card {
  return makeCard({
    id: 'rooms-equipment-all',
    kind: 'rooms',
    label: '안내',
    headline: '회의실별 장비 현황이에요',
    fields: rooms.map((r) => ({
      name: roomLine(r),
      value: [...r.equipment, ...r.repairs.map((e) => `${e}(점검 중)`)].join(' · ') || '설비 없음',
    })),
    evidence: { text: '회의실 장부 · 점검 상태는 총무가 바꿔요', aiSummarized },
    tail: '방 이름을 넣어 물으면 비품까지 보여 줘요',
  });
}

/** 고른 날 회의실 현황. 남의 예약은 누가 잡았는지 없이 상태만이에요(ADR-06). */
export function overviewCard(list: RoomListResponse, o: { onlyFree: boolean; checkedAt: number; aiSummarized: boolean }): Card {
  const rooms = o.onlyFree ? list.rooms.filter((r) => r.status.kind === 'free-now') : list.rooms;
  const value = (s: RoomListResponse['rooms'][number]['status']) => {
    if (s.kind === 'free-now') return s.nextBusyAt ? `비어 있음 · 다음 예약 ${s.nextBusyAt}` : '비어 있음 · 오늘 남은 예약 없음';
    if (s.kind === 'busy-now') return `사용 중 · ${s.freeAt}부터 비어요`;
    return s.bookings ? `예약 ${s.bookings}건` : '예약 없음';
  };
  return makeCard({
    id: `rooms-overview-${list.date}${o.onlyFree ? '-free' : ''}`,
    kind: 'rooms',
    label: '안내',
    headline: o.onlyFree ? (rooms.length ? `지금 빈 방 ${rooms.length}곳이에요` : '지금 빈 방이 없어요') : `${list.date} 회의실 현황이에요`,
    fields: rooms.map((r) => ({ name: roomLine(r), value: value(r.status) })),
    evidence: { text: statusAt(o.checkedAt), aiSummarized: o.aiSummarized },
    tail: '예약하려면 "3시 6명 잡아 줘"처럼 말해 주세요',
  });
}

/** 채팅의 "내 예약" 한 장. [취소]는 확인 시트를 먼저 띄워요(취소는 자동 실행하지 않아요). */
export function myReservationCard(r: MyReservation): Card {
  return makeCard({
    id: `rooms-reservation-${r.id}`,
    kind: 'rooms',
    label: '확정',
    headline: '내 예약',
    fields: [
      { name: '방·층', value: roomLine({ name: r.roomName, floor: r.floor }) },
      { name: '날짜·시간', value: r.when },
      ...(r.loans.length ? [{ name: '같이 빌린 장비', value: r.loans.join(' · ') }] : []),
      ...(r.attendees.length ? [{ name: '참석자', value: `${r.attendees.length}명 초대` }] : []),
    ],
    evidence: { text: '내 예약 목록', aiSummarized: false },
    primary: r.invite,
    secondary: [{ type: 'link', text: '캘린더 파일 받기', href: r.icsPath }, r.cancel],
    tail: '취소는 [취소]를 누르고 한 번 더 확인해요',
  });
}

/** 채팅으로 할 수 있는 일. 시키면 바로, 물으면 카드로만이에요(ADR-19). */
/**
 * 채팅으로 할 수 있는 일. auto = 시키면 바로, confirm = 자동 실행 끔(카드 확인 시트로), read-only = 회의실 쓰기 끔(보기만, 예약·대여는 그룹웨어).
 * 회의실 쓰기가 꺼지면 카드에도 예약·대여 버튼이 없어서 "카드에서 하세요"라고 하지 않아요(QA D-C03).
 */
export function chatHelpCard(o: { mode: 'auto' | 'confirm' | 'read-only' }): Card {
  const readOnly = o.mode === 'read-only';
  return makeCard({
    id: 'rooms-chat-help',
    kind: 'rooms',
    label: '안내',
    headline: '회의실 채팅으로 이런 걸 할 수 있어요',
    fields: [
      ...(readOnly
        ? []
        : [
            { name: '예약', value: '내일 3시 6명 회의실 잡아 줘' },
            { name: '장비 대여', value: '내일 3시 회의에 빔프로젝터 빌려 줘' },
          ]),
      { name: '현황', value: readOnly ? '지금 빈 방 있어? · 오늘 회의실 현황' : '지금 빈 방 있어? · 내 예약 보여 줘' },
      { name: '장비 현황', value: '3C 장비 뭐 있어? · 노트북 남았어?' },
    ],
    evidence: { text: '회의실 채팅', aiSummarized: false },
    tail:
      o.mode === 'auto'
        ? '"잡아 줘·빌려 줘"처럼 시키면 바로 예약·대여하고, 물어보면 카드로만 보여 줘요'
        : o.mode === 'confirm'
          ? '지금은 채팅 자동 실행이 꺼져 있어서 카드에서 확인하고 예약·대여해요'
          : '지금은 예약·대여를 그룹웨어에서 해요. 채팅으로는 빈 방·장비 현황을 볼 수 있어요',
  });
}
