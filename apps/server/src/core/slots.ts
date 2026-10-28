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
  const said = koreanHours(text);

  const date = parseDate(said, today);
  if (date) slots.date = date;

  // "3시부터 5시까지", "15:00-16:30", "오후 2시에서 3시 반까지": 시작과 길이를 같이 읽어요.
  const range = parseRange(said);
  // "지금", "30분 뒤", "점심시간": 오늘 그 시각(10분 단위로 올림)
  const soon = parseSoon(said, now);
  const start = range?.start ?? parseTime(said) ?? soon;
  if (start) slots.start = start;
  if (soon && !slots.date) slots.date = today;

  const minutes = range?.minutes ?? parseDuration(said);
  if (minutes) slots.minutes = minutes;

  const people = parsePeople(said);
  if (people) slots.people = people;

  // "프로젝터 말고", "3층 말고 다른 층": 부정이 붙은 조건은 넣지 않아요(반대로 넣지 않게, AI 접목 회의 QA 2차).
  const equipment = EQUIPMENT.filter((e) => [...said.matchAll(new RegExp(EQUIPMENT_WORDS[e].source, 'gi'))].some((m) => !negatedAfter(said, m)));
  if (equipment.length) slots.equipment = equipment;

  const floor = [...said.matchAll(/(\d+)\s*층/g)].find((m) => !negatedAfter(said, m));
  if (floor) slots.floor = `${floor[1]}층`;

  const item = extractItemName(text);
  if (item) slots.itemName = item;

  return slots;
}

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const pad = (n: number) => String(n).padStart(2, '0');

/** 0=일 … 6=토 (한국 날짜 기준) */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 그 주 월요일. 회사 달력은 월요일에 한 주가 시작해요. */
export function mondayOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

export function ymd(y: number, m: number, d: number): string | undefined {
  const at = new Date(Date.UTC(y, m - 1, d));
  const real = at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
  return real ? `${y}-${pad(m)}-${pad(d)}` : undefined;
}

/** 월·일만 있으면 올해로 보고, 이미 지난 날이면 내년으로 봐요("1월 5일"을 10월에 말하면 내년). */
export function upcomingMonthDay(today: string, m: number, d: number): string | undefined {
  const year = Number(today.slice(0, 4));
  const thisYear = ymd(year, m, d);
  if (!thisYear) return undefined;
  return thisYear >= today ? thisYear : ymd(year + 1, m, d);
}

export const WEEK_OFFSET: Record<string, number> = { 이번: 0, 이: 0, 다음: 1, 담: 1, 다다음: 2, 지난: -1, 저번: -1 };

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

  // "다음 달 30일", "이번 달 5일", "다다음 달 1일": 그 달의 그날("30일"만 있으면 아래에서 이번 달로 봐요)
  const monthOf = text.match(/(이번|이|다음|담|다다음)\s*달\s*(\d{1,2})\s*일/);
  if (monthOf) {
    const offset = { 이번: 0, 이: 0, 다음: 1, 담: 1, 다다음: 2 }[monthOf[1] as '이번'] ?? 0;
    const total = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 + offset;
    return ymd(Math.floor(total / 12), (total % 12) + 1, Number(monthOf[2]));
  }

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
  if (/내일|명일|(?<![가-힣])낼(?=\s|\d|$)/.test(text)) return addDays(today, 1);
  if (/오늘|금일/.test(text)) return today;
  return undefined;
}

const NEGATION_AFTER = /^\s*(?:은|는|이|가|을|를)?\s*(?:말고|빼고|없는|없이|제외|아닌|아니어도|안\s*돼도|필요\s*없|없어도)/;

/** 그 말 바로 뒤에 "말고·빼고·없는"이 붙었는지 */
function negatedAfter(text: string, m: RegExpMatchArray): boolean {
  return NEGATION_AFTER.test(text.slice((m.index ?? 0) + m[0].length));
}

const KOREAN_NUM: Record<string, number> = {
  한: 1,
  두: 2,
  세: 3,
  네: 4,
  다섯: 5,
  여섯: 6,
  일곱: 7,
  여덟: 8,
  아홉: 9,
  열: 10,
  열한: 11,
  열두: 12,
};
const KOREAN_NUM_WORDS = '열한|열두|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열';

/** "세시", "두 시 반", "한 시간 반"의 한글 수를 숫자로 바꿔요("내일" 같은 말은 건드리지 않아요). */
function koreanHours(text: string): string {
  return text
    .replace(/(?<![가-힣])낼(?=\s|\d|$)/g, '내일')
    .replace(new RegExp(`(?<![가-힣])(${KOREAN_NUM_WORDS})\\s*(시간|시)`, 'g'), (_m, n: string, unit: string) => `${KOREAN_NUM[n]}${unit}`);
}

/** 회의 길이(분). "90분", "1시간 반", "1시간 30분", "1.5시간", "2시간짜리". "3시 20분"의 분·"30분 뒤"는 길이가 아니에요. */
function parseDuration(text: string): number | undefined {
  const hm = text.match(/(\d+(?:\.\d+)?)\s*시간\s*(반|(\d{1,2})\s*분)?(?!\s*(?:뒤|후))/);
  if (hm) return Math.round(Number(hm[1]) * 60) + (hm[2] === '반' ? 30 : Number(hm[3] ?? 0));
  // 시각("3시 30분")을 먼저 지우고 남은 "N분"만 길이로 봐요. "3시 90분"의 90분은 시각이 아니라 길이예요.
  const rest = text.replace(/\d{1,2}\s*시(?!간)\s*(?:반|[0-5]?\d\s*분)?/g, ' ');
  const minutes = rest.match(/(?<![\d:])(\d{1,3})\s*분(?!\s*(?:뒤|후|에|부터))/);
  return minutes ? Number(minutes[1]) : undefined;
}

