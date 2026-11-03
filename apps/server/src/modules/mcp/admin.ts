import { randomBytes } from 'node:crypto';
import {
  addDays,
  kstDate,
  kstToEpoch,
  type McpClientCreateRequest,
  type McpClientCreateResponse,
  type McpClientSummary,
  type McpReport,
} from '@one-line-desk/shared';
import type { AccessRecorder } from '../../core/access-record';
import type { AuditLog } from '../../core/audit';
import type { Db, Queryable } from '../../core/db';
import { DeskError } from '../../core/errors';
import { checkRegistration } from './policy';
import * as repo from './repo';
import { hashClientSecret, randomToken } from './tokens';

// MCP 관리 평면(11/3, MCP 통합 회의 1단계): 허용 앱 등록·보안팀 승인·회수·앱별 강제 끊기·보고.
// 운영자 API(ops-routes.ts)와 명령 도구(scripts/mcp-clients.ts)가 같은 함수를 써요. 운영자 웹 화면은 없어요(R7).
// - 감사 로그(channel ops)에는 동작·클라이언트 ID·결과만 남겨요. 앱 이름·리디렉트 주소·비밀은 넣지 않아요.
// - 연결을 끊는 동작은 접속기록(mcp.disconnect)에 누가(운영자) 누구의 연결(가명 ID)을 끊었는지만 남겨요(ADR-20).
// - 사람별 강제 끊기는 두지 않아요. 운영자가 가명 ID를 알 길이 없고, 사람 찾기를 열면 가명 ID ↔ 사람이 이어져요.
//   사람 하나를 끊는 길은 퇴사 처리(IdP 비활성 → 재직 재확인)와 본인의 [끊기]·모든 기기 로그아웃이에요.

export interface AdminDeps {
  db: Db;
  audit: AuditLog;
  access: AccessRecorder;
  now: () => number;
}

/** 누가 바꿨는지. 웹 API는 운영자 가명 ID·접속지, 명령 도구는 고정 값 'cli'예요(사람 이름은 넣지 않아요). */
export interface AdminActor {
  pseudonymId: string;
  ip?: string;
  requestId?: string;
}

export const CLI_ACTOR: AdminActor = { pseudonymId: 'cli' };

const RECENT_DAYS = 7;
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
    await repo.deleteClient(q, clientId);
    await opsAudit(deps, q, actor, 'mcpClient.revoke', clientId, 'done');
    await recordDisconnect(deps, q, actor, people);
    return { removed: devices };
  });
}

/** 보고(셈만). 감사 로그가 7일 보관이라 결과별 셈은 최근 7일, 접속기록으로 셀 수 있는 것만 이번 달이에요. */
export async function report(deps: Pick<AdminDeps, 'db' | 'now'>): Promise<McpReport> {
  const now = deps.now();
  const today = kstDate(now);
  const monthFrom = kstToEpoch(`${today.slice(0, 8)}01`, '00:00');
  const recentFrom = kstToEpoch(addDays(today, -(RECENT_DAYS - 1)), '00:00');
  const c = await repo.reportCounts(deps.db, monthFrom, recentFrom);
  const n = (v: number | undefined) => v ?? 0;
  return {
    generatedAt: new Date(now).toISOString(),
    month: { from: new Date(monthFrom).toISOString(), ...c.month },
    recent7Days: {
      from: new Date(recentFrom).toISOString(),
      toolCalls: {
        found: n(c.recent.toolCalls.found),
        none: n(c.recent.toolCalls.none),
        refused: n(c.recent.toolCalls.refused),
        error: n(c.recent.toolCalls.error),
      },
      consents: { allowed: n(c.recent.consents.allowed), denied: n(c.recent.consents.denied) },
      tokenRefused: c.recent.tokenRefused,
      blockedApps: c.recent.blockedApps,
      leaverEnded: c.recent.leaverEnded,
    },
    now: c.now,
  };
}
