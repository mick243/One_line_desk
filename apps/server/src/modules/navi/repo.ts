import type { Kind, LeaveDay, WrongReason } from '@one-line-desk/shared';
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
  onboarding_week: number | null;
}

export type StoredRow = ChartRow & { revisedOn: string };

const ROW_COLUMNS = `id, task, team, desk, desk_url, next_step, processing_period, aliases, to_char(revised_on, 'YYYY-MM-DD') as revised_on, owner_department, onboarding_week`;

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
    onboardingWeek: r.onboarding_week === 1 || r.onboarding_week === 2 ? r.onboarding_week : null,
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

const rowParams = (row: StoredRow) => [
  row.id,
  row.task,
  row.team,
  row.desk,
  row.deskUrl,
  row.nextStep,
  row.processingPeriod,
  row.aliases,
  row.revisedOn,
  row.ownerDepartment,
  row.onboardingWeek,
];

/** S5 반영은 이 하나로 써요. 출처는 분장표 주인이 올린 것(upload)이에요. 사람 이름 칸은 받지도 않아요. */
export async function upsertRow(q: Queryable, row: StoredRow): Promise<void> {
  await q.query(
    `insert into navi_rows (id, task, team, desk, desk_url, next_step, processing_period, aliases, revised_on, owner_department, onboarding_week, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::date, $10, $11, 'upload')
     on conflict (id) do update set task = excluded.task, team = excluded.team, desk = excluded.desk, desk_url = excluded.desk_url,
       next_step = excluded.next_step, processing_period = excluded.processing_period, aliases = excluded.aliases,
       revised_on = excluded.revised_on, owner_department = excluded.owner_department, onboarding_week = excluded.onboarding_week, source = 'upload'`,
    rowParams(row),
  );
}

/** 비어 있을 때만 넣어요(seed). 이미 있으면 건드리지 않아요. 출처는 가상 분장표(demo)예요. */
export async function insertRowIfAbsent(q: Queryable, row: StoredRow): Promise<void> {
  await q.query(
    `insert into navi_rows (id, task, team, desk, desk_url, next_step, processing_period, aliases, revised_on, owner_department, onboarding_week, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::date, $10, $11, 'demo')
     on conflict (id) do nothing`,
    rowParams(row),
  );
}

/**
 * 가상 분장표 행과 내용이 같은 행만 demo로 되돌려요(130 마이그레이션 전에 만든 시연 DB는 모두 upload로 시작해요).
 * 개정일·온보딩 주차는 견주지 않아요.
 */
export async function markDemoRow(q: Queryable, row: ChartRow): Promise<void> {
  await q.query(
    `update navi_rows set source = 'demo', onboarding_week = coalesce(onboarding_week, $10)
      where id = $1 and source = 'upload' and task = $2 and team = $3 and desk = $4 and desk_url is not distinct from $5
        and next_step = $6 and processing_period is not distinct from $7 and aliases = $8::text[] and owner_department = $9`,
    [row.id, row.task, row.team, row.desk, row.deskUrl, row.nextStep, row.processingPeriod, row.aliases, row.ownerDepartment, row.onboardingWeek],
  );
}

/** 분장표 주인이 반영한(upload) 행이 하나라도 있는지. 있으면 실제 분장표로 봐요. */
export async function hasUploadedRows(q: Queryable): Promise<boolean> {
  const { rows } = await q.query<{ found: boolean }>(`select exists (select 1 from navi_rows where source = 'upload') as found`);
  return rows[0]?.found === true;
}

/** 온보딩 주차가 붙은 행(1·2주차). 누구나 읽는 목록이에요. */
export async function onboardingRows(q: Queryable): Promise<StoredRow[]> {
  const { rows } = await q.query<RowRecord>(`select ${ROW_COLUMNS} from navi_rows where onboarding_week is not null order by onboarding_week, id`);
  return rows.map(toRow);
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

// ── 담당 팀 문의(ADR-16)·휴가 요청과 답장(ADR-24) ─────────────────────

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
  state: 'new' | 'seen' | 'done' | 'approved' | 'rejected';
  kind: 'general' | 'leave';
  leaveDays: LeaveDay[] | null;
  /** 보낸 사람 IdP 주체(휴가 요청만). 화면·LLM에 내보내지 않아요. */
  senderSubject: string | null;
  decisionReason: string | null;
  leaveRecorded: boolean | null;
  created: number;
  updated: number;
}

const INQUIRY_COLUMNS = `id::text as id, row_id as "rowId", task, team, department,
  sender_pseudonym as "senderPseudonym", sender_name as "senderName", sender_department as "senderDepartment",
  question, reason, state, kind, leave_days as "leaveDays", sender_subject as "senderSubject",
  decision_reason as "decisionReason", leave_recorded as "leaveRecorded",
  (extract(epoch from created_at) * 1000)::float8 as created,
  (extract(epoch from updated_at) * 1000)::float8 as updated`;

