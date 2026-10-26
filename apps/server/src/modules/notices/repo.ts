import type { Queryable } from '../../core/db';

// notices 표만 읽고 써요. 본문 칸은 없고 색인 조각(terms)만 있어요.

export interface IndexedNotice {
  id: string;
  board: string;
  title: string;
  postedOn: string;
  url: string;
  terms: string[];
}

export async function countNotices(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('select count(*)::int as n from notices');
  return rows[0]?.n ?? 0;
}

export async function insertNoticeIfAbsent(q: Queryable, n: IndexedNotice): Promise<void> {
  await q.query('insert into notices (id, board, title, posted_on, url, terms) values ($1, $2, $3, $4::date, $5, $6::text[]) on conflict (id) do nothing', [
    n.id,
    n.board,
    n.title,
    n.postedOn,
    n.url,
    n.terms,
  ]);
}

/** 허용 게시판 안에서 조각이 하나라도 겹치는 공지만 가져와요. */
export async function candidates(q: Queryable, boards: readonly string[], grams: string[]): Promise<IndexedNotice[]> {
  if (grams.length === 0) return [];
  const { rows } = await q.query<{ id: string; board: string; title: string; posted_on: string; url: string; terms: string[] }>(
    `select id, board, title, to_char(posted_on, 'YYYY-MM-DD') as posted_on, url, terms
       from notices where board = any($1::text[]) and terms && $2::text[]`,
    [boards, grams],
  );
  return rows.map((r) => ({ id: r.id, board: r.board, title: r.title, postedOn: r.posted_on, url: r.url, terms: r.terms }));
}
