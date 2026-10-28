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

// ── 담당 팀 문의(ADR-16) ──────────────────────────────────────

export interface InquiryRow {
  id: string;
  rowId: string | null;
  task: string;
  team: string;
  department: string;
  senderPseudonym: string;
  senderName: string;
  senderDepartment: string;
  question: string;
  reason: string;
  state: 'new' | 'seen' | 'done';
  created: number;
  updated: number;
}

const INQUIRY_COLUMNS = `id::text as id, row_id as "rowId", task, team, department,
  sender_pseudonym as "senderPseudonym", sender_name as "senderName", sender_department as "senderDepartment",
  question, reason, state,
  (extract(epoch from created_at) * 1000)::float8 as created,
  (extract(epoch from updated_at) * 1000)::float8 as updated`;

export async function insertInquiry(q: Queryable, i: Omit<InquiryRow, 'id' | 'state' | 'created' | 'updated'> & { at: number }): Promise<InquiryRow> {
  const at = new Date(i.at).toISOString();
  const { rows } = await q.query<InquiryRow>(
    `insert into navi_inquiries (row_id, task, team, department, sender_pseudonym, sender_name, sender_department, question, reason, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     returning ${INQUIRY_COLUMNS}`,
    [i.rowId, i.task, i.team, i.department, i.senderPseudonym, i.senderName, i.senderDepartment, i.question, i.reason, at],
  );
  return rows[0]!;
}

/** 보관 기간(7일)이 지난 "틀렸어요" 기록을 지워요. 분장표 주인은 최근 7일 기록만 봐요. */
export async function purgeFeedback(q: Queryable, before: number): Promise<void> {
  await q.query('delete from navi_feedback where at < $1', [new Date(before).toISOString()]);
}

/** 보관 기간이 지난 문의를 지워요(7일). */
export async function purgeInquiries(q: Queryable, before: number): Promise<void> {
  await q.query('delete from navi_inquiries where created_at < $1', [new Date(before).toISOString()]);
}

export async function inquiriesOfDepartment(q: Queryable, department: string): Promise<InquiryRow[]> {
  const { rows } = await q.query<InquiryRow>(
    `select ${INQUIRY_COLUMNS} from navi_inquiries where department = $1 order by (state = 'done'), created_at desc, id desc limit 100`,
    [department],
  );
  return rows;
}

export async function inquiriesOfSender(q: Queryable, pseudonymId: string): Promise<InquiryRow[]> {
  const { rows } = await q.query<InquiryRow>(
    `select ${INQUIRY_COLUMNS} from navi_inquiries where sender_pseudonym = $1 order by created_at desc, id desc limit 50`,
    [pseudonymId],
  );
  return rows;
}

/** 받은 부서 사람만 상태를 바꿔요. 새 문의 → 확인함 → 처리함 순서로만 가요. 바뀌지 않으면 null이에요. */
export async function moveInquiryState(q: Queryable, id: string, department: string, to: 'seen' | 'done', at: number): Promise<InquiryRow | null> {
  const from = to === 'seen' ? ['new'] : ['new', 'seen'];
  const { rows } = await q.query<InquiryRow>(
    `update navi_inquiries set state = $3, updated_at = $5
      where id = $1 and department = $2 and state = any($4::text[])
      returning ${INQUIRY_COLUMNS}`,
    [id, department, to, from, new Date(at).toISOString()],
  );
  return rows[0] ?? null;
}