export async function insertInquiry(
  q: Queryable,
  i: Omit<InquiryRow, 'id' | 'state' | 'created' | 'updated' | 'decisionReason' | 'leaveRecorded'> & { at: number },
): Promise<InquiryRow> {
  const at = new Date(i.at).toISOString();
  const { rows } = await q.query<InquiryRow>(
    `insert into navi_inquiries (row_id, task, team, department, sender_pseudonym, sender_name, sender_department, question, reason,
       kind, leave_days, sender_subject, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $13)
     returning ${INQUIRY_COLUMNS}`,
    [
      i.rowId,
      i.task,
      i.team,
      i.department,
      i.senderPseudonym,
      i.senderName,
      i.senderDepartment,
      i.question,
      i.reason,
      i.kind,
      i.leaveDays ? JSON.stringify(i.leaveDays) : null,
      i.senderSubject,
      at,
    ],
  );
  return rows[0]!;
}

/** 보관 기간(7일)이 지난 "틀렸어요" 기록을 지워요. 분장표 주인은 최근 7일 기록만 봐요. */
export async function purgeFeedback(q: Queryable, before: number): Promise<void> {
  await q.query('delete from navi_feedback where at < $1', [new Date(before).toISOString()]);
}

/**
 * 보관 기간이 지난 문의와 답장을 지워요(7일). 한 트랜잭션 안에서 해요.
 * 지우기 직전에 지우는 문의를 보낸 주 × 받은 부서로 세어 navi_inquiry_weeks에 더해요(넓힐 후보 ④).
 * 문의는 한 번만 지워지니 한 번만 세져요. 처리 전(새 문의·확인함)에 지워진 건은 expired_open이에요.
 */
export async function purgeInquiries(q: Queryable, before: number, now: number): Promise<void> {
  const cutoff = new Date(before).toISOString();
  await q.query('delete from navi_inquiry_replies where created_at < $1', [cutoff]);
  // 지운 행(returning)으로 세요. 목록 열기와 정시 지우기가 겹쳐도, 늦게 온 쪽은 지울 행이 없어서 두 번 세지 않아요.
  await q.query(
    `with gone as (delete from navi_inquiries where created_at < $1 returning created_at, department, state)
     insert into navi_inquiry_weeks (week, department, sent, handled, expired_open, updated_at)
     select to_char(created_at at time zone 'Asia/Seoul', 'IYYY-"W"IW'), department, count(*)::int,
            (count(*) filter (where state not in ('new', 'seen')))::int, (count(*) filter (where state in ('new', 'seen')))::int, $2::timestamptz
       from gone
      group by 1, 2
     on conflict (week, department) do update set sent = navi_inquiry_weeks.sent + excluded.sent,
       handled = navi_inquiry_weeks.handled + excluded.handled, expired_open = navi_inquiry_weeks.expired_open + excluded.expired_open,
       updated_at = excluded.updated_at`,
    [cutoff, new Date(now).toISOString()],
  );
}

export interface InquiryWeekRow {
  week: string;
  sent: number;
  handled: number;
  expiredOpen: number;
}

/** 한 부서의 주간 셈. 다 센 주(그 주 문의가 모두 지워진 주)만 화면에 나가요. */
export async function inquiryWeeksOf(q: Queryable, department: string): Promise<InquiryWeekRow[]> {
  const { rows } = await q.query<InquiryWeekRow>(
    `select week, sent, handled, expired_open as "expiredOpen" from navi_inquiry_weeks where department = $1 order by week desc`,
    [department],
  );
  return rows;
}

/** 셈 행도 마지막으로 더한 뒤 7일이 지나면 지워요(ADR-21). */
export async function purgeInquiryWeeks(q: Queryable, before: number): Promise<void> {
  await q.query('delete from navi_inquiry_weeks where updated_at < $1', [new Date(before).toISOString()]);
}

/** 받은 문의함 순서: 아직 끝나지 않은 것(새 문의·확인함) 먼저, 그다음 최근 순 */
const OPEN_FIRST = `(state in ('done', 'approved', 'rejected')), created_at desc, id desc`;

export async function inquiriesOfDepartment(q: Queryable, department: string): Promise<InquiryRow[]> {
  const { rows } = await q.query<InquiryRow>(`select ${INQUIRY_COLUMNS} from navi_inquiries where department = $1 order by ${OPEN_FIRST} limit 100`, [
    department,
  ]);
  return rows;
}

export async function inquiriesOfSender(q: Queryable, pseudonymId: string): Promise<InquiryRow[]> {
  const { rows } = await q.query<InquiryRow>(
    `select ${INQUIRY_COLUMNS} from navi_inquiries where sender_pseudonym = $1 order by created_at desc, id desc limit 50`,
    [pseudonymId],
  );
  return rows;
}

