import { afterEach, describe, expect, it } from 'vitest';
import type { Queryable } from '../src/core/db';
import { ALLOWED_BOARDS } from '../src/modules/notices/fixtures';
import { insertCatalogItem } from '../src/modules/pantry/repo';
import { insertLedger } from '../src/modules/rooms/repo';
import { createTestApp } from '../src/testing';
import {
  applyFile,
  formatPlan,
  noticeSwitchNote,
  OPS_IMPORT_ACTION,
  OpsDataError,
  type OpsDataDeps,
  parseCatalog,
  parseNotices,
  parseRooms,
  planFile,
} from './ops-data-lib';

// 운영자 자료 넣기(11/11 QA Q8): 운영은 가상 자료를 넣지 않아서 회의실·카탈로그·공지 사본을 운영자가 파일로 넣어요.
// 미리보기는 쓰지 않고, 반영은 한 번에 하고 감사 로그 한 줄(내용 없음)이에요. 지우는 길은 없어요. 공지 본문은 DB에 남지 않아요.
// 자료는 모두 가상이에요(등급 0).

const ROOMS_HEADER = 'id,name,floor,capacity,equipment,facilities';
const CATALOG_HEADER = 'id,name,unitPrice,packUnit,aliases';
const BODY_CANARY = '본문카나리-OPS8';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function app(): Promise<TestApp> {
  t = await createTestApp();
  return t;
}

const deps = (a: TestApp): OpsDataDeps => ({ db: a.db, audit: a.ctx.audit, ingest: a.ctx.services.notices?.ingest });

/** 지금 스키마의 표마다 줄 수 */
async function tableCounts(q: Queryable): Promise<Record<string, number>> {
  const { rows: tables } = await q.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' order by table_name",
  );
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    const { rows } = await q.query<{ n: number }>(`select count(*)::int as n from "${table_name}"`);
    out[table_name] = rows[0]!.n;
  }
  return out;
}

async function everyRow(q: Queryable): Promise<string> {
  const { rows: tables } = await q.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'",
  );
  const parts: string[] = [];
  for (const { table_name } of tables) parts.push(JSON.stringify((await q.query(`select * from "${table_name}"`)).rows));
  return parts.join('\n');
}

async function importAudits(q: Queryable) {
  const { rows } = await q.query<Record<string, unknown>>('select * from audit_log where action = $1 order by id', [OPS_IMPORT_ACTION]);
  return rows;
}

const notice = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'N-2001',
  board: '전사 공지',
  title: '사내 식당 저녁 운영 시간 변경 안내',
  postedOn: '2026-11-10',
  url: 'https://groupware.example.com/board/notice/2001',
  body: `사내 식당은 11월 17일부터 저녁 운영을 쉬어요. 점심은 그대로예요. ${BODY_CANARY}`,
  ...over,
});

