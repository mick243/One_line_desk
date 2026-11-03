// 형태소 분석기 없이 두 글자 조각(bigram)으로 글을 맞추는 도구. 분장표 후보(navi)·공지 색인(notices)이 같이 써요.
// 조사·어미 목록과 불용어는 모듈마다 달라서 각 모듈 text.ts에 두고 `keywordReader`로 넘겨요.

export function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

export function words(text: string): string[] {
  return normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/** 조사·어미(endings)를 두 번까지 떼고 불용어(stopwords)를 뺀 말을 돌려주는 함수를 만들어요. */
export function keywordReader(endings: readonly string[], stopwords: ReadonlySet<string>): (text: string) => string[] {
  const longestFirst = [...endings].sort((a, b) => b.length - a.length);
  const stripEnding = (word: string): string => {
    let w = word;
    for (let i = 0; i < 2; i += 1) {
      const ending = longestFirst.find((e) => w.endsWith(e) && w.length - e.length >= 2);
      if (!ending) break;
      w = w.slice(0, -ending.length);
    }
    return w;
  };
  return (text) => {
    const out: string[] = [];
    for (const word of words(text)) {
      if (stopwords.has(word)) continue;
      const stem = stripEnding(word);
      if (stem.length < 2 || stopwords.has(stem)) continue;
      if (!out.includes(stem)) out.push(stem);
    }
    return out;
  };
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
