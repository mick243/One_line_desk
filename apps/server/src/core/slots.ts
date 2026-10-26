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

  const ymd = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  const md = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (ymd) slots.date = `${ymd[1]}-${ymd[2]!.padStart(2, '0')}-${ymd[3]!.padStart(2, '0')}`;
  else if (md) slots.date = `${today.slice(0, 4)}-${md[1]!.padStart(2, '0')}-${md[2]!.padStart(2, '0')}`;
  else if (/모레/.test(text)) slots.date = addDays(today, 2);
  else if (/내일/.test(text)) slots.date = addDays(today, 1);
  else if (/오늘/.test(text)) slots.date = today;

  const time = text.match(/(오전|오후)?\s*(\d{1,2})\s*시\s*(반|(\d{1,2})\s*분)?/);
  if (time) {
    let hour = Number(time[2]);
    if (time[1] === '오후' && hour < 12) hour += 12;
    // 오전·오후가 없고 1~7시면 업무 시간(오후)으로 봐요.
    if (!time[1] && hour >= 1 && hour <= 7) hour += 12;
    const minute = time[3] === '반' ? 30 : Number(time[4] ?? 0);
    if (hour <= 23 && minute <= 59) slots.start = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

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
