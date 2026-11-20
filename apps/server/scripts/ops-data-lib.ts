import {
  CONTROL_CHAR,
  checkInput,
  checkItemName,
  DEMO_BOARD_ID_PREFIX,
  EQUIPMENT,
  INVISIBLE_CHARS,
  MASK_NAME,
  type MaskKind,
  NOTICE_TITLE_MAX_LENGTH,
  type OpsSettings,
  PANTRY_ITEM_NAME_MAX,
} from '@one-line-desk/shared';
import type { AuditLog } from '../src/core/audit';
import type { Db, Queryable } from '../src/core/db';
import type { NoticeCopy } from '../src/core/services';
import { parseCsv, readHeader } from '../src/modules/navi/chart-csv';
import { existingNoticeIds } from '../src/modules/notices/repo';
import { catalog, upsertCatalogItem } from '../src/modules/pantry/repo';
import { type RoomImportRow, roomsForImport, upsertRoom } from '../src/modules/rooms/repo';

// 운영자 자료 넣기(11/11 QA Q8). 운영은 가상 자료를 넣지 않아서(DESK_SEED_DEMO 거부) 회의실·탕비실 구매 카탈로그·공지 사본이 빈 채로 떠요.
// 파일럿 전에 운영자가 회사 자료 파일을 미리 보고(쓰기 없음) 반영해요(--apply). 분장표 [미리보기 → 반영]과 같은 순서예요.
// - 반영은 한 번에(회의실·카탈로그는 한 트랜잭션) 하고 감사 로그를 한 줄 남겨요(모듈·ops-import·rows:N). 감사 로그에는 이름·값이 없어요.
// - 지우는 길은 없어요. 파일에 없는 회의실·품목은 "파일에 없어요(그대로 둬요)"로 알려 주기만 해요(예약·요청 카드가 가리켜요).
// - 거절한 줄은 줄 번호와 까닭만 알려 줘요. 칸 값은 되풀이하지 않아요. 내보내는 글은 ID와 이름(공지는 제목)뿐이에요.
// - 공지 본문은 색인 조각·알림 대상 제안에만 쓰고 DB·화면에 내지 않아요(공지 사본 갱신 ingest와 같은 길).

export const OPS_DATA_KINDS = ['rooms', 'catalog', 'notices'] as const;
export type OpsDataKind = (typeof OPS_DATA_KINDS)[number];
export const isOpsDataKind = (value: string | undefined): value is OpsDataKind => (OPS_DATA_KINDS as readonly string[]).includes(value ?? '');

/** 감사 로그 동작 칸 */
export const OPS_IMPORT_ACTION = 'ops-import';
/** 감사 로그의 "누가". mcp-clients와 같은 고정 값이에요. 누가 돌렸는지는 서버 접속 기록(운영 계정)으로 봐요. */
export const CLI_PSEUDONYM = 'cli';
const AUDIT_MODULE = { rooms: 'rooms', catalog: 'pantry', notices: 'notices' } as const satisfies Record<OpsDataKind, string>;

/** 파일 하나 크기 상한 */
export const OPS_FILE_MAX_BYTES = 2_000_000;
const MAX_ROWS: Record<OpsDataKind, number> = { rooms: 500, catalog: 2000, notices: 1000 };

export const ROOM_COLUMNS = ['id', 'name', 'floor', 'capacity', 'equipment', 'facilities'] as const;
export const CATALOG_COLUMNS = ['id', 'name', 'unitPrice', 'packUnit', 'aliases'] as const;
const NOTICE_FIELDS = ['id', 'board', 'title', 'postedOn', 'url', 'body'] as const;

