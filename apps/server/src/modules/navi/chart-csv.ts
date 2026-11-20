import { CHART_ALIAS_SEPARATOR, CHART_COLUMNS, type ChartColumn, NAVI_ROW_ID_PATTERN } from '@one-line-desk/shared';
import { DeskError } from '../../core/errors';

// 분장표 파일 가져오기(ADR-09, D9). 정해진 칸만 읽고 나머지 칸("담당자 이름" 등)은 버려요.
// 사람 이름 칸은 읽지도 않아서 DB·응답·LLM 입력 어디에도 가지 않아요.

export interface ChartRow {
  id: string;
  task: string;
  team: string;
  desk: string;
  deskUrl: string | null;
  nextStep: string;
  processingPeriod: string | null;
  aliases: string[];
  /** YYYY-MM-DD. 파일에 없으면 null이고, 반영할 때 서버가 오늘로 채워요. */
  revisedOn: string | null;
  ownerDepartment: string;
  /** 신규 입사자 첫 2주 할 일이면 1·2, 아니면 null(넓힐 후보 ①) */
  onboardingWeek: 1 | 2 | null;
}

export const CHART_FORMAT_MESSAGE = '분장표 양식으로 올려 주세요';
/**
 * 행·칸을 알면 어디를 고칠지 덧붙여요(11/1 QA M8). 칸 값은 싣지 않아요(이름이 든 칸일 수 있어요).
 */
const chartFormatError = (where?: string) => new DeskError('chart-format', 422, where ? `${CHART_FORMAT_MESSAGE}. ${where}` : CHART_FORMAT_MESSAGE);
const cellError = (rowLabel: string, col: ChartColumn, rule: string) => chartFormatError(`${rowLabel} "${CHART_COLUMNS[col]}" 칸은 ${rule}`);

const REQUIRED: ChartColumn[] = ['id', 'task', 'team', 'desk', 'nextStep', 'ownerDepartment'];
const MAX_ROWS = 500;
const MAX_LEN: Record<Exclude<ChartColumn, 'aliases' | 'revisedOn' | 'onboardingWeek'>, number> = {
  id: 9,
  task: 60,
  team: 40,
  desk: 120,
  deskUrl: 300,
  nextStep: 300,
  processingPeriod: 60,
  ownerDepartment: 40,
};
const MAX_ALIASES = 12;
const MAX_ALIAS_LEN = 30;
const ROW_ID = new RegExp(NAVI_ROW_ID_PATTERN);
const URL_SCHEME = /^(https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// 제어 문자는 칸 안에 두지 않아요.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** 따옴표·쉼표·줄바꿈을 다루는 작은 CSV 읽개(RFC 4180). 읽을 수 없으면 null이에요. */
export function parseCsv(text: string): string[][] | null {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (field.length > 0) return null;
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (quoted) return null;
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
}

// ── 머리 줄 낱말 표(후보 17, 11/17) ─────────────────────────────────────────
// 회사 엑셀은 머리 줄 이름이 우리 양식과 달라요("업무명", "담당부서", "문의처"). 정해진 낱말 표로만 우리 칸에 이어요(AI 없음).
// - 띄어쓰기·괄호 안 말("주인 부서(필수)")·별표·밑줄·가운뎃점·전각 글자 차이는 같은 칸으로 봐요.
// - 사람 이름 머리 줄("담당자"·"성명"·"이름" 등, D9)은 표에 넣지 않아요. 넣으면 표를 만들 때 멈춰요(시험이 지켜요). 그런 칸은 지금처럼 버려요.
// - 읽은 안내("'업무명' 칸을 '업무'로 읽었어요")는 우리 표에 있는 말만 되풀이해요. 파일의 모르는 칸 이름·칸 값은 싣지 않아요.
// - 분장표·IT FAQ·운영자 자료(회의실·카탈로그, scripts/ops-data-lib.ts)가 같이 써요.

/**
 * 사람 이름·연락처 머리 줄(D9). 어느 낱말 표에도 넣지 않고, 파일에 있으면 버려요.
 * 영어 "name"은 넣지 않아요: 운영자 자료(회의실·카탈로그)의 우리 칸 이름이 "name"(방·품목 이름)이에요.
 */
export const PERSON_HEADERS: readonly string[] = [
  '담당자',
  '담당자 이름',
  '담당자명',
  '담당 직원',
  '성명',
  '이름',
  '직원명',
  '직원 이름',
  '사원명',
  '작성자',
  '작성자 이름',
  '처리자',
  '연락처',
  '전화번호',
  '이메일',
];

/** 머리 줄을 견줄 모양으로: 전각·대소문자·띄어쓰기·괄호 안 말·*·_·가운뎃점·:·-·. 차이를 없애요. */
export function headerKey(h: string): string {
  return h
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】|<[^>]*>/g, '')
    .replace(/[\s*_·•:.\-]/g, '');
}

