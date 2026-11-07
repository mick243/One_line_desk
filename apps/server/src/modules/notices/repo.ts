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

/** 없을 때만 넣어요. 새로 넣었으면 참이에요(사본 갱신이 새 공지를 알아채는 곳, 11/6). */
export async function insertNoticeIfAbsent(q: Queryable, n: IndexedNotice): Promise<boolean> {
  const { rows } = await q.query<{ id: string }>(
    'insert into notices (id, board, title, posted_on, url, terms) values ($1, $2, $3, $4::date, $5, $6::text[]) on conflict (id) do nothing returning id',
    [n.id, n.board, n.title, n.postedOn, n.url, n.terms],
  );
  return rows.length > 0;
}

/**
 * 시연 가상 게시판에서 들어온 공지 사본(ID 앞머리로 가려요)을 게시일이 beforeDate보다 앞이면 지워요(11/7).
 * 방문자가 올린 글이라 기록 7일 원칙을 따라요. 알림 대상 줄(notice_audience)은 함께 지워져요(on delete cascade).
 * 회사 게시판 사본은 게시판의 색인이라 지우지 않아요.
 */
export async function purgeDemoBoardCopies(q: Queryable, idPrefix: string, beforeDate: string): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>('delete from notices where starts_with(id, $1) and posted_on < $2::date returning id', [idPrefix, beforeDate]);
  return rows.map((r) => r.id);
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