describe('운영자 자료 넣기 — 파일 검사(Q8)', () => {
  it('[Q8] 회의실 CSV에서 틀린 줄은 줄 번호와 까닭으로 거절하고, 까닭에 칸 값을 싣지 않아요', () => {
    const csv = [
      ROOMS_HEADER,
      'r-3a,회의실 3A,3층,6,화이트보드;화면,TV 모니터 55인치;창문',
      'R 3B,회의실 3B,3층,6,,',
      'r-3c,회의실 3C,지하창고,6,,',
      'r-3d,회의실 3D,3층,0,,',
      'r-3e,회의실 3E,3층,4,빔프로젝터,',
      'r-3f,문의 room-admin@example.com,3층,4,,',
      'r-3a,회의실 3A 또,3층,4,,',
      'r-3g,회의실 3G,3층,4',
      'r-3h,"회의실 3H, 큰 방",３층,"1,2",화상회의,',
    ].join('\r\n');
    const parsed = parseRooms(csv);
    expect(parsed.items.map((r) => r.id)).toEqual(['r-3a']);
    // 장비는 정해진 목록 순서로 맞춰요.
    expect(parsed.items[0]).toEqual({
      id: 'r-3a',
      name: '회의실 3A',
      floor: '3층',
      capacity: 6,
      equipment: ['화면', '화이트보드'],
      facilities: ['TV 모니터 55인치', '창문'],
    });
    expect(parsed.rejected.map((r) => r.row)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    const reasons = parsed.rejected.map((r) => r.reason).join('\n');
    expect(reasons).toContain('"floor" 칸은 3층처럼 써요');
    expect(reasons).toContain('같은 id가 2번째 줄에도 있어요');
    expect(reasons).toContain('칸 수가 머리 줄과 달라요');
    for (const value of ['R 3B', '지하창고', '빔프로젝터', 'room-admin@example.com', '회의실 3A 또', '큰 방']) expect(reasons).not.toContain(value);
  });

  it('[Q8] 회의실 층은 찾기 조건과 같은 "3층" 모양으로 맞춰요', () => {
    const parsed = parseRooms([ROOMS_HEADER, 'r-12a,회의실 12A,０３층,8,,', 'r-7a,회의실 7A, 7 층 ,8,,'].join('\n'));
    expect(parsed.rejected).toEqual([]);
    expect(parsed.items.map((r) => r.floor)).toEqual(['3층', '7층']);
  });

  it('[Q8] 머리 줄에 정해진 칸이 없거나 CSV가 깨지면 파일째 멈춰요. 다른 칸은 읽지 않고 수만 세요', () => {
    expect(() => parseRooms('id,name,floor\nr-1,회의실 1,1층')).toThrow(OpsDataError);
    expect(() => parseRooms(`${ROOMS_HEADER}\nr-1,"회의실 1,1층,4,,`)).toThrow('CSV로 읽을 수 없어요');
    const parsed = parseRooms(`${ROOMS_HEADER},담당자 이름\nr-1,회의실 1,1층,4,,,가상 직원 하늘`);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.ignoredColumns).toBe(1);
    expect(JSON.stringify(parsed.items)).not.toContain('하늘');
  });

  it('[Q8] 카탈로그는 단가·묶음 수·품목 이름 검사(전화번호·사람 이름 모양)를 지나야 들어가요', () => {
    const csv = [
      CATALOG_HEADER,
      'cat-green-tea,녹차 티백 100개입,9000,1,녹차;녹차티백;녹차',
      'cat-paper-cup,종이컵 1000개입,"12,000",1,',
      'cat-x,김가상 대리 간식,1000,1,',
      'cat-y,간식 010-1234-5678,1000,1,',
      'cat-z,초코바,0,1,',
      `cat-w,초코바,1000,1,${'초'.repeat(41)}`,
      'Cat_Bad,초코바,1000,1,',
    ].join('\n');
    const parsed = parseCatalog(csv);
    expect(parsed.items).toEqual([
      { id: 'cat-green-tea', name: '녹차 티백 100개입', unitPrice: 9000, packUnit: 1, aliases: ['녹차', '녹차티백'] },
      { id: 'cat-paper-cup', name: '종이컵 1000개입', unitPrice: 12000, packUnit: 1, aliases: [] },
    ]);
    expect(parsed.rejected.map((r) => r.row)).toEqual([4, 5, 6, 7, 8]);
    const reasons = parsed.rejected.map((r) => r.reason).join('\n');
    expect(reasons).toContain('[사람 이름]');
    expect(reasons).toContain('[전화번호]');
    for (const value of ['김가상', '010-1234-5678', 'Cat_Bad']) expect(reasons).not.toContain(value);
  });

  it('[Q8] 허용 게시판이 아닌 공지·https가 아닌 링크·시연 글 앞머리·없는 날짜·잠기는 본문은 거절해요', () => {
    const file = [
      notice(),
      notice({ id: 'N-2002', board: '인사 발령', title: '인사 발령 안내' }),
      notice({ id: 'N-2003', url: 'http://groupware.example.com/board/notice/2003' }),
      notice({ id: 'GB-1a2b3c4d' }),
      notice({ id: 'N-2005', postedOn: '2026-02-30' }),
      notice({ id: 'N-2006', body: '주민번호 900101-1234567 을 적어 주세요' }),
      notice({ id: 'N-2007', title: '' }),
      notice({ id: 'N-2001', title: '같은 공지 또' }),
      'not an object',
    ];
    const parsed = parseNotices(JSON.stringify(file), ALLOWED_BOARDS);
    expect(parsed.items.map((n) => n.id)).toEqual(['N-2001']);
    expect(parsed.rejected.map((r) => r.row)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(parsed.rejected[0]!.reason).toBe(`"board" 칸은 허용 게시판(${ALLOWED_BOARDS.join('·')})만 받아요`);
    const reasons = parsed.rejected.map((r) => r.reason).join('\n');
    for (const value of ['인사 발령', '900101-1234567', BODY_CANARY, 'http://']) expect(reasons).not.toContain(value);
  });

  it('[Q8] 공지 본문의 이메일은 가린 글로 넘기고, 깨진 JSON 오류에 파일 글을 싣지 않아요', () => {
    const parsed = parseNotices(JSON.stringify([notice({ body: '문의는 desk-help@example.com 으로 보내 주세요' })]), ALLOWED_BOARDS);
    expect(parsed.items[0]!.body).not.toContain('desk-help@example.com');
    expect(parsed.items[0]!.body).toContain('[이메일]');
    try {
      parseNotices(`[{"id": "N-1", "body": "${BODY_CANARY}"`, ALLOWED_BOARDS);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OpsDataError);
      expect((e as Error).message).not.toContain(BODY_CANARY);
    }
  });

  it('[Q8] 새 공지 알림 자동 보내기가 켜져 있으면 공지 반영을 막아요(지난 공지마다 확인 없이 알림이 가요)', () => {
    const on = { navi: 'on', notices: 'on', rooms: 'on', pantry: 'on', cafeteria: 'off' } as const;
    expect(noticeSwitchNote({ modules: on, noticeAutoSend: true }).blocked).toBe(true);
    expect(noticeSwitchNote({ modules: on, noticeAutoSend: false })).toEqual({ line: expect.stringContaining('총무에게 확인 알림'), blocked: false });
    expect(noticeSwitchNote({ modules: { ...on, notices: 'off' }, noticeAutoSend: true }).blocked).toBe(false);
  });
});

