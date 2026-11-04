import { randomBytes } from 'node:crypto';
import {
  MCP_COUNT_KINDS,
  type McpClientCreateRequest,
  type McpClientCreateResponse,
  type McpClientSummary,
  type McpCountKind,
  type McpReport,
} from '@one-line-desk/shared';
import type { AccessRecorder } from '../../core/access-record';
import type { AuditLog } from '../../core/audit';
import type { Db, Queryable } from '../../core/db';
import { DeskError } from '../../core/errors';
import * as counts from './counts';
import { checkRegistration } from './policy';
import * as repo from './repo';
import { hashClientSecret, randomToken } from './tokens';

// MCP 관리 평면(11/3, MCP 통합 회의 1단계): 허용 앱 등록·보안팀 승인·회수·앱별·사람별 강제 끊기·달 보고.
// 운영자 API(ops-routes.ts)와 명령 도구(scripts/mcp-clients.ts)가 같은 함수를 써요. 운영자 웹 화면은 없어요(R7).
// - 감사 로그(channel ops)에는 동작·클라이언트 ID·결과만 남겨요. 앱 이름·리디렉트 주소·비밀·사람은 넣지 않아요.
// - 연결을 끊는 동작은 접속기록(mcp.disconnect)에 누가(운영자) 누구의 연결(가명 ID)을 끊었는지만 남겨요(ADR-20).
// - 사람별 강제 끊기(11/3 사용자 결정): 운영자가 운영자 전용 직원 검색(POST /api/ops/people/search, 11/4 — 회의실 쓰기와 상관없음, people.search 접속기록)으로 고른
//   사람의 모든 연결을 끊어요. 응답은 끊은 연결 수뿐이고, 그 사람이 쓴 앱·연결한 날은 돌려주지 않아요.
//   명령 도구에는 두지 않아요: 사람을 고를 안전한 길(직원 검색의 봉인된 ref)이 웹 로그인에 묶여 있고,
//   명령 줄에서 IdP 주체(메일일 수 있어요)나 가명 ID를 받으면 셸 기록에 사람 식별값이 남아요.
// - 끊기·회수·사람별 끊기마다 월간 보고용 날마다 셈(disconnect.ops)을 같은 tx에서 더해요(counts.ts).

export interface AdminDeps {
  db: Db;
  audit: AuditLog;
  access: AccessRecorder;
  now: () => number;
  /** 사람별 끊기 뒤 그 사람의 메모리 상태(아직 바꾸지 않은 인가 코드 등)를 버려요. 웹 API만 넘겨요(McpAuth.forget). */
  forget?: (pseudonymId: string) => void;
}

/** 누가 바꿨는지. 웹 API는 운영자 가명 ID·접속지, 명령 도구는 고정 값 'cli'예요(사람 이름은 넣지 않아요). */
export interface AdminActor {
  pseudonymId: string;
  ip?: string;
  requestId?: string;
}

export const CLI_ACTOR: AdminActor = { pseudonymId: 'cli' };

const REFS_PER_LINE = 100;

const summary = (c: repo.ClientOverview): McpClientSummary => ({
  clientId: c.clientId,
  appName: c.appName,
  kind: c.publicClient ? 'public' : 'confidential',
  demoOnly: c.demoOnly,
  securityApproved: c.securityApproved,
  redirectUris: c.redirectUris,
  people: c.people,
  devices: c.devices,
  createdOn: c.createdOn,
});

const notFound = () => new DeskError('not-found', 404, '등록된 앱이 아니에요');

async function overviewOf(q: Queryable, clientId: string): Promise<McpClientSummary> {
  const found = (await repo.listClientsOverview(q)).find((c) => c.clientId === clientId);
  if (!found) throw notFound();
  return summary(found);
}

async function opsAudit(deps: AdminDeps, q: Queryable, actor: AdminActor, action: string, clientId: string, result: string): Promise<void> {
  await deps.audit.record({ pseudonymId: actor.pseudonymId, channel: 'ops', action, clientId, result }, q);
}

/** 연결을 끊은 사람들을 접속기록에 남겨요. 한 줄에 정보주체 표시는 100개까지라 나눠 남겨요. */
async function recordDisconnect(deps: AdminDeps, q: Queryable, actor: AdminActor, people: string[]): Promise<void> {
  for (let i = 0; i < people.length; i += REFS_PER_LINE) {
    await deps.access.record(
      {
        pseudonymId: actor.pseudonymId,
        action: 'mcp.disconnect',
        subjectRefs: people.slice(i, i + REFS_PER_LINE).map((p) => `person:${p}`),
        ...(actor.ip ? { ip: actor.ip } : {}),
        ...(actor.requestId ? { requestId: actor.requestId } : {}),
      },
      q,
    );
  }
}

export async function listClients(db: Queryable): Promise<McpClientSummary[]> {
  return (await repo.listClientsOverview(db)).map(summary);
}

/** 등록. 기밀이면 서버가 비밀을 만들어 이 응답에서 한 번만 돌려주고, DB에는 해시만 남겨요. 보안팀 승인은 꺼진 채로 시작해요. */
export async function addClient(deps: AdminDeps, actor: AdminActor, req: McpClientCreateRequest): Promise<McpClientCreateResponse> {
  const checked = checkRegistration(req);
  if (!checked.ok) throw new DeskError('bad-request', 400, checked.reason);
  const clientId = `mcp-${randomBytes(8).toString('hex')}`;
  const secret = req.kind === 'confidential' ? randomToken(32) : undefined;
  return deps.db.tx(async (q) => {
    await repo.insertClient(q, {
      clientId,
      secretHash: secret ? hashClientSecret(secret) : null,
      publicClient: req.kind === 'public',
      appName: checked.appName,
      redirectUris: checked.redirectUris,
      securityApproved: false,
      demoOnly: req.demoOnly === true,
    });
    await opsAudit(deps, q, actor, 'mcpClient.add', clientId, req.kind);
    return { client: await overviewOf(q, clientId), ...(secret ? { clientSecret: secret } : {}) };
  });
}