// 회의실: id는 예약 제안(ReserveParamsSchema)과, 층은 찾기 조건(RoomQuerySchema)과, 인원은 찾기 인원 상한(200)과 같은 모양이에요.
const ROOM_ID = /^[a-z0-9-]{1,40}$/;
const FLOOR = /^(\d{1,2})층$/;
const ROOM_NAME_MAX = 40;
const ROOM_CAPACITY_MAX = 200;
const FACILITY_MAX = 40;
const FACILITIES_MAX = 12;
// 카탈로그: id는 요청 카드의 catalogItemId(60자까지)와 같아요. 이름·다른 말은 판 품목 이름 길이(PANTRY_ITEM_NAME_MAX)까지예요.
const CATALOG_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const UNIT_PRICE_MAX = 10_000_000;
const PACK_UNIT_MAX = 10_000;
const ALIASES_MAX = 12;
// 공지: 제목은 공지 카드 길이(NOTICE_TITLE_MAX_LENGTH), 링크는 https 원문 주소예요.
const NOTICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const NOTICE_URL = /^https:\/\/[^\s"'<>]+$/;
const NOTICE_URL_MAX = 500;
const NOTICE_BODY_MAX = 10_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// 글 칸(이름·설비·제목)에는 줄바꿈·탭도 두지 않아요. 공지 본문만 줄바꿈을 받아요.
const LINE_BREAK = /[\t\r\n\u2028\u2029]/;
// INVISIBLE_CHARS는 전역 깃발(g)이라 test()가 자리를 기억해요. 검사용으로 깃발 없이 다시 만들어요.
const INVISIBLE = new RegExp(INVISIBLE_CHARS.source);

/** 파일 전체를 읽을 수 없을 때. 메시지는 화면에 그대로 내도 되는 해요체 한 줄이에요(파일 값 없음). */
export class OpsDataError extends Error {}

export interface RejectedRow {
  /** CSV는 머리 줄을 1로 센 줄 번호(빈 줄은 세지 않아요), 공지는 배열 안 몇 번째인지(1부터)예요. */
  row: number;
  /** 칸 이름과 고칠 점만. 칸 값은 싣지 않아요. */
  reason: string;
}

export type RoomItem = RoomImportRow;

export interface CatalogItem {
  id: string;
  name: string;
  unitPrice: number;
  packUnit: number;
  aliases: string[];
}

export type NoticeItem = NoticeCopy;

interface ItemOf {
  rooms: RoomItem;
  catalog: CatalogItem;
  notices: NoticeItem;
}

export interface ParsedFile<K extends OpsDataKind> {
  kind: K;
  items: ItemOf[K][];
  rejected: RejectedRow[];
  /** 정해진 칸 말고 다른 칸 수. 읽지 않고 버려요(이름이 든 칸일 수 있어서 칸 이름도 내보내지 않아요). */
  ignoredColumns: number;
  /** 머리 줄을 낱말 표로 바꿔 읽은 안내(후보 17). 우리 표에 있는 말만 되풀이해요. 없으면 빠져요. */
  headerNotes?: string[];
}

interface PlanEntry<T> {
  id: string;
  /** 회의실·품목은 이름, 공지는 제목이에요. */
  label: string;
  /** 바뀌는 칸 이름(바뀔 것만) */
  columns: string[];
  value: T;
}

export interface ImportPlan<K extends OpsDataKind = OpsDataKind> {
  kind: K;
  added: PlanEntry<ItemOf[K]>[];
  changed: PlanEntry<ItemOf[K]>[];
  /** 회의실·품목은 값이 같은 것, 공지는 이미 들어간 것(같은 id는 바꾸지 않아요)이에요. */
  unchanged: PlanEntry<ItemOf[K]>[];
  /** DB에는 있고 파일에는 없는 회의실·품목. 지우지 않고 그대로 둬요. 공지는 세지 않아요. */
  notInFile: { id: string; label: string }[];
  rejected: RejectedRow[];
  ignoredColumns: number;
  /** 머리 줄을 바꿔 읽은 안내(후보 17) */
  headerNotes?: string[];
}

// ── 칸 검사 ─────────────────────────────────────────────────────────────────

/**
 * 글 칸 검사. 공통 입력 검사(등급 3·키·건강 정보 잠금)에 걸리거나 가릴 글자(이메일·IP 등)가 있으면 거절해요.
 * 문제가 없으면 null이에요. 돌려주는 까닭에 칸 값은 넣지 않아요.
 */
export function textProblem(value: string, column: string, max: number): string | null {
  if (!value) return `"${column}" 칸은 비울 수 없어요`;
  if (value.length > max) return `"${column}" 칸은 ${max}자까지 써요`;
  if (CONTROL_CHAR.test(value) || INVISIBLE.test(value) || LINE_BREAK.test(value)) return `"${column}" 칸에서 줄바꿈·보이지 않는 특수 글자를 지워 주세요`;
  const check = checkInput(value);
  if (check.locks.length) return `"${column}" 칸: ${[...new Set(check.locks.map((l) => l.message))].join(' · ')}`;
  const masked = (Object.keys(check.masked) as MaskKind[]).filter((k) => check.masked[k] > 0);
  if (masked.length) return `"${column}" 칸에 ${masked.map((k) => MASK_NAME[k]).join('·')}처럼 보이는 글자가 있어요. 지워 주세요`;
  return null;
}

/** 품목 이름·다른 말: 글 칸 검사에 더해 공개 판 품목 이름 검사(전화번호·사람 이름 모양)를 지나요. */
function itemNameProblem(value: string, column: string): string | null {
  const problem = textProblem(value, column, PANTRY_ITEM_NAME_MAX);
  if (problem) return problem;
  const check = checkItemName(value);
  return check.ok ? null : `"${column}" 칸: ${check.message ?? '올릴 수 없는 글자가 있어요'}`;
}

/** ;로 나눈 목록. 앞뒤 공백·빈 칸·겹친 값은 빼요. */
function list(value: string): string[] {
  return [
    ...new Set(
      value
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** 0 이상 정수. 전각 숫자와 세 자리마다 찍은 쉼표("12,000")는 받아요. "1,2"처럼 자리가 틀린 쉼표는 null이에요. */
function whole(value: string): number | null {
  const s = value.normalize('NFKC');
  if (!/^\d{1,9}$/.test(s) && !/^\d{1,3}(?:,\d{3}){1,2}$/.test(s)) return null;
  return Number(s.replaceAll(',', ''));
}

function realDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

interface CsvRow {
  row: number;
  width: number;
  get(column: string): string;
}

/**
 * 머리 줄 낱말 표(후보 17, 11/17): 회사 파일에서 흔한 한국어 머리 줄을 우리 칸에 이어요. 분장표와 같은 읽기(readHeader)예요.
 * 띄어쓰기·대소문자·괄호 안 말 차이도 받아요. 사람 이름 머리 줄("담당자"·"성명"·"이름" 등, D9)은 넣지 않고 버려요.
 * 방 이름은 "회의실명"처럼 방을 가리키는 말만 받아요("이름"만 쓴 칸은 사람 이름일 수 있어서 받지 않아요).
 */
export const ROOM_HEADER_ALIASES: Record<(typeof ROOM_COLUMNS)[number], readonly string[]> = {
  id: ['회의실 ID', '회의실 코드', '방 ID'],
  name: ['회의실명', '회의실 이름', '회의실', '방 이름'],
  floor: ['층', '위치 층'],
  capacity: ['인원', '수용 인원', '정원', '좌석 수'],
  equipment: ['장비', '기자재'],
  facilities: ['설비', '시설', '설비 설명'],
};
export const CATALOG_HEADER_ALIASES: Record<(typeof CATALOG_COLUMNS)[number], readonly string[]> = {
  id: ['품목 ID', '품목 코드', '상품 코드'],
  name: ['품목명', '품명', '상품명', '품목 이름'],
  // "단가(원)"처럼 괄호를 붙인 머리 줄도 "단가"로 읽어요(괄호 안 말은 견주지 않아요).
  unitPrice: ['단가', '가격'],
  packUnit: ['묶음 수', '입수', '포장 단위', '구매 단위'],
  aliases: ['다른 말', '별칭', '검색어'],
};

/** 분장표와 같은 CSV 읽개(RFC 4180)로 읽어요. 머리 줄은 낱말 표(readHeader)로 읽어요. 정해진 칸 말고는 버려요. */
function readCsv<C extends string>(
  text: string,
  kind: 'rooms' | 'catalog',
  columns: readonly C[],
  aliases: Record<C, readonly string[]>,
): { rows: CsvRow[]; width: number; ignoredColumns: number; headerNotes: string[] } {
  const table = parseCsv(text);
  if (!table) throw new OpsDataError('CSV로 읽을 수 없어요. 큰따옴표가 짝이 맞는지 봐 주세요');
  const first = `첫 줄(머리 줄)은 ${columns.join(',')}예요`;
  if (table.length === 0) throw new OpsDataError(`빈 파일이에요. ${first}`);
  const labels = Object.fromEntries(columns.map((c) => [c, c as string])) as Record<C, string>;
  const read = readHeader(table[0]!, labels, aliases, columns);
  if (read.missing.length) throw new OpsDataError(`머리 줄에 ${read.missing.join('·')} 칸이 없어요. ${first}`);
  if (read.duplicate) throw new OpsDataError(`머리 줄에 ${read.duplicate} 칸으로 읽히는 칸이 두 번 있어요`);
  if (table.length - 1 > MAX_ROWS[kind]) throw new OpsDataError(`한 파일에 ${MAX_ROWS[kind]}줄까지 넣어요. 나눠서 넣어 주세요`);
  const index = new Map<string, number>(columns.map((c) => [c, read.columns.indexOf(c)]));
  return {
    width: table[0]!.length,
    ignoredColumns: read.ignored,
    headerNotes: read.notes,
    rows: table.slice(1).map((cells, i) => ({
      row: i + 2,
      width: cells.length,
      get: (column: string) => (cells[index.get(column) ?? -1] ?? '').normalize('NFC').trim(),
    })),
  };
}

/** 줄마다 읽고, 칸 수가 다르거나 같은 id가 또 나오면 거절해요. */
function collect<T extends { id: string }>(rows: CsvRow[], width: number, read: (row: CsvRow) => T | string): { items: T[]; rejected: RejectedRow[] } {
  const items: T[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (r.width !== width) {
      rejected.push({ row: r.row, reason: '칸 수가 머리 줄과 달라요. 쉼표가 든 값은 큰따옴표로 묶어요' });
      continue;
    }
    const out = read(r);
    if (typeof out === 'string') {
      rejected.push({ row: r.row, reason: out });
      continue;
    }
    const before = seen.get(out.id);
    if (before !== undefined) {
      rejected.push({ row: r.row, reason: `같은 id가 ${before}번째 줄에도 있어요` });
      continue;
    }
    seen.set(out.id, r.row);
    items.push(out);
  }
  return { items, rejected };
}

function readRoom(r: CsvRow): RoomItem | string {
  const id = r.get('id');
  if (!ROOM_ID.test(id)) return '"id" 칸은 영문 소문자·숫자·-로 40자까지 써요(예: r-3a)';
  const name = r.get('name');
  const nameProblem = textProblem(name, 'name', ROOM_NAME_MAX);
  if (nameProblem) return nameProblem;
  const floor = FLOOR.exec(r.get('floor').normalize('NFKC').replace(/\s+/g, ''));
  if (!floor || Number(floor[1]) < 1) return '"floor" 칸은 3층처럼 써요';
  const capacity = whole(r.get('capacity'));
  if (capacity === null || capacity < 1 || capacity > ROOM_CAPACITY_MAX) return `"capacity" 칸은 1~${ROOM_CAPACITY_MAX} 사이 숫자예요`;
  const equipment = list(r.get('equipment'));
  if (equipment.some((e) => !(EQUIPMENT as readonly string[]).includes(e))) return `"equipment" 칸에는 ${EQUIPMENT.join('·')}만 써요(;로 나눠요)`;
  const facilities = list(r.get('facilities'));
  if (facilities.length > FACILITIES_MAX) return `"facilities" 칸은 ${FACILITIES_MAX}개까지 써요`;
  for (const f of facilities) {
    const problem = textProblem(f, 'facilities', FACILITY_MAX);
    if (problem) return problem;
  }
  return {
    id,
    name,
    // "03층"·"３층"도 찾기 조건과 같은 "3층"으로 맞춰요.
    floor: `${Number(floor[1])}층`,
    capacity,
    // 장비는 정해진 목록 순서로 둬요. 순서만 다른 파일이 "바뀔 것"으로 잡히지 않아요.
    equipment: EQUIPMENT.filter((e) => equipment.includes(e)),
    facilities,
  };
}

function readCatalogItem(r: CsvRow): CatalogItem | string {
  const id = r.get('id');
  if (!CATALOG_ID.test(id)) return '"id" 칸은 영문 소문자·숫자·-로 60자까지 써요(예: cat-coke)';
  const name = r.get('name');
  const nameProblem = itemNameProblem(name, 'name');
  if (nameProblem) return nameProblem;
  const unitPrice = whole(r.get('unitPrice'));
  if (unitPrice === null || unitPrice < 1 || unitPrice > UNIT_PRICE_MAX)
    return `"unitPrice" 칸은 1~${UNIT_PRICE_MAX.toLocaleString('ko-KR')} 사이 원 단위 숫자예요`;
  const packUnit = whole(r.get('packUnit'));
  if (packUnit === null || packUnit < 1 || packUnit > PACK_UNIT_MAX) return `"packUnit" 칸은 1~${PACK_UNIT_MAX.toLocaleString('ko-KR')} 사이 숫자예요`;
  const aliases = list(r.get('aliases'));
  if (aliases.length > ALIASES_MAX) return `"aliases" 칸은 ${ALIASES_MAX}개까지 써요`;
  for (const a of aliases) {
    const problem = itemNameProblem(a, 'aliases');
    if (problem) return problem;
  }
  return { id, name, unitPrice, packUnit, aliases };
}

export function parseRooms(text: string): ParsedFile<'rooms'> {
  const { rows, width, ignoredColumns, headerNotes } = readCsv(text, 'rooms', ROOM_COLUMNS, ROOM_HEADER_ALIASES);
  return { kind: 'rooms', ...collect(rows, width, readRoom), ignoredColumns, ...(headerNotes.length ? { headerNotes } : {}) };
}

export function parseCatalog(text: string): ParsedFile<'catalog'> {
  const { rows, width, ignoredColumns, headerNotes } = readCsv(text, 'catalog', CATALOG_COLUMNS, CATALOG_HEADER_ALIASES);
  return { kind: 'catalog', ...collect(rows, width, readCatalogItem), ignoredColumns, ...(headerNotes.length ? { headerNotes } : {}) };
}

// ── 공지 JSON ───────────────────────────────────────────────────────────────

function readNotice(raw: unknown, boards: readonly string[]): NoticeItem | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '공지 하나는 { } 묶음이에요';
  const value = raw as Record<string, unknown>;
  for (const field of NOTICE_FIELDS) if (typeof value[field] !== 'string') return `"${field}" 칸이 없거나 글자가 아니에요`;
  const get = (field: (typeof NOTICE_FIELDS)[number]) => (value[field] as string).normalize('NFC').trim();
  const id = get('id');
  if (!NOTICE_ID.test(id)) return '"id" 칸은 영문·숫자·_·.·-로 64자까지 써요(예: N-1001)';
  // 시연 가상 게시판 글은 이 앞머리로 가려서 7일 뒤 지워요(공지 모듈 retention). 회사 공지에는 쓰지 않아요.
  if (id.startsWith(DEMO_BOARD_ID_PREFIX)) return `"id" 칸은 시연 게시판 글 앞머리(${DEMO_BOARD_ID_PREFIX})로 시작하지 않게 써요`;
  const board = get('board');
  if (!boards.includes(board)) return `"board" 칸은 허용 게시판(${boards.join('·')})만 받아요`;
  const title = get('title');
  const titleProblem = textProblem(title, 'title', NOTICE_TITLE_MAX_LENGTH);
  if (titleProblem) return titleProblem;
  const postedOn = get('postedOn');
  if (!realDate(postedOn)) return '"postedOn" 칸은 2026-11-11처럼 써요';
  const url = get('url');
  if (url.length > NOTICE_URL_MAX || !NOTICE_URL.test(url) || !URL.canParse(url))
    return `"url" 칸은 https://로 시작하는 원문 링크예요(${NOTICE_URL_MAX}자까지)`;
  const body = get('body');
  if (!body) return '"body" 칸은 비울 수 없어요';
  if (body.length > NOTICE_BODY_MAX) return `"body" 칸은 ${NOTICE_BODY_MAX.toLocaleString('ko-KR')}자까지 써요`;
  if (CONTROL_CHAR.test(body)) return '"body" 칸에서 보이지 않는 특수 글자를 지워 주세요';
  // 시연 게시판과 같은 공통 입력 검사예요: 잠기는 글자가 있으면 거절하고, 이메일·IP 같은 글자는 가린 글로 넘겨요.
  const check = checkInput(body);
  if (check.locks.length) return `"body" 칸: ${[...new Set(check.locks.map((l) => l.message))].join(' · ')}`;
  return { id, board, title, postedOn, url, body: check.text };
}

/** 공지 사본 파일: [{ id, board, title, postedOn, url, body }, …]. 허용 게시판(boards)이 아니면 거절해요. */
export function parseNotices(text: string, boards: readonly string[]): ParsedFile<'notices'> {
  let data: unknown;
  try {
    data = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
  } catch {
    // JSON 오류 문구에는 파일 글 조각이 섞여서 그대로 내지 않아요.
    throw new OpsDataError('JSON으로 읽을 수 없어요. [ { … }, { … } ] 모양인지 봐 주세요');
  }
  if (!Array.isArray(data)) throw new OpsDataError('파일은 공지 묶음의 배열([ { … }, { … } ])이어야 해요');
  if (data.length > MAX_ROWS.notices) throw new OpsDataError(`한 파일에 공지 ${MAX_ROWS.notices}건까지 넣어요. 나눠서 넣어 주세요`);
  const items: NoticeItem[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Map<string, number>();
  const extra = new Set<string>();
  for (const [i, raw] of data.entries()) {
    const row = i + 1;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const key of Object.keys(raw)) if (!(NOTICE_FIELDS as readonly string[]).includes(key)) extra.add(key);
    }
    const out = readNotice(raw, boards);
    if (typeof out === 'string') {
      rejected.push({ row, reason: out });
      continue;
    }
    const before = seen.get(out.id);
    if (before !== undefined) {
      rejected.push({ row, reason: `같은 id가 ${before}번째 공지에도 있어요` });
      continue;
    }
    seen.set(out.id, row);
    items.push(out);
  }
  return { kind: 'notices', items, rejected, ignoredColumns: extra.size };
}

export function parseFile(kind: OpsDataKind, text: string, boards: readonly string[]): ParsedFile<OpsDataKind> {
  if (kind === 'rooms') return parseRooms(text);
  if (kind === 'catalog') return parseCatalog(text);
  return parseNotices(text, boards);
}

// ── 비교(미리보기) ───────────────────────────────────────────────────────────

/** 파일과 DB를 id로 맞대요. 칸 값이 하나라도 다르면 "바뀔 것"이고, 바뀌는 칸 이름을 같이 줘요. */
export function diffById<T extends { id: string }>(
  file: readonly T[],
  current: readonly T[],
  columns: readonly (keyof T & string)[],
  label: (item: T) => string,
): Pick<ImportPlan, 'notInFile'> & { added: PlanEntry<T>[]; changed: PlanEntry<T>[]; unchanged: PlanEntry<T>[] } {
  const now = new Map(current.map((c) => [c.id, c]));
  const added: PlanEntry<T>[] = [];
  const changed: PlanEntry<T>[] = [];
  const unchanged: PlanEntry<T>[] = [];
  for (const item of file) {
    const before = now.get(item.id);
    const entry = { id: item.id, label: label(item), value: item };
    if (!before) {
      added.push({ ...entry, columns: [] });
      continue;
    }
    const columnsChanged = columns.filter((c) => JSON.stringify(before[c]) !== JSON.stringify(item[c]));
    (columnsChanged.length ? changed : unchanged).push({ ...entry, columns: columnsChanged });
  }
  const inFile = new Set(file.map((f) => f.id));
  const notInFile = current.filter((c) => !inFile.has(c.id)).map((c) => ({ id: c.id, label: label(c) }));
  return { added, changed, unchanged, notInFile };
}

const ROOM_DIFF: (keyof RoomItem & string)[] = ['name', 'floor', 'capacity', 'equipment', 'facilities'];
const CATALOG_DIFF: (keyof CatalogItem & string)[] = ['name', 'unitPrice', 'packUnit', 'aliases'];

export async function planRooms(q: Queryable, parsed: ParsedFile<'rooms'>): Promise<ImportPlan<'rooms'>> {
  const diff = diffById(parsed.items, await roomsForImport(q), ROOM_DIFF, (r) => r.name);
  return { kind: 'rooms', ...diff, rejected: parsed.rejected, ignoredColumns: parsed.ignoredColumns, ...notesOf(parsed) };
}

export async function planCatalog(q: Queryable, parsed: ParsedFile<'catalog'>): Promise<ImportPlan<'catalog'>> {
  const diff = diffById(parsed.items, await catalog(q), CATALOG_DIFF, (c) => c.name);
  return { kind: 'catalog', ...diff, rejected: parsed.rejected, ignoredColumns: parsed.ignoredColumns, ...notesOf(parsed) };
}

const notesOf = (parsed: ParsedFile<OpsDataKind>): { headerNotes?: string[] } => (parsed.headerNotes?.length ? { headerNotes: parsed.headerNotes } : {});

/** 공지는 새것과 이미 들어간 것만 나눠요. 이미 있는 id는 사본 갱신이 바꾸지 않아요. 읽기만 해요(id 칸만). */
export async function planNotices(q: Queryable, parsed: ParsedFile<'notices'>): Promise<ImportPlan<'notices'>> {
  const present = await existingNoticeIds(
    q,
    parsed.items.map((n) => n.id),
  );
  const entry = (n: NoticeItem): PlanEntry<NoticeItem> => ({ id: n.id, label: n.title, columns: [], value: n });
  return {
    kind: 'notices',
    added: parsed.items.filter((n) => !present.has(n.id)).map(entry),
    changed: [],
    unchanged: parsed.items.filter((n) => present.has(n.id)).map(entry),
    notInFile: [],
    rejected: parsed.rejected,
    ignoredColumns: parsed.ignoredColumns,
  };
}

export async function planFile(q: Queryable, parsed: ParsedFile<OpsDataKind>): Promise<ImportPlan> {
  if (parsed.kind === 'rooms') return planRooms(q, parsed as ParsedFile<'rooms'>);
  if (parsed.kind === 'catalog') return planCatalog(q, parsed as ParsedFile<'catalog'>);
  return planNotices(q, parsed as ParsedFile<'notices'>);
}

// ── 반영 ─────────────────────────────────────────────────────────────────────

export interface OpsDataDeps {
  db: Db;
  audit: AuditLog;
  /** 공지만: 공지 사본 갱신(ctx.services.notices.ingest). 새 공지면 색인에 넣고 알림 대상을 제안해요. */
  ingest?: (notice: NoticeCopy) => Promise<{ copied: boolean }>;
}

export interface ApplyResult {
  plan: ImportPlan;
  /** 새로 넣거나 고친 수. 감사 로그 결과 칸(rows:N)과 같아요. */
  written: number;
}

const auditLine = (kind: OpsDataKind, written: number) => ({
  pseudonymId: CLI_PSEUDONYM,
  channel: 'write' as const,
  module: AUDIT_MODULE[kind],
  action: OPS_IMPORT_ACTION,
  result: `rows:${written}`,
});

function assertClean(parsed: ParsedFile<OpsDataKind>): void {
  if (parsed.rejected.length) throw new OpsDataError(`거절한 줄이 ${parsed.rejected.length}개 있어서 반영하지 않았어요. 고친 뒤 다시 미리 봐 주세요`);
}

/**
 * 회의실·카탈로그: 한 트랜잭션 안에서 다시 맞대 보고(미리보기 뒤 바뀐 것까지) 새것·바뀐 것만 넣고, 감사 로그를 한 줄 남겨요.
 * 공지: 새 공지마다 사본 갱신(ingest)을 불러요. ingest가 공지마다 따로 트랜잭션을 열고 AI(알림 대상 제안)를 트랜잭션 밖에서 불러서
 * 한 트랜잭션으로 묶지 못해요. 감사 로그는 끝에(도중에 멈춰도) 들어간 수로 한 줄 남겨요.
 */
export async function applyFile(deps: OpsDataDeps, parsed: ParsedFile<OpsDataKind>): Promise<ApplyResult> {
  assertClean(parsed);
  if (parsed.kind === 'notices') return applyNotices(deps, parsed as ParsedFile<'notices'>);
  return deps.db.tx(async (q) => {
    let plan: ImportPlan;
    if (parsed.kind === 'rooms') {
      const rooms = await planRooms(q, parsed as ParsedFile<'rooms'>);
      for (const r of [...rooms.added, ...rooms.changed]) await upsertRoom(q, r.value);
      plan = rooms;
    } else {
      const items = await planCatalog(q, parsed as ParsedFile<'catalog'>);
      for (const c of [...items.added, ...items.changed]) await upsertCatalogItem(q, c.value);
      plan = items;
    }
    const written = plan.added.length + plan.changed.length;
    await deps.audit.record(auditLine(parsed.kind, written), q);
    return { plan, written };
  });
}

async function applyNotices(deps: OpsDataDeps, parsed: ParsedFile<'notices'>): Promise<ApplyResult> {
  const ingest = deps.ingest;
  if (!ingest) throw new OpsDataError('공지 모듈을 찾지 못했어요');
  const plan = await planNotices(deps.db, parsed);
  let written = 0;
  try {
    for (const n of plan.added) if ((await ingest(n.value)).copied) written += 1;
  } finally {
    await deps.audit.record(auditLine('notices', written));
  }
  return { plan, written };
}

/**
 * 공지 반영 전에 지금 스위치를 알려 줘요. 자동 보내기가 켜져 있으면 반영을 막아요(blocked):
 * 지난 공지를 한꺼번에 넣으면 공지마다 대상자 모두에게 확인 없이 알림이 가요.
 */
export function noticeSwitchNote(settings: Pick<OpsSettings, 'modules' | 'noticeAutoSend'>): { line: string; blocked: boolean } {
  if (settings.modules.notices !== 'on') return { line: '공지 기능이 켬이 아니에요. 반영하면 사본만 들어가고 알림 대상 제안은 생기지 않아요', blocked: false };
  if (settings.noticeAutoSend)
    return {
      line: '새 공지 알림 자동 보내기가 켜져 있어요. 반영하면 공지마다 확인 없이 알림이 갈 수 있어서 반영하지 않아요. 운영 설정에서 끈 뒤 다시 돌려 주세요',
      blocked: true,
    };
  return { line: '반영하면 새 공지마다 알림 대상 제안이 생기고 총무에게 확인 알림이 가요', blocked: false };
}

// ── 출력 ─────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<OpsDataKind, string> = { rooms: '회의실', catalog: '탕비실 구매 카탈로그', notices: '공지 사본' };
const COUNTER: Record<OpsDataKind, string> = { rooms: '개', catalog: '개', notices: '건' };
const ROW_UNIT: Record<OpsDataKind, string> = { rooms: '줄', catalog: '줄', notices: '공지' };
/** 목록은 이만큼만 보여 주고 나머지는 수로 줄여요. */
const LIST_MAX = 50;

function listLines(mark: string, entries: readonly { id: string; label: string; columns?: string[] }[]): string[] {
  const lines = entries.slice(0, LIST_MAX).map((e) => `    ${mark} ${e.id}  ${e.label}${e.columns?.length ? ` (${e.columns.join(', ')})` : ''}`);
  if (entries.length > LIST_MAX) lines.push(`    … 그 밖에 ${entries.length - LIST_MAX}개`);
  return lines;
}

/** 미리보기 출력. ID·이름(공지는 제목)·칸 이름·줄 번호·까닭만 내보내요. 본문·칸 값은 없어요. */
export function formatPlan(plan: ImportPlan): string[] {
  const n = (count: number) => `${count}${COUNTER[plan.kind]}`;
  const unit = ROW_UNIT[plan.kind];
  const lines = [`${KIND_LABEL[plan.kind]} 파일을 미리 봤어요(아직 쓰지 않았어요)`];
  // 머리 줄을 바꿔 읽었으면 먼저 알려요(후보 17). 맞는지 보고 --apply를 붙여요.
  for (const note of plan.headerNotes ?? []) lines.push(`  ${note}`);
  if (plan.kind === 'notices') {
    lines.push(`  새 공지 ${n(plan.added.length)}`, ...listLines('+', plan.added));
    lines.push(`  이미 있는 공지 ${n(plan.unchanged.length)}(바꾸지 않아요)`);
  } else {
    lines.push(`  새로 넣을 것 ${n(plan.added.length)}`, ...listLines('+', plan.added));
    lines.push(`  바뀔 것 ${n(plan.changed.length)}`, ...listLines('~', plan.changed));
    lines.push(`  그대로인 것 ${n(plan.unchanged.length)}`);
  }
  lines.push(`  거절한 ${unit} ${plan.rejected.length}개`);
  for (const r of plan.rejected.slice(0, LIST_MAX)) lines.push(`    ✗ ${r.row}번째 ${unit}: ${r.reason}`);
  if (plan.rejected.length > LIST_MAX) lines.push(`    … 그 밖에 ${plan.rejected.length - LIST_MAX}개`);
  if (plan.notInFile.length) {
    lines.push(`  파일에 없는 ${KIND_LABEL[plan.kind]} ${n(plan.notInFile.length)}(지우지 않고 그대로 둬요)`, ...listLines('·', plan.notInFile));
  }
  if (plan.ignoredColumns) lines.push(`  정해진 칸 말고 다른 칸 ${plan.ignoredColumns}개는 읽지 않고 버렸어요`);
  return lines;
}