describe('운영자 자료 넣기 — 머리 줄 낱말 표(후보 17, 11/17)', () => {
  it('[후보 17] 회의실·카탈로그 파일의 한국어 머리 줄(회의실명·층·인원, 품목명·단가·입수)을 우리 칸으로 읽고 미리보기 맨 위에 알려요', async () => {
    const rooms = parseRooms(['회의실 ID,회의실명,층,수용 인원,장비,설비', 'r-3a,회의실 3A,3층,6,화면,창문'].join('\n'));
    expect(rooms.rejected).toEqual([]);
    expect(rooms.items).toEqual([{ id: 'r-3a', name: '회의실 3A', floor: '3층', capacity: 6, equipment: ['화면'], facilities: ['창문'] }]);
    expect(rooms.headerNotes).toContain("'회의실명' 칸을 'name' 칸으로 읽었어요");
    expect(rooms.headerNotes).toContain("'회의실 ID' 칸을 'id'로 읽었어요");

    const items = parseCatalog(['품목 코드,품목명,단가(원),입수,별칭', 'cat-tea,녹차 티백,"9,000",1,녹차'].join('\n'));
    expect(items.items).toEqual([{ id: 'cat-tea', name: '녹차 티백', unitPrice: 9000, packUnit: 1, aliases: ['녹차'] }]);
    expect(items.headerNotes).toEqual([
      "'품목 코드' 칸을 'id'로 읽었어요",
      "'품목명' 칸을 'name' 칸으로 읽었어요",
      "'단가' 칸을 'unitPrice' 칸으로 읽었어요",
      "'입수' 칸을 'packUnit' 칸으로 읽었어요",
      "'별칭' 칸을 'aliases' 칸으로 읽었어요",
    ]);
    const a = await app();
    const lines = formatPlan(await planFile(a.db, items));
    expect(lines[1]).toBe("  '품목 코드' 칸을 'id'로 읽었어요");
    // 우리 양식 그대로면 안내가 없어요.
    expect(parseRooms(`${ROOMS_HEADER}\nr-1,회의실 1,1층,4,,`).headerNotes).toBeUndefined();
  });

  it('[후보 17][D9] 사람 이름 머리 줄(담당자·성명·이름)은 읽지 않고 버려요. "이름"만 쓴 칸은 방 이름으로 읽지 않아요', () => {
    const parsed = parseRooms(
      ['회의실명,id,floor,capacity,equipment,facilities,담당자,성명,이름', 'r 1 방,r-1,1층,4,,,가상담당카나리,가상성명카나리,가상이름카나리'].join('\n'),
    );
    expect(parsed.items.map((r) => r.name)).toEqual(['r 1 방']);
    expect(parsed.ignoredColumns).toBe(3);
    expect(JSON.stringify(parsed)).not.toContain('카나리');
    expect(formatPlan({ kind: 'rooms', added: [], changed: [], unchanged: [], notInFile: [], rejected: [], ignoredColumns: 3 }).join('\n')).toContain(
      '정해진 칸 말고 다른 칸 3개는 읽지 않고 버렸어요',
    );
    // "이름"만 쓴 칸은 방 이름(name)으로 읽지 않아서, name 칸이 없는 파일로 멈춰요.
    expect(() => parseRooms(['id,이름,floor,capacity,equipment,facilities', 'r-1,가상,1층,4,,'].join('\n'))).toThrow('머리 줄에 name 칸이 없어요');
  });
});

