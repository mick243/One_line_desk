import { addDays, type RoomStatus } from '@one-line-desk/shared';

// 회의실 둘러보기 화면 글자 도우미. 시각은 서버가 준 한국 시각(HH:MM)만 써요.

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** "10월 27일(화)" */
export function dateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${DAYS[d.getUTCDay()]})`;
}

/** 오늘·내일·모레 칩. 기준 날짜는 서버가 준 오늘이에요. */
export function dayChips(today: string): { date: string; label: string }[] {
  return [
    { date: today, label: '오늘' },
    { date: addDays(today, 1), label: '내일' },
    { date: addDays(today, 2), label: '모레' },
  ];
}

export function statusText(status: RoomStatus): string {
  if (status.kind === 'busy-now') return `사용 중 · ${status.freeAt}부터 비어요`;
  if (status.kind === 'free-now') return status.nextBusyAt ? `지금 비어 있어요 · ${status.nextBusyAt}부터 예약` : '지금 비어 있어요 · 오늘 남은 예약 없음';
  return status.bookings ? `예약 ${status.bookings}건` : '예약 없음';
}

export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 서버 조회 시각(ISO +09:00) → 'YYYY-MM-DD'·'HH:MM' */
export function splitCheckedAt(checkedAt: string): { date: string; time: string } {
  return { date: checkedAt.slice(0, 10), time: checkedAt.slice(11, 16) };
}
