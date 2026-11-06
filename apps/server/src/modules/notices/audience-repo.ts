import type { NoticeAudience, NoticeAudienceRole, NoticeAudienceState } from '@one-line-desk/shared';
import type { Queryable } from '../../core/db';

// notice_audience 표(220_notices_audience.sql)만 읽고 써요. 공지 제목·게시일·링크는 같은 모듈의 notices 표에서 붙여요.
// 사람 칸은 없어요(누가 확인했는지·누구에게 갔는지 없음).

export interface AudienceRow {
  id: string;
  noticeId: string;
  title: string;
  board: string;
  postedOn: string;
  url: string;
  audience: NoticeAudience;
  evidence: string[];
  byModel: boolean;
  state: NoticeAudienceState;
  auto: boolean;
  sentCount: number | null;
  createdAt: number;
  decidedAt: number | null;
}

interface DbRow {
  id: string;
  notice_id: string;
  title: string;
  board: string;
  posted_on: string;
  url: string;
  everyone: boolean;
  departments: string[];
  floors: string[];
  roles: string[];
  evidence: string[];
  by_model: boolean;
  state: NoticeAudienceState;
  auto: boolean;
  sent_count: number | null;
  created: number;
  decided: number | null;
}

const SELECT = `select a.id::text as id, a.notice_id, n.title, n.board, to_char(n.posted_on, 'YYYY-MM-DD') as posted_on, n.url,
       a.everyone, a.departments, a.floors, a.roles, a.evidence, a.by_model, a.state, a.auto, a.sent_count,
       (extract(epoch from a.created_at) * 1000)::float8 as created,
       (extract(epoch from a.decided_at) * 1000)::float8 as decided
  from notice_audience a join notices n on n.id = a.notice_id`;

const toRow = (r: DbRow): AudienceRow => ({
  id: r.id,
  noticeId: r.notice_id,
  title: r.title,
  board: r.board,
  postedOn: r.posted_on,
  url: r.url,
  audience: { everyone: r.everyone, departments: r.departments, floors: r.floors, roles: r.roles as NoticeAudienceRole[] },
  evidence: r.evidence,
  byModel: r.by_model,
  state: r.state,
  auto: r.auto,
  sentCount: r.sent_count,
  createdAt: Number(r.created),
  decidedAt: r.decided === null ? null : Number(r.decided),
});

export async function insertAudience(
  q: Queryable,
  row: {
    noticeId: string;
    audience: NoticeAudience;
    evidence: string[];
    byModel: boolean;
    state: 'pending' | 'sent';
    auto: boolean;
    sentCount: number | null;
    at: number;
  },
): Promise<string | null> {
  const at = new Date(row.at).toISOString();
  const { rows } = await q.query<{ id: string }>(
    `insert into notice_audience (notice_id, everyone, departments, floors, roles, evidence, by_model, state, auto, sent_count, created_at, decided_at)
     values ($1, $2, $3::text[], $4::text[], $5::text[], $6::text[], $7, $8, $9, $10, $11, $12)
     on conflict (notice_id) do nothing returning id::text as id`,
    [
      row.noticeId,
      row.audience.everyone,
      row.audience.departments,
      row.audience.floors,
      row.audience.roles,
      row.evidence,
      row.byModel,
      row.state,
      row.auto,
      row.sentCount,
      at,
      row.state === 'pending' ? null : at,
    ],
  );
  return rows[0]?.id ?? null;
}

/** 보관 기간(since 이후에 만든 것) 안의 줄. 확인 대기 먼저, 그다음 새것부터예요. */
export async function listAudience(q: Queryable, since: number, limit: number): Promise<AudienceRow[]> {
  const { rows } = await q.query<DbRow>(
    `${SELECT} where a.created_at >= $1 order by (a.state = 'pending') desc, a.created_at desc, a.id desc limit ${Number(limit)}`,
    [new Date(since).toISOString()],
  );
  return rows.map(toRow);
}

/** 공지 탭 "새 공지": 보관 기간 안에 들어온 새 공지(상태와 상관없이) 새것부터예요. */
export async function listNew(q: Queryable, since: number, limit: number): Promise<AudienceRow[]> {
  const { rows } = await q.query<DbRow>(`${SELECT} where a.created_at >= $1 order by n.posted_on desc, a.created_at desc, a.id desc limit ${Number(limit)}`, [
    new Date(since).toISOString(),
  ]);
  return rows.map(toRow);
}

/** 한 줄을 잠그고 읽어요(두 총무가 동시에 눌러도 한 번만). 보관 기간이 지난 줄은 없는 것으로 봐요. */
export async function lockAudience(q: Queryable, id: string, since: number): Promise<AudienceRow | null> {
  const { rows } = await q.query<DbRow>(`${SELECT} where a.id = $1::bigint and a.created_at >= $2 for update of a`, [id, new Date(since).toISOString()]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function decideAudience(
  q: Queryable,
  id: string,
  next: { state: 'sent' | 'skipped'; audience: NoticeAudience; sentCount: number; at: number },
): Promise<void> {
  await q.query(
    `update notice_audience set state = $2, everyone = $3, departments = $4::text[], floors = $5::text[], roles = $6::text[], sent_count = $7, decided_at = $8
      where id = $1::bigint and state = 'pending'`,
    [
      id,
      next.state,
      next.audience.everyone,
      next.audience.departments,
      next.audience.floors,
      next.audience.roles,
      next.sentCount,
      new Date(next.at).toISOString(),
    ],
  );
}

/** 7일(RECORD_KEEP_DAYS) 지난 줄을 지워요. */
export async function purgeAudience(q: Queryable, before: number): Promise<void> {
  await q.query('delete from notice_audience where created_at < $1', [new Date(before).toISOString()]);
}
