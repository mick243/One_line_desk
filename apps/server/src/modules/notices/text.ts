// 공지 색인용 글자 다루기. 형태소 분석기 없이 두 글자 조각(bigram)으로 맞춰요.
// navi에도 비슷한 파일이 있지만 모듈끼리 import하지 않아서(ADR-01) 따로 둬요. 불용어도 달라요.

const ENDINGS = [
  '이에요',
  '했어요',
  '었어요',
  '았어요',
  '였어요',
  '였지',
  '였나',
  '해요',
  '어요',
  '아요',
  '에서',
  '으로',
  '부터',
  '까지',
  '하고',
  '인데',
  '는데',
  '예요',
  '에요',
  '나요',
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
  '지',
].sort((a, b) => b.length - a.length);

// 공지를 찾는다는 말 자체는 어떤 공지인지 가리키지 않아서 빼요.
const STOPWORDS = new Set([
  '공지',
  '공지사항',
  '안내',
  '안내문',
  '게시판',
  '게시',
  '공문',
  '공고',
  '소식',
  '언제',
  '언제였',
  '찾아',
  '찾아줘',
  '찾기',
  '알려',
  '알려줘',
  '있어',
  '있었',
  '있나',
  '무슨',
  '관련',
  '주세요',
  '올라온',
  '나온',
  '했던',
  '이번',
  '최근',
  '회사',
  '사내',
  '어디',
  '어디서',
  '내용',
  '그거',
  '뭐였',
  '뭐',
]);

export function words(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
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

export function bigramsOf(word: string): string[] {
  if (word.length < 2) return [];
  const out: string[] = [];
  for (let i = 0; i + 2 <= word.length; i += 1) out.push(word.slice(i, i + 2));
  return out;
}

/** 글의 조각 집합. 띄어쓰기가 달라도 맞게 붙여 쓴 모양의 조각도 넣어요. */
export function bigramSet(...texts: string[]): Set<string> {
  const set = new Set<string>();
  for (const text of texts) {
    const ws = words(text);
    for (const w of ws) for (const b of bigramsOf(w)) set.add(b);
    for (const b of bigramsOf(ws.join(''))) set.add(b);
  }
  return set;
}

export function coverage(keyword: string, set: Set<string>): number {
  const grams = bigramsOf(keyword);
  if (grams.length === 0) return 0;
  return grams.filter((g) => set.has(g)).length / grams.length;
}
