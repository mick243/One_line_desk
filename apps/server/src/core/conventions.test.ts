import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 규칙 시험(docs/CONVENTIONS.md 8절). ESLint 대신 코드를 읽어 프로젝트 규칙을 지켜요.
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SERVER = join(ROOT, 'apps/server/src');
const WEB = join(ROOT, 'apps/web/src');
const MODULES = join(SERVER, 'modules');

function files(dir: string, exts = ['.ts', '.tsx']): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, exts);
    return exts.some((e) => name.endsWith(e)) ? [path] : [];
  });
}

const rel = (path: string) => relative(ROOT, path).split(sep).join('/');
const isTest = (path: string) => /\.test\.tsx?$/.test(path);

describe('규칙 시험', () => {
  it('[ADR-01] 모듈은 다른 모듈을 import하지 않아요', () => {
    const bad: string[] = [];
    for (const file of files(MODULES)) {
      const own = rel(file).split('/')[4]!;
      // modules/index.ts는 모듈 목록이라 모두 import해요.
      if (own.endsWith('.ts')) continue;
      for (const m of readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1]!;
        if (!spec.startsWith('.')) continue;
        const target = rel(join(file, '..', spec));
        const targetModule = target.startsWith('apps/server/src/modules/') ? target.split('/')[4] : undefined;
        if (targetModule && targetModule !== own && !targetModule.endsWith('.ts')) bad.push(`${rel(file)} → ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('서버 코드는 console.log를 쓰지 않아요(로그는 req.log, 본문 없이)', () => {
    const bad = files(SERVER)
      .filter((f) => !isTest(f))
      .filter((f) => /console\.(log|info|debug|warn)\(/.test(readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });

  it('[R13] 웹 코드는 브라우저 저장소에 아무것도 넣지 않아요', () => {
    // 시험 파일은 저장소가 비어 있는지 확인하려고 이름을 불러요(screens/HomeAsk.test.tsx).
    const bad = files(WEB)
      .filter((f) => !isTest(f))
      .filter((f) => /\b(localStorage|sessionStorage|indexedDB)\b/.test(readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });

  it('웹 코드는 dangerouslySetInnerHTML을 쓰지 않아요', () => {
    const bad = files(WEB).filter((f) => readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML'));
    expect(bad.map(rel)).toEqual([]);
  });

  it('모듈은 시계를 ctx.now()로만 읽어요', () => {
    const bad = files(MODULES)
      .filter((f) => !isTest(f))
      .filter((f) => /Date\.now\(\)|new Date\(\)/.test(readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });

  // 장애런북 3절: 배포를 되돌려도 앞 판이 그대로 뜨려면 한 배포의 마이그레이션은 넓히기만 해요(11/23 운영 검토).
  // 지우기·이름 바꾸기·NOT NULL 더하기·자료형 바꾸기는 다음 배포로 나눠야 해서, 꼭 필요하면 아래 목록에 까닭과 함께 적어요.
  it('[장애런북 3절] 마이그레이션은 넓히기만 해요(좁히는 문장은 허용 목록에 까닭을 적어요)', () => {
    const ALLOWED: Record<string, string> = {
      '020_core_notify_groupware.sql': "알림 page 검사를 지우고 값을 더한 검사로 바로 다시 붙여요(넓히기, 'groupware' 추가)",
      '040_core_notify_operator.sql': "알림 받는 역할 검사를 지우고 값을 더한 검사로 바로 다시 붙여요(넓히기, 'operator' 추가)",
    };
    const NARROW =
      /\b(drop\s+(table|column|constraint|index|type|function|trigger)|rename\s+(to|column)|set\s+not\s+null|alter\s+column\s+\S+\s+(set\s+data\s+)?type)\b/i;
    const dir = join(ROOT, 'db/migrations');
    const bad = readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && !(f in ALLOWED))
      .filter((f) => NARROW.test(readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, '')));
    expect(bad).toEqual([]);
  });

  // Node 판은 .node-version 하나가 기준이에요(11/25). CI는 이 파일을 읽고, 운영 이미지(Dockerfile ARG)와 회사 설정 검사(tenant-lib 기본값)는
  // 따로 적혀 있어서 판을 올릴 때 하나만 바꾸면 CI·이미지·검사가 서로 다른 Node로 돌아요. Dockerfile의 FROM이 ARG라 dependabot도 올려 주지 못해요.
  it('[운영] Node 판이 .node-version·Dockerfile·회사 설정 검사에서 같아요', () => {
    const want = readFileSync(join(ROOT, '.node-version'), 'utf8').trim();
    const docker = readFileSync(join(ROOT, 'Dockerfile'), 'utf8').match(/^ARG NODE_VERSION=(\S+)$/m)?.[1];
    const tenant = readFileSync(join(ROOT, 'apps/server/scripts/tenant-lib.ts'), 'utf8').match(/runtime = \{ node: '([^']+)'/)?.[1];
    expect({ docker, tenant }).toEqual({ docker: want, tenant: want });
  });

  // CLAUDE.md "기록이 쌓이는 표를 새로 만들면 지우기도 같이 넣어요"(ADR-21). 새 표는 아래 목록에 지우는 길이나 지우지 않는 까닭을 적어야 해요.
  // 'delete'는 시험 아닌 서버 코드에 그 표를 지우는 문장(delete from 표)이 있는지까지 봐요. 몇 일 뒤 지우는지는 모듈 보관 시험이 봐요.
  it('[ADR-21] 모든 표는 지우는 길이나 지우지 않는 까닭이 적혀 있어요', () => {
    const KEEP: Record<string, 'delete' | `cascade:${string}` | `keep:${string}`> = {
      access_log: 'delete', // 1년(ADR-20)
      action_receipts: 'delete',
      ai_usage: 'delete',
      audit_log: 'delete',
      cafe_bill_notices: 'cascade:cafe_bills',
      cafe_bills: 'delete',
      cafe_duty: 'keep:바리스타 영업 상태 한 줄(사람·기록 없음)',
      cafe_limit_requests: 'delete',
      cafe_menu: 'keep:운영자가 고치는 메뉴판',
      cafe_month_limits: 'delete',
      cafe_orders: 'delete',
      mcp_clients: 'delete',
      mcp_daily_counts: 'delete', // 13개월(ADR-21 개정)
      mcp_grants: 'delete',
      mock_calendar_events: 'delete',
      mock_messenger_messages: 'delete',
      navi_away: 'delete',
      navi_feedback: 'delete',
      navi_inquiries: 'delete',
      navi_inquiry_replies: 'delete',
      navi_inquiry_weeks: 'delete',
      navi_it_faqs: 'keep:운영자가 올리는 IT 자주 묻는 질문',
      navi_rows: 'keep:분장표(분장표 주인이 다시 올리면 바뀌어요)',
      notice_audience: 'delete',
      notices: 'delete',
      notification_reads: 'cascade:notifications',
      notifications: 'delete',
      ops_settings: 'keep:운영 설정',
      pantry_cards: 'delete',
      pantry_catalog: 'keep:구매 카탈로그',
      pantry_cycles: 'keep:주기 설정',
      pantry_floor_settings: 'keep:층 설정',
      pantry_merges: 'delete',
      pantry_order_lines: 'delete',
      pantry_order_plans: 'delete',
      pantry_similar_flags: 'delete',
      pantry_votes: 'delete',
      plans: 'delete',
      room_equipment: 'keep:방 설비 목록',
      room_equipment_loans: 'delete',
      room_facility_status: 'keep:설비 점검 상태(방마다 한 줄)',
      room_invites: 'delete',
      room_joint_requests: 'delete',
      room_reservation_history: 'delete',
      room_reservations: 'delete',
      room_team_delegates: 'delete',
      rooms: 'keep:회의실 목록',
    };
    const sql = readdirSync(join(ROOT, 'db/migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(ROOT, 'db/migrations', f), 'utf8').replace(/--.*$/gm, ''))
      .join('\n');
    const tables = [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]!.toLowerCase());
    expect(
      tables.filter((t) => !(t in KEEP)),
      '새 표는 KEEP에 지우는 길이나 까닭을 적어요',
    ).toEqual([]);
    expect(
      Object.keys(KEEP).filter((t) => !tables.includes(t)),
      '없어진 표는 KEEP에서 빼요',
    ).toEqual([]);

    const code = files(SERVER)
      .filter((f) => !isTest(f))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const noDelete = Object.entries(KEEP)
      .filter(([, how]) => how === 'delete')
      .map(([t]) => t)
      .filter((t) => !new RegExp(`delete\\s+from\\s+${t}\\b`, 'i').test(code));
    expect(noDelete, "'delete'로 적은 표인데 지우는 문장이 없어요").toEqual([]);
    const badCascade = Object.entries(KEEP)
      .filter(([, how]) => how.startsWith('cascade:'))
      .filter(([t, how]) => !new RegExp(`create\\s+table\\s+${t}\\b[\\s\\S]*?references\\s+${how.slice(8)}\\b[^,]*on\\s+delete\\s+cascade`, 'i').test(sql));
    expect(
      badCascade.map(([t]) => t),
      "'cascade'로 적은 표인데 부모 표 on delete cascade가 없어요",
    ).toEqual([]);
  });
});
