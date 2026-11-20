import '../src/config';
import { readFileSync, statSync } from 'node:fs';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { AuditLog } from '../src/core/audit';
import { openDb, pendingMigrations } from '../src/core/db';
import { DeskError } from '../src/core/errors';
import { ALLOWED_BOARDS } from '../src/modules/notices/fixtures';
import * as lib from './ops-data-lib';

// 운영자 자료 넣기 명령 도구(11/11 QA Q8). 운영은 가상 자료를 넣지 않아서 회의실·탕비실 구매 카탈로그·공지 사본이 빈 채로 떠요.
// 파일럿 전에 회사 자료 파일을 미리 보고(쓰기 없음) --apply로 반영해요. 검사·비교·반영은 ops-data-lib.ts에 있어요(시험이 거기를 봐요).
// DB에 바로 붙어요(DATABASE_URL, 없으면 개발용 PGlite .data/pglite). 마이그레이션이 남아 있으면 돌지 않아요.
// 감사 로그의 "누가"는 mcp-clients와 같은 고정 값 'cli'예요. 누가 돌렸는지는 서버 접속 기록(운영 계정)으로 봐요.

const HELP = `한 줄 데스크 운영 자료 넣기(파일럿 전에 회사 자료를 넣어요)

  npm run ops:data -- rooms <파일.csv> [--apply]      회의실. 머리 줄: ${lib.ROOM_COLUMNS.join(',')}
  npm run ops:data -- catalog <파일.csv> [--apply]    탕비실 구매 카탈로그. 머리 줄: ${lib.CATALOG_COLUMNS.join(',')}
  npm run ops:data -- notices <파일.json> [--apply]   공지 사본. [{ "id", "board", "title", "postedOn", "url", "body" }, …]

- --apply 없이 돌리면 미리 보기만 해요. 새로 넣을 것·바뀔 것·그대로인 것·거절한 줄(줄 번호와 까닭)을 보여 주고 아무것도 쓰지 않아요.
- --apply를 붙이면 반영하고 감사 로그를 한 줄 남겨요(모듈·ops-import·rows:N, 이름·값 없음). 회의실·카탈로그는 한 트랜잭션이에요.
  거절한 줄이 하나라도 있으면 반영하지 않아요. 고친 뒤 다시 미리 봐요.
- 지우는 길은 없어요. 파일에 없는 회의실·품목은 "파일에 없어요(그대로 둬요)"로 알려 주기만 해요(예약·요청 카드가 가리켜요).
- 회의실: floor는 3층처럼, capacity는 1~200, equipment는 화면·화상회의·화이트보드 중에서 ;로 나눠요.
  facilities는 화면에 보일 설비 설명이에요(;로 나눠요). 사진 주소는 넣지 않아요(새 방은 사진 없이 보여요).
- 카탈로그: unitPrice는 원 단위 단가, packUnit은 한 번에 사는 개수, aliases는 ;로 나눈 다른 말이에요.
- 공지: board는 허용 게시판(${ALLOWED_BOARDS.join('·')})만, postedOn은 2026-11-11처럼, url은 https 원문 링크예요.
  본문은 색인 조각과 알림 대상 제안에만 쓰고 DB·화면에 내지 않아요. 이미 있는 공지(같은 id)는 바꾸지 않아요.
  반영하면 새 공지마다 알림 대상 제안이 생기고 총무에게 확인 알림이 가요. 새 공지 알림 자동 보내기가 켜져 있으면 반영하지 않아요.
- 머리 줄은 회사 파일에서 흔한 이름도 받아요(회의실명·층·인원·장비·설비, 품목명·단가·입수·별칭 등). 바꿔 읽은 칸은 미리 보기 맨 위에
  "'회의실명' 칸을 'name' 칸으로 읽었어요"처럼 알려요. 맞는지 보고 --apply를 붙여요. 담당자·성명 같은 사람 이름 칸은 읽지 않아요.
- 줄 번호는 머리 줄을 1번째로 세요(빈 줄은 세지 않아요). 공지는 배열 안 몇 번째인지예요. 거절 까닭에는 칸 값을 싣지 않아요.
- 파일은 UTF-8, ${lib.OPS_FILE_MAX_BYTES / 1_000_000}MB까지예요. 엑셀에서 저장할 때는 "CSV UTF-8"로 저장해요.
- 개발용 PGlite를 쓸 때는 개발 서버(npm run dev)를 끄고 돌려요. PGlite는 한 프로세스만 열 수 있어요.`;

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [kind, file, ...extra] = args.filter((a) => !a.startsWith('--'));
const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};
const out = (text: string) => process.stdout.write(`${text}\n`);

