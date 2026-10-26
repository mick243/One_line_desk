// 회사 시간은 한국 시간(Asia/Seoul, +09:00)으로 다뤄요. 서머타임이 없어서 고정 오프셋을 써요.
export const KST_OFFSET = '+09:00';
const KST_MS = 9 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' (한국 날짜) */
export function kstDate(at: number): string {
  return new Date(at + KST_MS).toISOString().slice(0, 10);
}

/** 'HH:MM' (한국 시각) */
export function kstTime(at: number): string {
  return new Date(at + KST_MS).toISOString().slice(11, 16);
}

/** 한국 날짜에 일수를 더해요. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 한국 날짜·시각을 UTC 밀리초로 바꿔요. */
export function kstToEpoch(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00${KST_OFFSET}`);
}

/** 화면용 "10월 27일(월) 15:00" */
export function formatKstDateTime(at: number): string {
  const d = new Date(at + KST_MS);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${days.at(d.getUTCDay())}) ${kstTime(at)}`;
}