const PERSON_KEYS = new Set(PERSON_HEADERS.map(headerKey));

/** 칸 이름 뒤 조사: "업무"→"로", "담당 팀"→"으로"(받침이 없거나 ㄹ이면 "로"). 영어 칸 이름은 " 칸으로"예요("ID"는 "로"). */
function readAs(label: string): string {
  const last = label.charCodeAt(label.length - 1);
  if (last >= 0xac00 && last <= 0xd7a3) {
    const batchim = (last - 0xac00) % 28;
    return batchim === 0 || batchim === 8 ? '로' : '으로';
  }
  return /id$/i.test(label) ? '로' : ' 칸으로';
}

export interface HeaderRead<C extends string> {
  /** 파일 칸마다 읽은 우리 칸(모르는 칸은 undefined, 버려요) */
  columns: (C | undefined)[];
  /** 우리 칸 이름이 아닌 다른 이름으로 읽은 칸의 안내("'업무명' 칸을 '업무'로 읽었어요") */
  notes: string[];
  /** 읽지 않고 버린 칸 수(사람 이름 칸 포함) */
  ignored: number;
  /** 꼭 있어야 하는데 없는 칸(우리 칸 이름) */
  missing: string[];
  /** 두 칸이 같은 우리 칸으로 읽히면 그 우리 칸 이름 */
  duplicate: string | null;
}

/**
 * 머리 줄을 낱말 표로 읽어요. labels는 우리 칸 이름(양식 그대로), aliases는 칸마다 더 받는 이름이에요.
 * 표가 사람 이름 머리 줄을 담거나, 한 이름이 두 칸에 걸리면 표를 잘못 만든 거라 바로 멈춰요.
 */
export function readHeader<C extends string>(
  header: readonly string[],
  labels: Record<C, string>,
  aliases: Record<C, readonly string[]>,
  required: readonly C[],
): HeaderRead<C> {
  const table = new Map<string, { col: C; shown: string }>();
  for (const col of Object.keys(labels) as C[]) {
    for (const name of [labels[col], ...aliases[col]]) {
      const key = headerKey(name);
      if (PERSON_KEYS.has(key)) throw new Error(`머리 줄 낱말 표에 사람 이름 칸(${name})을 넣지 않아요(D9)`);
      const before = table.get(key);
      if (before && before.col !== col) throw new Error(`머리 줄 낱말 표에서 "${name}"이 두 칸에 걸려요`);
      if (!before) table.set(key, { col, shown: name });
    }
  }
  const columns: (C | undefined)[] = [];
  const notes: string[] = [];
  let ignored = 0;
  let duplicate: string | null = null;
  for (const raw of header) {
    const key = headerKey(raw);
    const hit = PERSON_KEYS.has(key) ? undefined : table.get(key);
    if (!hit) {
      if (key) ignored += 1;
      columns.push(undefined);
      continue;
    }
    if (columns.includes(hit.col)) duplicate ??= labels[hit.col];
    columns.push(hit.col);
    if (headerKey(hit.shown) !== headerKey(labels[hit.col])) notes.push(`'${hit.shown}' 칸을 '${labels[hit.col]}'${readAs(labels[hit.col])} 읽었어요`);
  }
  return { columns, notes, ignored, missing: required.filter((c) => !columns.includes(c)).map((c) => labels[c]), duplicate };
}

