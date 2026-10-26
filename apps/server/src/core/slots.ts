import { addDays, EQUIPMENT, type Equipment, kstDate, type Slots } from '@one-line-desk/shared';

// 규칙으로 뽑는 슬롯. 모델 없이 돌 때(FakeProvider)와 모델 결과를 보충할 때 써요.
// 원문을 저장하지 않고 이 요청 안에서만 다뤄요.

const EQUIPMENT_WORDS: Record<Equipment, RegExp> = {
  화면: /화면|모니터|tv|티비|프로젝터|빔/i,
  화상회의: /화상|줌|zoom|팀즈|teams|웹엑스|원격 ?회의/i,
  화이트보드: /화이트 ?보드|칠판/i,
};

export function parseSlots(text: string, now: number): Slots {
  const slots: Slots = {};
  const today = kstDate(now);

  const date = parseDate(text, today);
  if (date) slots.date = date;

  const start = parseTime(text);
  if (start) slots.start = start;

  const hours = text.match(/(\d+(?:\.\d+)?)\s*시간/);
  const minutes = text.match(/(\d+)\s*분\s*(동안|간)/);
  if (hours) slots.minutes = Math.round(Number(hours[1]) * 60);
  else if (minutes) slots.minutes = Number(minutes[1]);

  const people = text.match(/(\d+)\s*(명|인)/);
  if (people) slots.people = Number(people[1]);

  const equipment = EQUIPMENT.filter((e) => EQUIPMENT_WORDS[e].test(text));
  if (equipment.length) slots.equipment = equipment;

  const floor = text.match(/(\d+)\s*층/);
  if (floor) slots.floor = `${floor[1]}층`;

  const item = extractItemName(text);
  if (item) slots.itemName = item;

  return slots;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
type Weekday = (typeof WEEKDAYS)[number];
const pad = (n: number) => String(n).padStart(2, '0');

/** 0=일 … 6=토 (한국 날짜 기준) */
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 그 주 월요일. 회사 달력은 월요일에 한 주가 시작해요. */
function mondayOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

function ymd(y: number, m: number, d: number): string | undefined {
  const at = new Date(Date.UTC(y, m - 1, d));
  const real = at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
  return real ? `${y}-${pad(m)}-${pad(d)}` : undefined;
}

/** 월·일만 있으면 올해로 보고, 이미 지난 날이면 내년으로 봐요("1월 5일"을 10월에 말하면 내년). */
function upcomingMonthDay(today: string, m: number, d: number): string | undefined {
  const year = Number(today.slice(0, 4));
  const thisYear = ymd(year, m, d);
  if (!thisYear) return undefined;
  return thisYear >= today ? thisYear : ymd(year + 1, m, d);
}

const WEEK_OFFSET: Record<string, number> = { 이번: 0, 이: 0, 다음: 1, 담: 1, 다다음: 2, 지난: -1, 저번: -1 };

/**
 * 말로 한 날짜를 'YYYY-MM-DD'로 바꿔요. 못 알아들으면 undefined예요(화면이 날짜를 되물어요).
 * 우선순위: 숫자 날짜 → 주·요일 → "N일 뒤" → "30일" → 오늘·내일·모레·글피.
 */
export function parseDate(text: string, today: string): string | undefined {
  const full = text.match(/(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/);
  if (full) return ymd(Number(full[1]), Number(full[2]), Number(full[3]));

  const monthDay = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/) ?? text.match(/(?<![\d/])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/);
  if (monthDay) return upcomingMonthDay(today, Number(monthDay[1]), Number(monthDay[2]));

  // 주 + 요일: "다음 주 화요일", "담주 목욜", "이번 주 금", "다다음주 수요일", "지난주 월요일"
  const week = text.match(/(이번|이|다음|담|다다음|지난|저번)\s*주\s*(월|화|수|목|금|토|일)(?:요일|욜)?/);
  if (week) {
    const monday = addDays(mondayOf(today), (WEEK_OFFSET[week[1]!] ?? 0) * 7);
    return addDays(monday, (WEEKDAYS.indexOf(week[2] as Weekday) + 6) % 7);
  }
  // 주말: "이번 주말", "다음 주말" → 그 주 토요일
  const weekend = text.match(/(이번|다음|담|다다음)?\s*주말/);
  if (weekend) return addDays(addDays(mondayOf(today), (WEEK_OFFSET[weekend[1] ?? '이번'] ?? 0) * 7), 5);
  // 요일만: 오늘부터 가장 가까운 그 요일(오늘이 그 요일이면 오늘)
  const day = text.match(/(월|화|수|목|금|토|일)(?:요일|욜)/);
  if (day) return addDays(today, (WEEKDAYS.indexOf(day[1] as Weekday) - weekdayOf(today) + 7) % 7);

  // "3일 뒤", "2주 후", "일주일 뒤"
  const weekAfter = text.match(/(?:일|한)\s*주일?\s*(?:뒤|후)/);
  if (weekAfter) return addDays(today, 7);
  const after = text.match(/(\d+)\s*(일|주)\s*(?:뒤|후)/);
  if (after) return addDays(today, Number(after[1]) * (after[2] === '주' ? 7 : 1));

  // "30일"만: 이번 달 그날, 이미 지났으면 다음 달 그날("3일 동안"·"3일간"은 날짜가 아니에요)
  const dayOnly = text.match(/(?<![\d월])(\d{1,2})\s*일(?!\s*(?:뒤|후|간|동안|째))/);
  if (dayOnly) {
    const d = Number(dayOnly[1]);
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const thisMonth = ymd(y, m, d);
    if (thisMonth && thisMonth >= today) return thisMonth;
    return m === 12 ? ymd(y + 1, 1, d) : ymd(y, m + 1, d);
  }

  if (/글피/.test(text)) return addDays(today, 3);
  if (/모레/.test(text)) return addDays(today, 2);
  if (/내일|명일/.test(text)) return addDays(today, 1);
  if (/오늘|금일/.test(text)) return today;
  return undefined;
}

/**
 * 말로 한 시각을 'HH:MM'으로 바꿔요. "15:30", "오후 3시 반", "저녁 7시", "10시 20분".
 * 오전·오후 같은 말이 없고 1~7시면 업무 시간(오후)으로 봐요. "2시간"은 시각이 아니에요.
 */
export function parseTime(text: string): string | undefined {
  const clock = text.match(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/);
  if (clock) return `${pad(Number(clock[1]))}:${clock[2]}`;
  if (/정오/.test(text)) return '12:00';

  const time = text.match(/(오전|오후|아침|새벽|낮|점심|저녁|밤)?\s*(\d{1,2})\s*시(?!간)\s*(반|(\d{1,2})\s*분)?/);
  if (!time) return undefined;
  let hour = Number(time[2]);
  const part = time[1];
  if ((part === '오후' || part === '저녁' || part === '밤') && hour < 12) hour += 12;
  else if ((part === '낮' || part === '점심') && hour >= 1 && hour <= 6) hour += 12;
  else if (!part && hour >= 1 && hour <= 7) hour += 12;
  const minute = time[3] === '반' ? 30 : Number(time[4] ?? 0);
  return hour <= 23 && minute <= 59 ? `${pad(hour)}:${pad(minute)}` : undefined;
}

/** "제로콜라 또 넣어 주세요" → "제로콜라". 요청 말투·부사를 걷어 내고 품목 이름만 남겨요. */
export function extractItemName(text: string): string | undefined {
  const name = text
    .replace(/[.!?~,]/g, ' ')
    .replace(/탕비실(에|에서|의)?/g, ' ')
    .replace(/(또|좀|더|다시|많이|조금|제발|혹시)(?=\s|$)/g, ' ')
    .replace(/(넣어|채워|사다|사|구매해|주문해|갖다|가져다|비치해|놓아|놔)\s*(주세요|줘요|줘|주시면|줄래요|주실\s*수\s*있나요|주시겠어요)/g, ' ')
    .replace(/(요청|부탁)(이요|해요|드려요|합니다|해)?(?=\s|$)/g, ' ')
    .replace(/(있으면\s*좋겠어요|필요해요|없어요|다\s*떨어졌어요|떨어졌어요|주세요)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name && name.length <= 30 ? name : undefined;
}
