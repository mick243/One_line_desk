import { addDays, type Equipment, kstDate, kstToEpoch } from '@one-line-desk/shared';
import type { AdapterCapabilities } from '../../adapters/types';
import { LEDGER_BOOKINGS, LEDGER_ROOMS, type LedgerSourceBooking, type LedgerSourceRoom } from './fixtures/ledger';

// 회의실 장부 어댑터(ADR-05·06). 바깥 장부를 감추고, 예약자 이름·회의 제목은 여기서 멈춰요.
// 나가는 타입(LedgerRoom·LedgerBooking)에는 그 칸이 아예 없어요.

export interface RoomLedgerCapabilities extends AdapterCapabilities {
  /** 빈 시간을 장부가 직접 주는지, 예약 목록으로 계산하는지 */
  freeTime: 'direct' | 'computed' | 'none';
  write: boolean;
}

export interface LedgerRoom {
  id: string;
  name: string;
  floor: string;
  capacity: number;
  equipment: Equipment[];
  facilities: string[];
  photoUrl: string | null;
}

/** 남의 예약. 예약자 이름·회의 제목 칸이 없어요. */
export interface LedgerBooking {
  ref: string;
  roomId: string;
  /** UTC 밀리초 */
  start: number;
  end: number;
}

export class MockRoomLedger {
  readonly capabilities: RoomLedgerCapabilities = { name: 'mock-room-ledger', label: '회의실 장부(모의)', mock: true, freeTime: 'computed', write: true };

  constructor(private readonly source: { rooms: LedgerSourceRoom[]; bookings: LedgerSourceBooking[] } = { rooms: LEDGER_ROOMS, bookings: LEDGER_BOOKINGS }) {}

  rooms(): LedgerRoom[] {
    return this.source.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      floor: r.floor,
      capacity: r.capacity,
      equipment: [...r.equipment],
      facilities: [...r.facilities],
      photoUrl: r.photoUrl,
    }));
  }

  /** 가져오는 날(now) 기준으로 날짜를 맞춰요. 칸을 하나씩 골라 옮겨서 이름·제목이 따라 나가지 않아요. */
  bookings(now: number): LedgerBooking[] {
    const today = kstDate(now);
    return this.source.bookings.map((b) => {
      const date = addDays(today, b.dayOffset);
      return { ref: b.ref, roomId: b.roomId, start: kstToEpoch(date, b.start), end: kstToEpoch(date, b.end) };
    });
  }
}