/** 미리보기 안내: 바꿔 읽은 칸 + 버린 칸 수(이름 없이). 분장표·IT FAQ가 같이 써요. 운영자 자료는 버린 칸 줄을 따로 찍어요. */
export function headerNotesOf(read: Pick<HeaderRead<string>, 'notes' | 'ignored'>): string[] {
  return [...read.notes, ...(read.ignored ? [`정해진 칸 말고 다른 칸 ${read.ignored}개는 읽지 않고 버렸어요`] : [])];
}

/** 분장표 칸마다 더 받는 머리 줄 이름(회사 엑셀에서 흔한 말). 사람 이름 칸은 없어요. */
export const CHART_HEADER_ALIASES: Record<ChartColumn, readonly string[]> = {
  id: ['ID', '업무 ID', '업무 코드', '행 코드', '행 번호'],
  task: ['업무명', '업무 이름', '업무 명칭', '업무 항목', '항목'],
  aliases: ['별칭', '동의어', '검색어', '키워드', '다른 이름'],
  team: ['담당부서', '담당 팀명', '처리 부서', '처리 팀', '담당 조직', '담당 부서명'],
  desk: ['문의처', '연락 창구', '문의 창구', '접수 창구', '접수처'],
  deskUrl: ['링크', 'URL', '문의 링크', '신청 링크', '바로가기'],
  nextStep: ['할 일', '처리 방법', '신청 방법', '처리 절차', '절차', '안내'],
  processingPeriod: ['소요 기간', '처리 일수', '소요 시간', '처리 시간'],
  revisedOn: ['수정일', '변경일', '갱신일', '최종 수정일'],
  ownerDepartment: ['관리 부서', '소유 부서', '분장표 주인', '작성 부서'],
  onboardingWeek: ['온보딩', '입사 주차'],
};

function clean(value: string | undefined): string {
  return (value ?? '').normalize('NFC').trim();
}

/**
 * 분장표 CSV를 행으로 바꿔요. 양식이 아니면 "분장표 양식으로 올려 주세요"로 거부해요.
 * 정해진 칸 말고는 모두 버려요(사람 이름 칸 포함).
 */
export function parseChart(text: string): ChartRow[] {
  return parseChartFile(text).rows;
}

/**
 * parseChart와 같고, 파일에 "온보딩 주차" 칸이 있었는지도 알려 줘요.
 * 칸이 없는 옛 양식이면 반영할 때 지금 값을 그대로 둬요(11/1 QA M7).
 */
