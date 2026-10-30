import { addDays, roomDateLabel, roomStatusText } from '@one-line-desk/shared';

// 회의실 둘러보기 화면 글자 도우미. 시각은 서버가 준 한국 시각(HH:MM)만 써요.

/** "10월 27일(화)" */
export const dateLabel = roomDateLabel;

/** 오늘·내일·모레 칩. 기준 날짜는 서버가 준 오늘이에요. */
export function dayChips(today: string): { date: string; label: string }[] {
  return [
    { date: today, label: '오늘' },
    { date: addDays(today, 1), label: '내일' },
    { date: addDays(today, 2), label: '모레' },
  ];
}

/** 회의실 상태 한 줄. 대화 현황 카드와 같은 글이에요(shared). */
export const statusText = roomStatusText;

export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 서버 조회 시각(ISO +09:00) → 'YYYY-MM-DD'·'HH:MM' */
export function splitCheckedAt(checkedAt: string): { date: string; time: string } {
  return { date: checkedAt.slice(0, 10), time: checkedAt.slice(11, 16) };
}