/** 받은 부서 사람만 상태를 바꿔요. 새 문의 → 확인함 → 처리함 순서로만 가요. 휴가 요청은 [처리했어요] 대신 승인·반려예요. 바뀌지 않으면 null이에요. */
export async function moveInquiryState(q: Queryable, id: string, department: string, to: 'seen' | 'done', at: number): Promise<InquiryRow | null> {
  const from = to === 'seen' ? ['new'] : ['new', 'seen'];
  const { rows } = await q.query<InquiryRow>(
    `update navi_inquiries set state = $3, updated_at = $5
      where id = $1 and department = $2 and state = any($4::text[]) and (kind = 'general' or $3 = 'seen')
      returning ${INQUIRY_COLUMNS}`,
    [id, department, to, from, new Date(at).toISOString()],
  );
  return rows[0] ?? null;
}

/** 받은 부서 사람이 아직 결정 전인 휴가 요청을 잠가서 읽어요(승인 중 두 번 눌러도 한 번만). */
export async function lockOpenLeaveRequest(q: Queryable, id: string, department: string): Promise<InquiryRow | null> {
  const { rows } = await q.query<InquiryRow>(
    `select ${INQUIRY_COLUMNS} from navi_inquiries where id = $1 and department = $2 and kind = 'leave' and state in ('new', 'seen') for update`,
    [id, department],
  );
  return rows[0] ?? null;
}

export async function decideLeaveRequest(
  q: Queryable,
  id: string,
  d: { state: 'approved' | 'rejected'; reason: string | null; recorded: boolean | null; at: number },
): Promise<InquiryRow> {
  const { rows } = await q.query<InquiryRow>(
    `update navi_inquiries set state = $2, decision_reason = $3, leave_recorded = $4, updated_at = $5 where id = $1 returning ${INQUIRY_COLUMNS}`,
    [id, d.state, d.reason, d.recorded, new Date(d.at).toISOString()],
  );
  return rows[0]!;
}

/** 받은 부서 문의인지 확인하고 돌려줘요(답장 전). */
export async function inquiryOfDepartment(q: Queryable, id: string, department: string): Promise<InquiryRow | null> {
  const { rows } = await q.query<InquiryRow>(`select ${INQUIRY_COLUMNS} from navi_inquiries where id = $1 and department = $2`, [id, department]);
  return rows[0] ?? null;
}

export interface ReplyRow {
  inquiryId: string;
  authorName: string;
  body: string;
  at: number;
}

/** 답장 넣기. 같은 requestId로 두 번 와도 한 번만 들어가요. 새로 들어갔으면 true예요. */
export async function insertReply(
  q: Queryable,
  r: { inquiryId: string; authorPseudonym: string; authorName: string; body: string; requestId: string; at: number },
): Promise<boolean> {
  const { rows } = await q.query<{ id: string }>(
    `insert into navi_inquiry_replies (inquiry_id, author_pseudonym, author_name, body, request_id, created_at)
     values ($1, $2, $3, $4, $5, $6) on conflict (inquiry_id, request_id) do nothing returning id::text as id`,
    [r.inquiryId, r.authorPseudonym, r.authorName, r.body, r.requestId, new Date(r.at).toISOString()],
  );
  return rows.length > 0;
}

export async function repliesOf(q: Queryable, inquiryIds: string[]): Promise<ReplyRow[]> {
  if (!inquiryIds.length) return [];
  const { rows } = await q.query<ReplyRow>(
    `select inquiry_id::text as "inquiryId", author_name as "authorName", body, (extract(epoch from created_at) * 1000)::float8 as at
       from navi_inquiry_replies where inquiry_id = any($1::bigint[]) order by created_at, id`,
    [inquiryIds],
  );
  return rows;
}

// ── IT FAQ(넓힐 후보 ②). 기준 자료라 지우지 않아요. ─────────────────────

export interface ItFaqRow {
  id: string;
  title: string;
  aliases: string[];
  errorCodes: string[];
  steps: string[];
  revisedOn: string;
  rowId: string | null;
}

export async function countItFaqs(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('select count(*)::int as n from navi_it_faqs');
  return rows[0]?.n ?? 0;
}

export async function allItFaqs(q: Queryable): Promise<ItFaqRow[]> {
  const { rows } = await q.query<ItFaqRow>(
    `select id, title, aliases, error_codes as "errorCodes", steps, to_char(revised_on, 'YYYY-MM-DD') as "revisedOn", row_id as "rowId"
       from navi_it_faqs order by id`,
  );
  return rows;
}

/** 비어 있을 때만 넣어요(seed). 출처는 가상 FAQ(demo)예요. 분장표에 없는 행을 가리키면 행을 비워 둬요. */
export async function insertItFaqIfAbsent(q: Queryable, f: ItFaqRow): Promise<void> {
  await q.query(
    `insert into navi_it_faqs (id, title, aliases, error_codes, steps, revised_on, row_id, source)
     values ($1, $2, $3::text[], $4::text[], $5::text[], $6::date, (select id from navi_rows where id = $7), 'demo')
     on conflict (id) do nothing`,
    [f.id, f.title, f.aliases, f.errorCodes, f.steps, f.revisedOn, f.rowId],
  );
}

export async function hasUploadedItFaqs(q: Queryable): Promise<boolean> {
  const { rows } = await q.query<{ found: boolean }>(`select exists (select 1 from navi_it_faqs where source = 'upload') as found`);
  return rows[0]?.found === true;
}
