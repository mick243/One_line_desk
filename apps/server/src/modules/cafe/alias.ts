import { CAFE_BILLING_LIMITS, checkInput } from '@one-line-desk/shared';
import { DeskError } from '../../core/errors';

// 카페 메뉴 줄임말(11/17, ADR-29 보강). 낱말 규칙 주문 해석(chat.ts)과 홈이 카페 주문 문장을 알아보는 낱말(menuWords)에 같이 써요.
// - 앱이 원래 아는 줄임말(BUILTIN_ALIASES): 가상 메뉴에 맞춘 코드 표예요. "아아 = 아메리카노 + 아이스"처럼 옵션이 딸린 말은 여기에만 둬요.
// - 총무가 적는 줄임말(cafe_menu.aliases): S9 메뉴 관리에서 메뉴마다 직접 적어요. 메뉴 이름 줄임말만이고 옵션은 딸리지 않아요.
//   AI 제안은 없어요(S9 메뉴 관리는 게이트웨이를 부르지 않아요). 모델에는 줄임말을 보내지 않아요(모델에는 메뉴 이름·옵션 이름만).
// - 줄임말 글은 감사 로그·접속기록·오류 응답에 넣지 않아요. 거부할 때는 몇 번째 줄임말인지만 알려요.

const compact = (s: string) => s.replace(/\s+/g, '');

/**
 * 앱이 원래 알아듣는 줄임말(가상 메뉴 기준). 가리키는 메뉴는 이름으로 찾아서, 총무가 메뉴를 지우거나 이름을 바꾸면 그 줄임말은 안 맞아요.
 * options는 줄임말에 들어 있는 옵션이에요("아아" = 아이스 아메리카노).
 */
export const BUILTIN_ALIASES: readonly { word: string; menu: string; options: readonly string[] }[] = [
  { word: '아아', menu: '아메리카노', options: ['아이스'] },
  { word: '뜨아', menu: '아메리카노', options: ['핫'] },
  { word: '아메', menu: '아메리카노', options: [] },
  { word: '라떼', menu: '카페라테', options: [] },
  { word: '라테', menu: '카페라테', options: [] },
  { word: '카페라떼', menu: '카페라테', options: [] },
  { word: '바닐라라떼', menu: '바닐라라테', options: [] },
  { word: '녹차라떼', menu: '녹차라테', options: [] },
  { word: '콜브', menu: '콜드브루', options: [] },
];

/** 이 이름의 메뉴에 앱이 원래 알아듣는 줄임말(총무 화면에 읽기만으로 보여요) */
export function builtinAliasesFor(name: string): string[] {
  return BUILTIN_ALIASES.filter((a) => a.menu === name).map((a) => a.word);
}

/**
 * 다른 기능으로 쏠리는 낱말(앞문 core/router-rules.ts·홈 core/home.ts·core/home-team.ts의 낱말에서 골랐어요).
 * 줄임말에 들어 있으면 홈 문장이 카페로 끌려오거나, 카페 문장이 다른 기능으로 가서 거부해요.
 */
const OTHER_FEATURE =
  /회의|미팅|공지|게시판|안내문|공문|공고|탕비실|간식|비품|채워|넣어|휴가|연차|반차|월차|병가|공가|경조|예약|대여|빌려|반납|초대|문의|담당|신청|분실|발급|고장|오류|에러|일정|스케줄|캘린더|외근|출장|재택|자리|부재|결재|팀장|부서|청구|한도|요금|비용|값/;

/** 너무 넓은 말: 줄임말 전체가 이것이면 거부해요(어느 메뉴인지 가리키지 못해요). */
const TOO_BROAD = new Set([
  '커피',
  '음료',
  '음료수',
  '주문',
  '카페',
  '메뉴',
  '마실것',
  '마실거',
  '한잔',
  '하나',
  '둘',
  '셋',
  '아이스',
  '핫',
  '샷',
  '샷추가',
  '연하게',
  '진하게',
  '따뜻한',
  '차가운',
  '뜨거운',
  '시원한',
  '음료하나',
  '커피하나',
]);

/** 주문 문장을 여러 줄로 나누는 말(chat.ts SPLIT). 줄임말에 들어 있으면 낱말 규칙이 그 말을 끊어 버려요. */
const SPLITTER = /그리고|이랑|랑|하고|및/;