const TIME_WORD = '(?:(?:오전|오후|아침|새벽|낮|점심|저녁|밤)\\s*)?\\d{1,2}\\s*시(?!간)\\s*(?:반|\\d{1,2}\\s*분)?|(?<!\\d)(?:[01]?\\d|2[0-3]):[0-5]\\d';
const RANGE = new RegExp(`(${TIME_WORD})\\s*(?:부터|에서|~|-|–)\\s*(${TIME_WORD})`);

/** "A부터 B까지" → 시작과 길이. 끝 시각이 시작보다 이르면 오후로 봐요("11시부터 1시까지"). */
function parseRange(text: string): { start: string; minutes: number } | undefined {
  const m = text.match(RANGE);
  if (!m) return undefined;
  const start = parseTime(m[1]!, true);
  const end = parseTime(m[2]!, true);
  if (!start || !end) return undefined;
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let minutes = toMin(end) - toMin(start);
  if (minutes <= 0) minutes += 12 * 60;
  return minutes > 0 && minutes <= 12 * 60 ? { start, minutes } : undefined;
}

/** 인원: "6명", "2~3명"(많은 쪽), "다섯 명", "둘이서", "대여섯 명"(많은 쪽), "서너 명" */
function parsePeople(text: string): number | undefined {
  const digits = text.match(/(\d+)\s*(명|인)/);
  if (digits) return Number(digits[1]);
  const range = text.match(/(두세|서너|너댓|네다섯|대여섯|예닐곱)\s*(?:명|사람)/);
  if (range) return { 두세: 3, 서너: 4, 너댓: 5, 네다섯: 5, 대여섯: 6, 예닐곱: 7 }[range[1] as '두세'];
  const word = text.match(new RegExp(`(?<![가-힣])(${KOREAN_NUM_WORDS})\\s*(?:명|사람)`));
  if (word) return KOREAN_NUM[word[1]!];
  const together = text.match(/(둘|셋|넷|다섯|여섯)이서/);
  return together ? { 둘: 2, 셋: 3, 넷: 4, 다섯: 5, 여섯: 6 }[together[1] as '둘'] : undefined;
}

/** "지금 바로", "30분 뒤", "1시간 뒤", "점심시간" → 오늘 그 시각. 지금·N분 뒤는 10분 단위로 올려요. */
function parseSoon(text: string, now: number): string | undefined {
  if (/점심\s*시간/.test(text)) return '12:00';
  const kst = new Date(now + 9 * 3_600_000);
  let minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const after = text.match(/(\d{1,3})\s*(분|시간)\s*(?:뒤|후)/);
  if (after) minutes += Number(after[1]) * (after[2] === '시간' ? 60 : 1);
  else if (!/지금|당장|바로/.test(text)) return undefined;
  minutes = Math.ceil(minutes / 10) * 10;
  return minutes < 24 * 60 ? `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}` : undefined;
}

/**
 * 말로 한 시각을 'HH:MM'으로 바꿔요. "15:30", "오후 3시 반", "저녁 7시", "10시 20분".
 * 오전·오후 같은 말이 없고 1~6시면 업무 시간(오후)으로 봐요. 7시는 아침인지 저녁인지 몰라서 되물어요
 * (범위 "5시부터 7시까지" 안에서는 오후로 봐요, inRange). "2시간"은 시각이 아니에요.
 */
export function parseTime(text: string, inRange = false): string | undefined {
  text = koreanHours(text);
  const clock = text.match(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/);
  if (clock) return `${pad(Number(clock[1]))}:${clock[2]}`;
  if (/정오/.test(text)) return '12:00';

  const time = text.match(/(오전|오후|아침|새벽|낮|점심|저녁|밤)?\s*(\d{1,2})\s*시(?!간)\s*(반|([0-5]?\d)\s*분)?/);
  if (!time) return undefined;
  let hour = Number(time[2]);
  const part = time[1];
  if ((part === '오후' || part === '저녁' || part === '밤') && hour < 12) hour += 12;
  else if ((part === '낮' || part === '점심') && hour >= 1 && hour <= 6) hour += 12;
  else if (!part && hour === 7 && !inRange) return undefined;
  else if (!part && hour >= 1 && hour <= 7) hour += 12;
  const minute = time[3] === '반' ? 30 : Number(time[4] ?? 0);
  return hour <= 23 && minute <= 59 ? `${pad(hour)}:${pad(minute)}` : undefined;
}

/** "제로콜라 또 넣어 주세요" → "제로콜라". 요청 말투·부사를 걷어 내고 품목 이름만 남겨요. */
export function extractItemName(text: string): string | undefined {
  const name = text
    // 연락처는 품목 이름이 아니에요. "010-1234-5678 로 연락주시면 컵라면" → "컵라면"(QA-26). 문장 전체를 이름으로 뽑지 않아요.
    .replace(/(?:\+82[-\s.]?)?0\d{1,2}[-\s.)]?\d{3,4}[-\s.]?\d{4}|\[(?:이메일|IP)\]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
    .replace(/(?:^|\s)(?:으로|로|에게|께)?\s*연락\s*(?:주시면|주세요|줘요|부탁(?:해요|드려요)?|해\s*주세요|해\s*주시면|바랍니다)/g, ' ')
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
