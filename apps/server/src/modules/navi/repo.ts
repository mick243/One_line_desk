import type { Kind, WrongReason } from '@one-line-desk/shared';
import type { Queryable } from '../../core/db';
import type { ChartRow } from './chart-csv';

// navi 표(navi_rows·navi_feedback)만 읽고 써요. SQL은 여기에만 둬요.

interface RowRecord {
  id: string;
  task: string;
  team: string;
  desk: string;
  desk_url: string | null;
  next_step: string;
  processing_period: string | null;
  aliases: string[];
  revised_on: string;
  owner_department: string;
}

export type StoredRow = ChartRow & { revisedOn: string };

const ROW_COLUMNS = `id, task, team, desk, desk_url, next_step, processing_period, aliases, to_char(revised_on, 'YYYY-MM-DD') as revised_on, owner_department`;

function toRow(r: RowRecord): StoredRow {
  return {
    id: r.id,
    task: r.task,
    team: r.team,
    desk: r.desk,
    deskUrl: r.desk_url,
    nextStep: r.next_step,
    processingPeriod: r.processing_period,
    aliases: r.aliases ?? [],
    revisedOn: r.revised_on,
    ownerDepartment: r.owner_department,
  };
}

export async function countRows(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('select count(*)::int as n from navi_rows');
  return rows[0]?.n ?? 0;
}

export async function allRows(q: Queryable): Promise<StoredRow[]> {
  const { rows } = await q.query<RowRecord>(`select ${ROW_COLUMNS} from navi_rows order by id`);
  return rows.map(toRow);
}

export async function rowsOfDepartment(q: Queryable, department: string): Promise<StoredRow[]> {
  const { rows } = await q.query<RowRecord>(`select ${ROW_COLUMNS} from navi_rows where owner_department = $1 order by id`, [department]);
  return rows.map(toRow);
}

export async function findRows(q: Queryable, ids: string[]): Promise<StoredRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await q.query<RowRecord>(`select ${ROW_COLUMNS} from navi_rows where id = any($1::text[]) order by id`, [ids]);
  return rows.map(toRow);
}

export async function ownerDepartments(q: Queryable): Promise<Set<string>> {
  const { rows } = await q.query<{ owner_department: string }>('select distinct owner_department from navi_rows');
  return new Set(rows.map((r) => r.owner_department));
}

/** 가져오기·반영 모두 이 하나로 써요. 사람 이름 칸은 받지도 않아요. */
export async function upsertRow(q: Queryable, row: StoredRow): Promise<void> {
  await q.query(
    `insert into navi_rows (id, task, team, desk, desk_url, next_step, processing_period, aliases, revised_on, owner_department)
     values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::date, $10)
     on conflict (id) do update set task = excluded.task, team = excluded.team, desk = excluded.desk, desk_url = excluded.desk_url,
       next_step = excluded.next_step, processing_period = excluded.processing_period, aliases = excluded.aliases,
       revised_on = excluded.revised_on, owner_department = excluded.owner_department`,
    [row.id, row.task, row.team, row.desk, row.deskUrl, row.nextStep, row.processingPeriod, row.aliases, row.revisedOn, row.ownerDepartment],
  );
}

/** 비어 있을 때만 넣어요(seed). 이미 있으면 건드리지 않아요. */
export async function insertRowIfAbsent(q: Queryable, row: StoredRow): Promise<void> {
  await q.query(
    `insert into navi_rows (id, task, team, desk, desk_url, next_step, processing_period, aliases, revised_on, owner_department)
     values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::date, $10)
     on conflict (id) do nothing`,
    [row.id, row.task, row.team, row.desk, row.deskUrl, row.nextStep, row.processingPeriod, row.aliases, row.revisedOn, row.ownerDepartment],
  );
}

export interface FeedbackRecord {
  predictedKind: Kind;
  correctedKind: Kind | null;
  predictedRow: string | null;
  chosenRow: string | null;
  reason: WrongReason;
  /** 날 단위로 줄인 시각(ISO). 감사 로그 시각과 이어 붙지 않게 해요. */
  at: string;
}

/** R8 여섯 칸만 넣어요. 사용자 ID·가명 ID·질문 원문 칸은 표에도 없어요. */
export async function insertFeedback(q: Queryable, f: FeedbackRecord): Promise<void> {
  await q.query('insert into navi_feedback (predicted_kind, corrected_kind, predicted_row, chosen_row, reason_code, at) values ($1, $2, $3, $4, $5, $6)', [
    f.predictedKind,
    f.correctedKind,
    f.predictedRow,
    f.chosenRow,
    f.reason,
    f.at,
  ]);
}

/** 예측 행별·이유별 기록 수. since는 행마다 개정일(그날 0시, 한국 시간)이에요. */
export async function feedbackCounts(q: Queryable, rowIds: string[]): Promise<{ row: string; reason: WrongReason; at: string; n: number }[]> {
  if (rowIds.length === 0) return [];
  const { rows } = await q.query<{ row: string; reason: WrongReason; at: Date | string; n: number }>(
    `select predicted_row as row, reason_code as reason, at, count(*)::int as n
       from navi_feedback where predicted_row = any($1::text[])
      group by predicted_row, reason_code, at`,
    [rowIds],
  );
  return rows.map((r) => ({ row: r.row, reason: r.reason, at: new Date(r.at).toISOString(), n: r.n }));
}