const bad = (n: number, why: string) => new DeskError('bad-alias', 400, `${n}번째 줄임말은 ${why}`);

/**
 * 총무가 적은 줄임말을 다듬고 검사해요(메뉴 표를 보지 않는 검사). 띄어쓰기는 없애서 남겨요.
 * 공통 입력 검사(잠금·가림·안 보이는 글자)를 지나야 하고, 한글·영문만, 2~12자, 메뉴마다 5개까지, 같은 말 두 번은 안 돼요.
 * 다른 기능 낱말·너무 넓은 말·문장을 나누는 말이 들어 있으면 거부해요. 메뉴 이름과 같은 줄임말은 뺄 뿐 거부하지 않아요.
 */
export function cleanAliases(raw: readonly string[], menuName: string): string[] {
  if (raw.length > CAFE_BILLING_LIMITS.maxAliases) throw new DeskError('bad-alias', 400, `줄임말은 메뉴마다 ${CAFE_BILLING_LIMITS.maxAliases}개까지예요`);
  const out: string[] = [];
  raw.forEach((value, i) => {
    const n = i + 1;
    const r = checkInput(value);
    if (r.locks.length > 0 || Object.values(r.masked).some((c) => c > 0) || r.text !== value) throw bad(n, '올릴 수 없는 글자가 있어요');
    const word = compact(value);
    if (word.length < CAFE_BILLING_LIMITS.aliasMin || word.length > CAFE_BILLING_LIMITS.aliasMax)
      throw bad(n, `${CAFE_BILLING_LIMITS.aliasMin}~${CAFE_BILLING_LIMITS.aliasMax}자로 적어 주세요`);
    if (!/^[가-힣A-Za-z]+$/.test(word)) throw bad(n, '한글·영문만 적어 주세요(숫자·기호 없이)');
    if (TOO_BROAD.has(word.toLowerCase())) throw bad(n, '너무 넓은 말이라 어느 메뉴인지 알 수 없어요');
    if (OTHER_FEATURE.test(word)) throw bad(n, '다른 기능(회의실·공지·탕비실·휴가 등)으로 가는 낱말이 들어 있어요');
    if (SPLITTER.test(word)) throw bad(n, "'랑·하고·그리고·및'이 들어 있어 주문 문장을 나눌 때 끊겨요");
    if (out.includes(word)) throw bad(n, '앞에 적은 줄임말과 같아요');
    if (word === compact(menuName)) return;
    out.push(word);
  });
  return out;
}

/** 메뉴 표의 한 줄(겹침 검사용) */
export interface AliasMenu {
  id: string;
  name: string;
  options: string[];
  aliases: string[];
}

/**
 * 다른 메뉴와 겹치는지(메뉴 쓰기 잠금 안에서 불러요). 이 메뉴의 이름·줄임말이 다른 메뉴의 이름·총무 줄임말·앱이 아는 줄임말이나
 * 어느 메뉴의 옵션 이름과 같으면 거부해요. 쓰지 않는 메뉴도 견줘요(다시 팔 때 겹치지 않게).
 * 이 메뉴에 앱이 원래 아는 줄임말과 같은 것은 거부하지 않고 빼요. 남길 줄임말을 돌려줘요.
 */
export function assertNoClash(id: string | null, name: string, aliases: readonly string[], all: readonly AliasMenu[]): string[] {
  const others = all.filter((m) => m.id !== id);
  const taken = new Set(others.flatMap((m) => [compact(m.name), ...m.aliases, ...builtinAliasesFor(m.name)]));
  const optionWords = new Set(all.flatMap((m) => m.options.map(compact)));
  if (others.some((m) => m.aliases.includes(compact(name)))) throw new DeskError('bad-alias', 400, '메뉴 이름이 다른 메뉴의 줄임말과 같아요');
  aliases.forEach((word, i) => {
    if (taken.has(word)) throw bad(i + 1, '다른 메뉴의 이름이나 줄임말과 같아요');
    if (optionWords.has(word)) throw bad(i + 1, '옵션 이름과 같아요');
  });
  const builtin = builtinAliasesFor(name);
  return aliases.filter((w) => !builtin.includes(w));
}