export function parseChartFile(text: string): { rows: ChartRow[]; hasOnboarding: boolean; headerNotes: string[] } {
  const table = parseCsv(text);
  if (!table || table.length < 2) throw chartFormatError();
  const read = readHeader(table[0]!, CHART_COLUMNS, CHART_HEADER_ALIASES, REQUIRED);
  const header = read.columns;
  // 꼭 있어야 하는 칸이 없으면 어느 칸인지와 양식 받기를 알려요(후보 17). 행 ID·주인 부서는 회사 엑셀에 보통 없어요.
  if (read.missing.length)
    throw chartFormatError(`${read.missing.map((m) => `"${m}"`).join('·')} 칸이 없어요. [분장표 파일 받기]로 받은 양식에 맞춰 올려 주세요`);
  if (read.duplicate) throw chartFormatError(`"${read.duplicate}" 칸으로 읽히는 칸이 둘 있어요. 하나만 남겨 주세요`);
  if (table.length - 1 > MAX_ROWS) throw chartFormatError();

  const index = (col: ChartColumn) => header.indexOf(col);
  const seen = new Set<string>();
  const rows: ChartRow[] = [];
  for (const [i, cells] of table.slice(1).entries()) {
    const line = `${i + 2}번째 줄`;
    const get = (col: ChartColumn) => {
      const at = index(col);
      // 내보낼 때 수식 막기로 붙인 '를 다시 떼요(toCsv).
      return at < 0 ? '' : clean(cells[at]).replace(/^'(?=[=+\-@])/, '');
    };
    const row: ChartRow = {
      id: get('id'),
      task: get('task'),
      team: get('team'),
      desk: get('desk'),
      deskUrl: get('deskUrl') || null,
      nextStep: get('nextStep'),
      processingPeriod: get('processingPeriod') || null,
      aliases: [
        ...new Set(
          get('aliases')
            .split(CHART_ALIAS_SEPARATOR)
            .map((a) => a.trim())
            .filter(Boolean),
        ),
      ],
      revisedOn: get('revisedOn') || null,
      ownerDepartment: get('ownerDepartment'),
      onboardingWeek: null,
    };
    const label = ROW_ID.test(row.id) ? `${row.id} 행` : line;
    row.onboardingWeek = onboardingWeek(get('onboardingWeek'), label);
    validateRow(row, label);
    if (seen.has(row.id)) throw chartFormatError(`${row.id} 행이 두 번 있어요`);
    seen.add(row.id);
    rows.push(row);
  }
  return { rows, hasOnboarding: header.includes('onboardingWeek'), headerNotes: headerNotesOf(read) };
}

/** "온보딩 주차" 칸: 비우면 null, 1·2(또는 "1주차"·"2주차", 전각 숫자)만 받아요. */
function onboardingWeek(value: string, label: string): 1 | 2 | null {
  if (value === '') return null;
  const m = /^([12])(?:\s*주차)?$/.exec(value.normalize('NFKC'));
  if (!m) throw cellError(label, 'onboardingWeek', '1·2만 써요(아니면 비워 두세요)');
  return m[1] === '1' ? 1 : 2;
}

function validateRow(row: ChartRow, label: string): void {
  if (!ROW_ID.test(row.id)) throw cellError(label, 'id', 'FIN-01처럼 써요');
  for (const col of REQUIRED) {
    const value = row[col as Exclude<ChartColumn, 'aliases' | 'onboardingWeek'>];
    if (typeof value !== 'string' || value.length === 0) throw cellError(label, col, '비울 수 없어요');
  }
  for (const [col, max] of Object.entries(MAX_LEN) as [keyof typeof MAX_LEN, number][]) {
    const value = row[col];
    if (value !== null && value.length > max) throw cellError(label, col, `${max}자까지 써요`);
    if (value !== null && CONTROL.test(value)) throw cellError(label, col, '보이지 않는 특수 글자를 지워 주세요');
  }
  if (row.deskUrl !== null && !URL_SCHEME.test(row.deskUrl)) throw cellError(label, 'deskUrl', 'https:// 또는 mailto:로 시작해요');
  if (row.revisedOn !== null && (!DATE.test(row.revisedOn) || Number.isNaN(Date.parse(row.revisedOn))))
    throw cellError(label, 'revisedOn', '2026-10-31처럼 써요');
  if (row.aliases.length > MAX_ALIASES) throw cellError(label, 'aliases', `${MAX_ALIASES}개까지 써요`);
  if (row.aliases.some((a) => a.length > MAX_ALIAS_LEN || CONTROL.test(a))) throw cellError(label, 'aliases', `낱말마다 ${MAX_ALIAS_LEN}자까지 써요`);
}

/** 우리 부서 행을 다시 CSV로 내보내요(S5 파일 받기). 사람 이름 칸은 없어요. */
export function toCsv(rows: ChartRow[]): string {
  const cols = Object.keys(CHART_COLUMNS) as ChartColumn[];
  // =·+·-·@로 시작하는 칸은 표 프로그램이 수식으로 읽지 않게 '를 붙여요(가져올 때 다시 떼요).
  const cell = (raw: string) => {
    const v = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
  };
  const line = (row: ChartRow) =>
    cols
      .map((c) => {
        const v = row[c];
        if (Array.isArray(v)) return cell(v.join(CHART_ALIAS_SEPARATOR));
        return cell(v === null ? '' : String(v));
      })
      .join(',');
  return `﻿${cols.map((c) => CHART_COLUMNS[c]).join(',')}\r\n${rows.map(line).join('\r\n')}\r\n`;
}