if (!kind || kind === 'help' || flags.includes('--help')) {
  process.stdout.write(`${HELP}\n`);
  process.exit(kind ? 0 : 1);
}
if (!lib.isOpsDataKind(kind)) fail(`모르는 종류예요. ${lib.OPS_DATA_KINDS.join('·')} 중 하나를 넣어 주세요`);
const unknownFlag = flags.find((f) => f !== '--apply');
if (unknownFlag) fail(`모르는 깃발이에요: ${unknownFlag}`);
if (!file) fail('넣을 파일 경로를 적어 주세요');
if (extra.length) fail('파일은 한 번에 하나만 넣어요');
const dataKind = kind as lib.OpsDataKind;
const apply = flags.includes('--apply');

/** 파일을 읽어요. 경로는 사용자 폴더 이름이 들어 있을 수 있어서 되풀이하지 않아요. */
function readInput(path: string): string {
  try {
    if (statSync(path).size > lib.OPS_FILE_MAX_BYTES) return fail(`파일이 너무 커요(${lib.OPS_FILE_MAX_BYTES / 1_000_000}MB까지). 나눠서 넣어 주세요`);
    return readFileSync(path, 'utf8');
  } catch {
    return fail('파일을 읽지 못했어요. 경로를 확인해 주세요');
  }
}

// 파일 검사는 DB를 열기 전에 해요. 양식이 틀리면 DB에 붙지 않고 멈춰요.
let parsed: lib.ParsedFile<lib.OpsDataKind>;
try {
  parsed = lib.parseFile(dataKind, readInput(file!), ALLOWED_BOARDS);
} catch (e) {
  parsed = fail(e instanceof lib.OpsDataError ? e.message : '파일을 읽지 못했어요');
}

const db = await openDb(process.env.DATABASE_URL || undefined);
let closeApp: (() => Promise<void>) | undefined;
try {
  const pending = await pendingMigrations(db);
  if (pending.length) fail(`마이그레이션을 먼저 적용해 주세요(npm run db:migrate): ${pending.join(', ')}`);
  const deps: lib.OpsDataDeps = { db, audit: new AuditLog(db) };
  let note: { line: string; blocked: boolean } | undefined;
  if (dataKind === 'notices') {
    // 공지는 앱 전체가 필요해요: 사본 갱신(ingest)이 알림 대상 제안(AI·직원 명단)과 총무 알림까지 해요. 듣지는(listen) 않아요.
    let config: ReturnType<typeof loadConfig>;
    try {
      config = loadConfig();
    } catch (e) {
      config = fail(e instanceof Error ? e.message : '설정을 읽지 못했어요');
    }
    // 앱이 뜨지 않는 까닭(운영 설정·모의 로그인 등)은 우리가 쓴 해요체 문구라 그대로 보여 줘요.
    const { app, ctx } = await buildApp({ config, db, seed: false, retentionTimer: false }).catch((e: unknown) =>
      fail(`앱을 띄우지 못했어요: ${e instanceof Error ? e.message : '까닭을 모르는 오류예요'}`),
    );
    closeApp = () => app.close();
    deps.ingest = ctx.services.notices?.ingest;
    note = lib.noticeSwitchNote(ctx.ops.get());
  }

  const plan = await lib.planFile(db, parsed);
  for (const line of lib.formatPlan(plan)) out(line);
  if (note) out(`  ${note.line}`);
  if (!apply) {
    out(plan.rejected.length ? '거절한 줄을 고친 뒤 다시 미리 봐 주세요.' : '반영하려면 같은 명령 끝에 --apply를 붙여요.');
  } else {
    if (note?.blocked) fail('반영하지 않았어요');
    const { written } = await lib.applyFile(deps, parsed);
    out(`✓ 반영했어요: ${written}${dataKind === 'notices' ? '건' : '개'}(감사 로그 rows:${written})`);
  }
} catch (e) {
  fail(e instanceof lib.OpsDataError || e instanceof DeskError ? e.message : '처리하지 못했어요');
} finally {
  await closeApp?.();
  await db.close();
}