describe('운영자 자료 넣기 — 미리보기·반영(Q8)', () => {
  it('[Q8] 미리보기는 아무 표에도 쓰지 않아요(감사 로그 포함)', async () => {
    const a = await app();
    const before = await tableCounts(a.db);
    const rooms = await planFile(a.db, parseRooms([ROOMS_HEADER, 'r-3a,회의실 3A,3층,6,화면,', 'r-5b,회의실 5B,5층,10,,'].join('\n')));
    const items = await planFile(a.db, parseCatalog([CATALOG_HEADER, 'cat-tea,녹차 티백,9000,1,녹차'].join('\n')));
    const notices = await planFile(a.db, parseNotices(JSON.stringify([notice()]), ALLOWED_BOARDS));
    expect([rooms.added.length, items.added.length, notices.added.length]).toEqual([2, 1, 1]);
    expect(await tableCounts(a.db)).toEqual(before);
  });

  it('[Q8] 회의실 반영은 새것·바뀐 것만 고치고 감사 로그 한 줄(rooms·ops-import·rows:N)만 남겨요. 이름·값은 없어요', async () => {
    const a = await app();
    await insertLedger(
      a.db,
      [
        { id: 'r-3a', name: '회의실 3A', floor: '3층', capacity: 4, equipment: ['화면'], facilities: [], photoUrl: '/rooms/r-3a.svg' },
        { id: 'r-4a', name: '회의실 4A', floor: '4층', capacity: 8, equipment: [], facilities: ['창문'], photoUrl: null },
      ],
      [],
    );
    const parsed = parseRooms(
      [ROOMS_HEADER, 'r-3a,회의실 3A,3층,6,화면;화이트보드,TV 모니터', 'r-4a,회의실 4A,4층,8,,창문', 'r-5b,가상 큰 회의실 5B,5층,12,화상회의,카메라'].join(
        '\n',
      ),
    );
    const plan = await planFile(a.db, parsed);
    expect(plan.added.map((e) => e.id)).toEqual(['r-5b']);
    expect(plan.changed.map((e) => [e.id, e.columns])).toEqual([['r-3a', ['capacity', 'equipment', 'facilities']]]);
    expect(plan.unchanged.map((e) => e.id)).toEqual(['r-4a']);

    const auditBefore = (await a.db.query<{ n: number }>('select count(*)::int as n from audit_log')).rows[0]!.n;
    const { written } = await applyFile(deps(a), parsed);
    expect(written).toBe(2);
    const { rows } = await a.db.query<{ id: string; capacity: number; equipment: string[]; facilities: string[]; photo_url: string | null }>(
      'select id, capacity, equipment, facilities, photo_url from rooms order by id',
    );
    expect(rows).toEqual([
      // 사진 주소는 건드리지 않아요.
      { id: 'r-3a', capacity: 6, equipment: ['화면', '화이트보드'], facilities: ['TV 모니터'], photo_url: '/rooms/r-3a.svg' },
      { id: 'r-4a', capacity: 8, equipment: [], facilities: ['창문'], photo_url: null },
      { id: 'r-5b', capacity: 12, equipment: ['화상회의'], facilities: ['카메라'], photo_url: null },
    ]);
    const audits = await importAudits(a.db);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ pseudonym_id: 'cli', channel: 'write', module: 'rooms', action: 'ops-import', result: 'rows:2' });
    expect(audits[0]!.tool ?? null).toBeNull();
    expect(audits[0]!.plan_id ?? null).toBeNull();
    expect(JSON.stringify(audits)).not.toMatch(/회의실|r-3a|r-5b|카메라|5층/);
    expect((await a.db.query<{ n: number }>('select count(*)::int as n from audit_log')).rows[0]!.n).toBe(auditBefore + 1);

    // 같은 파일을 다시 반영하면 바뀌는 것이 없어요(rows:0).
    expect((await applyFile(deps(a), parsed)).written).toBe(0);
    expect((await importAudits(a.db)).map((r) => r.result)).toEqual(['rows:2', 'rows:0']);
  });

  it('[Q8] 파일에 없는 회의실은 지우지 않아요. 예약이 있는 방도 예약째 그대로 남아요', async () => {
    const a = await app();
    const start = a.now() + 24 * 60 * 60_000;
    await insertLedger(
      a.db,
      [{ id: 'r-2a', name: '회의실 2A', floor: '2층', capacity: 4, equipment: ['화면'], facilities: [], photoUrl: null }],
      [{ ref: 'L-1', roomId: 'r-2a', start, end: start + 60 * 60_000 }],
    );
    const parsed = parseRooms([ROOMS_HEADER, 'r-3a,회의실 3A,3층,6,화면,'].join('\n'));
    const plan = await planFile(a.db, parsed);
    expect(plan.notInFile).toEqual([{ id: 'r-2a', label: '회의실 2A' }]);
    expect(formatPlan(plan).join('\n')).toContain('파일에 없는 회의실 1개(지우지 않고 그대로 둬요)');
    await applyFile(deps(a), parsed);
    const rooms = (await a.db.query<{ id: string }>('select id from rooms order by id')).rows.map((r) => r.id);
    expect(rooms).toEqual(['r-2a', 'r-3a']);
    expect((await a.db.query<{ n: number }>("select count(*)::int as n from room_reservations where room_id = 'r-2a'")).rows[0]!.n).toBe(1);
  });

  it('[Q8] 거절한 줄이 하나라도 있으면 반영하지 않아요(쓰기·감사 로그 0)', async () => {
    const a = await app();
    const before = await tableCounts(a.db);
    const parsed = parseRooms([ROOMS_HEADER, 'r-3a,회의실 3A,3층,6,화면,', 'r-3b,회의실 3B,옥상,6,,'].join('\n'));
    await expect(applyFile(deps(a), parsed)).rejects.toThrow('거절한 줄이 1개 있어서 반영하지 않았어요');
    expect(await tableCounts(a.db)).toEqual(before);
  });

  it('[Q8] 카탈로그 반영은 id로 넣거나 고치고, 파일에 없는 품목은 그대로 둬요. 감사 로그는 pantry 한 줄이에요', async () => {
    const a = await app();
    await insertCatalogItem(a.db, { id: 'cat-coke', name: '가상 콜라 355', unitPrice: 900, packUnit: 24, aliases: ['콜라'] });
    await insertCatalogItem(a.db, { id: 'cat-old', name: '가상 옛 품목', unitPrice: 500, packUnit: 10, aliases: [] });
    const parsed = parseCatalog([CATALOG_HEADER, 'cat-coke,가상 콜라 355,950,24,콜라;코크', 'cat-tea,가상 녹차 티백,9000,1,녹차'].join('\n'));
    const plan = await planFile(a.db, parsed);
    expect(plan.changed.map((e) => [e.id, e.columns])).toEqual([['cat-coke', ['unitPrice', 'aliases']]]);
    expect(plan.notInFile.map((e) => e.id)).toEqual(['cat-old']);
    expect((await applyFile(deps(a), parsed)).written).toBe(2);
    const { rows } = await a.db.query<{ id: string; unit_price: number; aliases: string[] }>('select id, unit_price, aliases from pantry_catalog order by id');
    expect(rows).toEqual([
      { id: 'cat-coke', unit_price: 950, aliases: ['콜라', '코크'] },
      { id: 'cat-old', unit_price: 500, aliases: [] },
      { id: 'cat-tea', unit_price: 9000, aliases: ['녹차'] },
    ]);
    const audits = await importAudits(a.db);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ pseudonym_id: 'cli', channel: 'write', module: 'pantry', action: 'ops-import', result: 'rows:2' });
    expect(JSON.stringify(audits)).not.toMatch(/콜라|녹차|cat-/);
  });

  it('[Q8] 공지 반영은 사본 갱신(ingest) 길로 들어가 알림 대상 제안이 생기고, 본문은 어느 표에도 남지 않아요', async () => {
    const a = await app();
    const file = JSON.stringify([
      notice(),
      notice({ id: 'N-2002', board: '총무 안내', title: '3층 탕비실 정수기 교체 안내', body: `3층 탕비실 정수기를 바꿔요. ${BODY_CANARY}` }),
    ]);
    const parsed = parseNotices(file, ALLOWED_BOARDS);
    const preview = await planFile(a.db, parsed);
    expect([preview.added.length, preview.unchanged.length]).toEqual([2, 0]);
    // 미리보기 출력에는 제목까지만 나와요. 본문은 없어요.
    const lines = formatPlan(preview).join('\n');
    expect(lines).toContain('새 공지 2건');
    expect(lines).toContain('사내 식당 저녁 운영 시간 변경 안내');
    expect(lines).not.toContain(BODY_CANARY);

    expect((await applyFile(deps(a), parsed)).written).toBe(2);
    expect((await a.db.query<{ id: string }>('select id from notices order by id')).rows.map((r) => r.id)).toEqual(['N-2001', 'N-2002']);
    // 공지 모듈이 켬이라 새 공지마다 알림 대상 제안 줄이 생겨요(총무 확인 대기).
    expect((await a.db.query<{ n: number }>('select count(*)::int as n from notice_audience')).rows[0]!.n).toBe(2);
    // 찾기 색인으로는 찾아요(본문은 조각으로만 남아요).
    expect((await a.ctx.services.notices!.search('식당 저녁 운영', 3)).hits.map((h) => h.id)).toContain('N-2001');
    expect(await everyRow(a.db)).not.toContain(BODY_CANARY);

    const audits = await importAudits(a.db);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ pseudonym_id: 'cli', channel: 'write', module: 'notices', action: 'ops-import', result: 'rows:2' });
    expect(JSON.stringify(audits)).not.toMatch(/식당|정수기|N-20/);

    // 다시 미리 보면 이미 있는 공지예요. 반영해도 새로 들어가지 않아요.
    const again = await planFile(a.db, parsed);
    expect([again.added.length, again.unchanged.length]).toEqual([0, 2]);
    expect((await applyFile(deps(a), parsed)).written).toBe(0);
    expect((await a.db.query<{ n: number }>('select count(*)::int as n from notice_audience')).rows[0]!.n).toBe(2);
  });
});
