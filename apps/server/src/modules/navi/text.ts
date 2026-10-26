// 분장표 후보 검색용 글자 다루기. 형태소 분석기 없이 두 글자 조각(bigram)으로 맞춰요.
// 조사·어미가 붙은 말("잃어버렸어요")도 앞부분 조각이 맞으면 후보가 돼요.

const ENDINGS = [
  '하려면',
  '하려고',
  '하는데',
  '하나요',
  '되나요',
  '있나요',
  '하면',
  '이에요',
  '했어요',
  '었어요',
  '았어요',
  '렸어요',
  '해야',
  '해요',
  '어요',
  '아요',
  '에서',
  '으로',
  '한테',
  '에게',
  '부터',
  '까지',
  '이랑',
  '하고',
  '인데',
  '는데',
  '예요',
  '에요',
  '네요',
  '나요',
  '가요',
  '려면',
  '하려',
  '죠',
  '요',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '에',
  '로',
  '의',
  '도',
  '만',
  '과',
  '와',
  '랑',
  '지',
].sort((a, b) => b.length - a.length);

// 어디서·누구 같은 묻는 말은 업무를 가리키지 않아서 빼요.
const STOPWORDS = new Set([
  '어디서',
  '어디에',
  '어디',
  '어디로',
  '누구',
  '누구한테',
  '누구에게',
  '담당',
  '담당자',
  '담당팀',
  '하나',
  '하면',
  '되나',
  '돼요',
  '어떻게',
  '방법',
  '문의',
  '알려',
  '주세',
  '주세요',
  '제가',
  '저는',
  '회사',
  '사내',
  '우리',
  '싶어',
  '싶은데',
  '할까',
  '있나',
  '있어',
  '뭐',
  '무엇',
  '그거',
  '이거',
  '이건',
  '해야',
  '하는',
  '받으',
  '받으려',
  '어디서해',
  '해요',
  '하나요',
  '되나요',
  '있나요',
  '할까요',
  '하죠',
  '되면',
  '해도',
  '되요',
]);

export function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

export function words(text: string): string[] {
  return normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

function stripEnding(word: string): string {
  let w = word;
  for (let i = 0; i < 2; i += 1) {
    const ending = ENDINGS.find((e) => w.endsWith(e) && w.length - e.length >= 2);
    if (!ending) break;
    w = w.slice(0, -ending.length);
  }
  return w;
}

/** 질문에서 업무를 가리킬 만한 말만 남겨요. */
export function keywords(text: string): string[] {
  const out: string[] = [];
  for (const word of words(text)) {
    if (STOPWORDS.has(word)) continue;
    const stem = stripEnding(word);
    if (stem.length < 2 || STOPWORDS.has(stem)) continue;
    if (!out.includes(stem)) out.push(stem);
  }
  return out;
}

/** 말 하나의 두 글자 조각. 두 글자 말은 그 자체가 조각이에요. */
export function bigramsOf(word: string): string[] {
  if (word.length < 2) return [];
  const out: string[] = [];
  for (let i = 0; i + 2 <= word.length; i += 1) out.push(word.slice(i, i + 2));
  return out;
}

/** 글 전체의 조각 집합. 띄어쓰기가 달라도 맞게 붙여 쓴 모양의 조각도 넣어요. */
export function bigramSet(...texts: string[]): Set<string> {
  const set = new Set<string>();
  for (const text of texts) {
    const ws = words(text);
    for (const w of ws) for (const b of bigramsOf(w)) set.add(b);
    for (const b of bigramsOf(ws.join(''))) set.add(b);
  }
  return set;
}

/** 말의 조각 중 몇 할이 글에 있는지(0~1) */
export function coverage(keyword: string, set: Set<string>): number {
  const grams = bigramsOf(keyword);
  if (grams.length === 0) return 0;
  return grams.filter((g) => set.has(g)).length / grams.length;
}
