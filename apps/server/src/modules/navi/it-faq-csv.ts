import { checkInput, IT_FAQ_COLUMNS, IT_FAQ_LIST_SEPARATOR, type ItFaqColumn, NAVI_ROW_ID_PATTERN } from '@one-line-desk/shared';
import { DeskError } from '../../core/errors';
import { parseCsv } from './chart-csv';
import type { ItFaqRow } from './repo';

// IT FAQ 파일 가져오기(11/3). 분장표 파일(chart-csv.ts)과 같은 방식이에요.
// - 정해진 칸(ID·제목·다른 말·오류 코드·단계·개정일·문의 행)만 읽고 나머지 칸("작성자" 같은 사람 이름 칸)은 버려요.
// - 단계는 칸 안 줄바꿈으로 나누고, 글은 고치지 않고 그대로 저장해요(ADR-09 근거 규칙: 원문 그대로 보여 줘요).
// - 키·비밀번호·주민번호처럼 공통 입력 검사가 잠그는 글은 받지 않아요. 기준 자료라도 누구나 보는 화면에 나가서요.

export type ItFaqFileRow = Omit<ItFaqRow, 'revisedOn'> & { revisedOn: string | null };

export const IT_FAQ_FORMAT_MESSAGE = 'IT FAQ 양식으로 올려 주세요';
/** 행·칸을 알면 어디를 고칠지 덧붙여요. 칸 값은 싣지 않아요. */
export const itFaqFormatError = (where?: string) => new DeskError('faq-format', 422, where ? `${IT_FAQ_FORMAT_MESSAGE}. ${where}` : IT_FAQ_FORMAT_MESSAGE);
const cellError = (label: string, col: ItFaqColumn, rule: string) => itFaqFormatError(`${label} "${IT_FAQ_COLUMNS[col]}" 칸은 ${rule}`);