/**
 * 보안팀 승인 켜기·끄기. 끄면 그 앱은 허용 목록 밖이라 다음 요청부터 막혀요(시연용이고 데이터가 모두 모의면 빼고).
 * 연결(승인)은 지우지 않아서 다시 켜면 이어져요. 바로 끊으려면 끊기·회수를 써요.
 */
export async function setApproval(deps: AdminDeps, actor: AdminActor, clientId: string, approved: boolean): Promise<McpClientSummary> {
  return deps.db.tx(async (q) => {
    if (!(await repo.setSecurityApproved(q, clientId, approved))) throw notFound();
    await opsAudit(deps, q, actor, approved ? 'mcpClient.approve' : 'mcpClient.unapprove', clientId, 'done');
    return overviewOf(q, clientId);
  });
}

/** 앱별 강제 끊기: 그 앱의 모든 사람·기기 연결을 지워요. 클라이언트 등록은 남아요. */
export async function disconnectClient(deps: AdminDeps, actor: AdminActor, clientId: string): Promise<{ removed: number }> {
  return deps.db.tx(async (q) => {
    if (!(await repo.findClient(q, clientId))) throw notFound();
    const people = await repo.peopleOfClient(q, clientId);
    const removed = await repo.deleteGrantsOfClient(q, clientId);
    await opsAudit(deps, q, actor, 'mcpClient.disconnect', clientId, removed > 0 ? 'done' : 'none');
    await counts.count(q, deps.now(), 'disconnect.ops', clientId, removed);
    await recordDisconnect(deps, q, actor, people);
    return { removed };
  });
}

/** 회수: 클라이언트를 지워요. 승인이 같이 지워져(cascade) 모든 연결이 끊기고, 그 ID로는 다시 붙지 못해요. */
export async function revokeClient(deps: AdminDeps, actor: AdminActor, clientId: string): Promise<{ removed: number }> {
  return deps.db.tx(async (q) => {
    if (!(await repo.findClient(q, clientId))) throw notFound();
    const people = await repo.peopleOfClient(q, clientId);
    const devices = (await repo.listClientsOverview(q)).find((c) => c.clientId === clientId)?.devices ?? 0;
    // 앱 이름은 등록 표에서 찾아 넣어서, 지우기 전에 더해요.
    await counts.count(q, deps.now(), 'disconnect.ops', clientId, devices);
    await repo.deleteClient(q, clientId);
    await opsAudit(deps, q, actor, 'mcpClient.revoke', clientId, 'done');
    await recordDisconnect(deps, q, actor, people);
    return { removed: devices };
  });
}

/**
 * 사람별 강제 끊기: 그 사람(가명 ID)의 모든 앱·기기 연결을 지워요. 가명 ID는 ops-routes가 직원 검색 ref에서 서버 안에서만 계산해요.
 * 감사 로그에는 동작·결과만(사람·앱 없음), 접속기록 mcp.disconnect에는 운영자와 `person:<가명 ID>` 하나를 남겨요(끊은 연결이 없어도 남겨요).
 */
export async function disconnectPerson(deps: AdminDeps, actor: AdminActor, pseudonymId: string): Promise<{ removed: number }> {
  const result = await deps.db.tx(async (q) => {
    const removed = await repo.deleteGrantsFor(q, pseudonymId);
    await deps.audit.record(
      { pseudonymId: actor.pseudonymId, channel: 'ops', action: 'mcpPerson.disconnect', result: removed.length > 0 ? 'done' : 'none' },
      q,
    );
    await recordDisconnect(deps, q, actor, [pseudonymId]);
    await counts.countRemoved(q, deps.now(), 'disconnect.ops', removed);
    return { removed: removed.length };
  });
  deps.forget?.(pseudonymId);
  return result;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 달 보고(셈만). 종류별·앱별 합계는 날마다 셈 표(13개월 보관)에서, 호출한 사람 수는 접속기록(1년)에서 세요.
 * month를 빼면 이번 달(한국 시간)이에요. 13개월보다 앞선 달은 셈이 지워져서 0이에요.
 */
export async function report(deps: Pick<AdminDeps, 'db' | 'now'>, month?: string): Promise<McpReport> {
  const now = deps.now();
  const target = month ?? counts.kstMonth(now);
  if (!MONTH_RE.test(target)) throw new DeskError('bad-request', 400, '달은 YYYY-MM 모양으로 넣어 주세요');
  const range = counts.monthRange(target);
  const rows = await repo.sumDailyCounts(deps.db, range.fromDay, range.toDay);
  const totals = Object.fromEntries(MCP_COUNT_KINDS.map((k) => [k, 0])) as Record<McpCountKind, number>;
  const byApp = new Map<string, Partial<Record<McpCountKind, number>>>();
  for (const r of rows) {
    totals[r.kind] += r.n;
    const app = byApp.get(r.app) ?? {};
    app[r.kind] = (app[r.kind] ?? 0) + r.n;
    byApp.set(r.app, app);
  }
  return {
    generatedAt: new Date(now).toISOString(),
    month: target,
    from: new Date(range.from).toISOString(),
    to: new Date(range.to).toISOString(),
    totals,
    byApp: [...byApp].map(([app, c]) => ({ app, counts: c })),
    accessLog: await repo.accessCounts(deps.db, range.from, range.to),
    now: await repo.nowCounts(deps.db),
  };
}
