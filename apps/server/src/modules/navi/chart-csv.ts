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
export const chartFormatError = () => new DeskError('chart-format', 422, CHART_FORMAT_MESSAGE);

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

const HEADER_TO_COLUMN = new Map<string, ChartColumn>(Object.entries(CHART_COLUMNS).map(([key, label]) => [squash(label), key as ChartColumn]));

function squash(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, '');
}

function clean(value: string | undefined): string {
  return (value ?? '').normalize('NFC').trim();
}

/**
 * 분장표 CSV를 행으로 바꿔요. 양식이 아니면 "분장표 양식으로 올려 주세요"로 거부해요.
 * 정해진 칸 말고는 모두 버려요(사람 이름 칸 포함).
 */
export function parseChart(text: string): ChartRow[] {
  const table = parseCsv(text);
  if (!table || table.length < 2) throw chartFormatError();
  const header = table[0]!.map((h) => HEADER_TO_COLUMN.get(squash(h)));
  for (const col of REQUIRED) if (!header.includes(col)) throw chartFormatError();
  if (new Set(header.filter(Boolean)).size !== header.filter(Boolean).length) throw chartFormatError();
  if (table.length - 1 > MAX_ROWS) throw chartFormatError();

  const index = (col: ChartColumn) => header.indexOf(col);
  const seen = new Set<string>();
  const rows: ChartRow[] = [];
  for (const cells of table.slice(1)) {
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
      onboardingWeek: onboardingWeek(get('onboardingWeek')),
    };
    validateRow(row);
    if (seen.has(row.id)) throw chartFormatError();
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

/** "온보딩 주차" 칸: 비우면 null, 1·2(또는 "1주차"·"2주차")만 받아요. */
function onboardingWeek(value: string): 1 | 2 | null {
  if (value === '') return null;
  const m = /^([12])(?:\s*주차)?$/.exec(value);
  if (!m) throw chartFormatError();
  return m[1] === '1' ? 1 : 2;
}

function validateRow(row: ChartRow): void {
  if (!ROW_ID.test(row.id)) throw chartFormatError();
  for (const col of REQUIRED) {
    const value = row[col as Exclude<ChartColumn, 'aliases' | 'onboardingWeek'>];
    if (typeof value !== 'string' || value.length === 0) throw chartFormatError();
  }
  for (const [col, max] of Object.entries(MAX_LEN) as [keyof typeof MAX_LEN, number][]) {
    const value = row[col];
    if (value !== null && (value.length > max || CONTROL.test(value))) throw chartFormatError();
  }
  if (row.deskUrl !== null && !URL_SCHEME.test(row.deskUrl)) throw chartFormatError();
  if (row.revisedOn !== null && (!DATE.test(row.revisedOn) || Number.isNaN(Date.parse(row.revisedOn)))) throw chartFormatError();
  if (row.aliases.length > MAX_ALIASES || row.aliases.some((a) => a.length > MAX_ALIAS_LEN || CONTROL.test(a))) throw chartFormatError();
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