const REQUIRED: ItFaqColumn[] = ['id', 'title', 'steps', 'rowId'];
const MAX_ROWS = 300;
const FAQ_ID = /^ITF-[0-9]{2,3}$/;
const ROW_ID = new RegExp(NAVI_ROW_ID_PATTERN);
const TITLE_MAX = 80;
const MAX_STEPS = 12;
const STEP_MAX = 300;
const MAX_ALIASES = 12;
const ALIAS_MAX = 30;
const MAX_CODES = 8;
const ERROR_CODE = /^[0-9A-Za-z]{3,16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const squash = (s: string) => s.normalize('NFC').replace(/\s+/g, '');
const HEADER_TO_COLUMN = new Map<string, ItFaqColumn>(Object.entries(IT_FAQ_COLUMNS).map(([key, label]) => [squash(label), key as ItFaqColumn]));

const list = (value: string, sep: string | RegExp) => [
  ...new Set(
    value
      .split(sep)
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];

/** IT FAQ CSV를 행으로 바꿔요. 양식이 아니면 "IT FAQ 양식으로 올려 주세요"로 거부해요. */
export function parseItFaqFile(text: string): ItFaqFileRow[] {
  const table = parseCsv(text);
  if (!table || table.length < 2) throw itFaqFormatError();
  const header = table[0]!.map((h) => HEADER_TO_COLUMN.get(squash(h)));
  for (const col of REQUIRED) if (!header.includes(col)) throw itFaqFormatError();
  if (new Set(header.filter(Boolean)).size !== header.filter(Boolean).length) throw itFaqFormatError();
  if (table.length - 1 > MAX_ROWS) throw itFaqFormatError();

  const seen = new Set<string>();
  const rows: ItFaqFileRow[] = [];
  for (const [i, cells] of table.slice(1).entries()) {
    const raw = (col: ItFaqColumn) => {
      const at = header.indexOf(col);
      // 내보낼 때 수식 막기로 붙인 '를 다시 떼요(toItFaqCsv).
      return at < 0
        ? ''
        : (cells[at] ?? '')
            .normalize('NFC')
            .trim()
            .replace(/^'(?=[=+\-@])/, '');
    };
    const id = raw('id');
    const label = FAQ_ID.test(id) ? `${id} 행` : `${i + 2}번째 줄`;
    const row: ItFaqFileRow = {
      id,
      title: raw('title'),
      aliases: list(raw('aliases'), IT_FAQ_LIST_SEPARATOR),
      errorCodes: list(raw('errorCodes'), IT_FAQ_LIST_SEPARATOR),
      // 단계 순서가 뜻이라 같은 글이 두 번 있어도 그대로 둬요. 빈 줄만 빼요. 수식 막기 '는 줄마다 떼요.
      steps: raw('steps')
        .split(/\r\n|\r|\n/)
        .map((s) => s.trim().replace(/^'(?=[=+\-@])/, ''))
        .filter(Boolean),
      revisedOn: raw('revisedOn') || null,
      rowId: raw('rowId') || null,
    };
    validate(row, label);
    if (seen.has(row.id)) throw itFaqFormatError(`${row.id} 행이 두 번 있어요`);
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

function validate(row: ItFaqFileRow, label: string): void {
  if (!FAQ_ID.test(row.id)) throw cellError(label, 'id', 'ITF-07처럼 써요');
  if (!row.title) throw cellError(label, 'title', '비울 수 없어요');
  if (row.title.length > TITLE_MAX) throw cellError(label, 'title', `${TITLE_MAX}자까지 써요`);
  if (row.steps.length === 0) throw cellError(label, 'steps', '비울 수 없어요');
  if (row.steps.length > MAX_STEPS) throw cellError(label, 'steps', `${MAX_STEPS}줄까지 써요`);
  if (row.steps.some((s) => s.length > STEP_MAX)) throw cellError(label, 'steps', `한 줄에 ${STEP_MAX}자까지 써요`);
  if (!row.rowId) throw cellError(label, 'rowId', '비울 수 없어요');
  if (!ROW_ID.test(row.rowId)) throw cellError(label, 'rowId', '분장표 행 ID(IT-06처럼)를 써요');
  if (row.aliases.length > MAX_ALIASES) throw cellError(label, 'aliases', `${MAX_ALIASES}개까지 써요`);
  if (row.aliases.some((a) => a.length > ALIAS_MAX)) throw cellError(label, 'aliases', `낱말마다 ${ALIAS_MAX}자까지 써요`);
  if (row.errorCodes.length > MAX_CODES) throw cellError(label, 'errorCodes', `${MAX_CODES}개까지 써요`);
  if (row.errorCodes.some((c) => !ERROR_CODE.test(c))) throw cellError(label, 'errorCodes', '0x80070005·AADSTS50126처럼 영문·숫자로 써요');
  if (row.revisedOn !== null && (!DATE.test(row.revisedOn) || Number.isNaN(Date.parse(row.revisedOn))))
    throw cellError(label, 'revisedOn', '2026-10-31처럼 써요');
  const texts: [ItFaqColumn, string][] = [
    ['title', row.title],
    ...row.aliases.map((a): [ItFaqColumn, string] => ['aliases', a]),
    ...row.steps.map((s): [ItFaqColumn, string] => ['steps', s]),
  ];
  for (const [col, text] of texts) {
    if (CONTROL.test(text)) throw cellError(label, col, '보이지 않는 특수 글자를 지워 주세요');
    // 키·비밀번호·주민번호 같은 글은 FAQ에도 두지 않아요(누구나 보는 화면이에요). 무엇이 걸렸는지만 알려요.
    const locks = checkInput(text).locks;
    if (locks.length) throw cellError(label, col, `넣을 수 없는 글이 있어요(${locks[0]!.message})`);
  }
}

/** 우리 부서 IT FAQ를 다시 CSV로 내보내요(파일 받기). 사람 이름 칸은 없어요. 단계는 칸 안 줄바꿈이에요. */
export function toItFaqCsv(rows: ItFaqRow[]): string {
  const cols = Object.keys(IT_FAQ_COLUMNS) as ItFaqColumn[];
  const guard = (raw: string) => (/^[=+\-@]/.test(raw) ? `'${raw}` : raw);
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const value = (row: ItFaqRow, c: ItFaqColumn): string => {
    switch (c) {
      case 'aliases':
      case 'errorCodes':
        return guard(row[c].join(IT_FAQ_LIST_SEPARATOR));
      case 'steps':
        return row.steps.map(guard).join('\n');
      case 'rowId':
        return row.rowId ?? '';
      default:
        return guard(row[c]);
    }
  };
  const line = (row: ItFaqRow) => cols.map((c) => cell(value(row, c))).join(',');
  return `﻿${cols.map((c) => IT_FAQ_COLUMNS[c]).join(',')}\r\n${rows.map(line).join('\r\n')}\r\n`;
}
