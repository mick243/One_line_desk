import { MCP_SCOPES, type McpScope } from '@one-line-desk/shared';
import type { Queryable } from '../../core/db';

// MCP 인가 서버 표(ADR-15). SQL은 여기에만 둬요.
// - mcp_clients: 등록 클라이언트(동적 등록 없음). 기밀(비밀 해시) 또는 공개(비밀 없음, 루프백 리디렉트, 11/2)
// - mcp_grants: 기기별 승인(가명 ID·클라이언트·범위·연결한 날·갱신 토큰 해시·승인 ID). "마지막 사용"은 없어요.

/** 한 사람 × 한 앱에서 동시에 연결해 둘 수 있는 기기 수. 넘치면 가장 먼저 연결한 기기가 끊겨요. */
export const MAX_DEVICES_PER_APP = 5;

export interface ClientRecord {
  clientId: string;
  /** 공개 클라이언트는 null이에요. */
  secretHash: string | null;
  /** 비밀 없는 CLI 클라이언트(Claude Code·Codex). PKCE와 루프백 리디렉트로만 지켜요. */
  publicClient: boolean;
  appName: string;
  redirectUris: string[];
  securityApproved: boolean;
  demoOnly: boolean;
}

export interface GrantRecord {
  pseudonymId: string;
  clientId: string;
  scopes: McpScope[];
  /** YYYY-MM-DD */
  connectedOn: string;
  grantId: string;
}

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  public_client: boolean;
  app_name: string;
  redirect_uris: string[];
  security_approved: boolean;
  demo_only: boolean;
}

interface GrantRow {
  pseudonym_id: string;
  client_id: string;
  scopes: string[];
  connected_on: string;
  grant_id: string;
}

const GRANT_COLUMNS = "pseudonym_id, client_id, scopes, to_char(connected_on, 'YYYY-MM-DD') as connected_on, grant_id";

const toClient = (r: ClientRow): ClientRecord => ({
  clientId: r.client_id,
  secretHash: r.client_secret_hash,
  publicClient: r.public_client,
  appName: r.app_name,
  redirectUris: r.redirect_uris,
  securityApproved: r.security_approved,
  demoOnly: r.demo_only,
});

const toGrant = (r: GrantRow): GrantRecord => ({
  pseudonymId: r.pseudonym_id,
  clientId: r.client_id,
  scopes: r.scopes.filter((s): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s)),
  connectedOn: r.connected_on,
  grantId: r.grant_id,
});

export async function findClient(q: Queryable, clientId: string): Promise<ClientRecord | null> {
  const { rows } = await q.query<ClientRow>(
    'select client_id, client_secret_hash, public_client, app_name, redirect_uris, security_approved, demo_only from mcp_clients where client_id = $1',
    [clientId],
  );
  return rows[0] ? toClient(rows[0]) : null;
}

/** 공개 클라이언트(CLI) 목록. S6 "연결하는 법"이 허용 목록 안인 것만 보여요. */
export async function listPublicClients(q: Queryable): Promise<ClientRecord[]> {
  const { rows } = await q.query<ClientRow>(
    'select client_id, client_secret_hash, public_client, app_name, redirect_uris, security_approved, demo_only from mcp_clients where public_client order by app_name',
  );
  return rows.map(toClient);
}

/** 보안팀 승인 목록에 오른 클라이언트 수(계약 전 잠금 규칙에 써요). */
export async function countApprovedClients(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('select count(*)::int as n from mcp_clients where security_approved');
  return rows[0]?.n ?? 0;
}

/** 운영자 등록과 시연 seed가 써요. 이미 있으면 그대로 둬요. */
export async function insertClient(q: Queryable, c: ClientRecord): Promise<void> {
  await q.query(
    `insert into mcp_clients (client_id, client_secret_hash, public_client, app_name, redirect_uris, security_approved, demo_only)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (client_id) do nothing`,
    [c.clientId, c.secretHash, c.publicClient, c.appName, c.redirectUris, c.securityApproved, c.demoOnly],
  );
}

/**
 * 인가 코드 교환 때 기기 하나의 승인을 새로 만들어요(U6). 같은 앱의 다른 기기 승인은 그대로 둬요.
 * 기기가 MAX_DEVICES_PER_APP을 넘으면 가장 먼저 연결한 기기부터 지워요.
 */
export async function insertGrant(
  q: Queryable,
  g: { pseudonymId: string; clientId: string; scopes: McpScope[]; connectedOn: string; connectedAt: string; refreshTokenHash: string; grantId: string },
): Promise<void> {
  await q.query(
    `insert into mcp_grants (pseudonym_id, client_id, scopes, connected_on, connected_at, refresh_token_hash, grant_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [g.pseudonymId, g.clientId, g.scopes, g.connectedOn, g.connectedAt, g.refreshTokenHash, g.grantId],
  );
  await q.query(
    `delete from mcp_grants where grant_id in (
       select grant_id from mcp_grants where pseudonym_id = $1 and client_id = $2
        order by connected_at desc, grant_id offset $3)`,
    [g.pseudonymId, g.clientId, MAX_DEVICES_PER_APP],
  );
}

export async function findGrantByRefreshHash(q: Queryable, refreshTokenHash: string): Promise<GrantRecord | null> {
  const { rows } = await q.query<GrantRow>(`select ${GRANT_COLUMNS} from mcp_grants where refresh_token_hash = $1`, [refreshTokenHash]);
  return rows[0] ? toGrant(rows[0]) : null;
}

/** 갱신 토큰 회전. 그사이 다른 요청이 먼저 바꿨으면 거짓이에요(한 번만 이겨요). */
export async function rotateRefreshToken(q: Queryable, grantId: string, oldHash: string, newHash: string): Promise<boolean> {
  const { rows } = await q.query<{ client_id: string }>(
    'update mcp_grants set refresh_token_hash = $3 where grant_id = $1 and refresh_token_hash = $2 returning client_id',
    [grantId, oldHash, newHash],
  );
  return rows.length === 1;
}

/** 접근 토큰 검사(요청마다): 그 승인이 아직 있는지 */
export async function grantExists(q: Queryable, pseudonymId: string, clientId: string, grantId: string): Promise<boolean> {
  const { rows } = await q.query('select 1 from mcp_grants where pseudonym_id = $1 and client_id = $2 and grant_id = $3', [pseudonymId, clientId, grantId]);
  return rows.length === 1;
}

/** S6 "연결된 AI 앱": 앱마다 한 줄. 연결한 날은 가장 최근 기기, 범위는 기기들의 합, devices는 기기 수예요. */
export async function listAppsFor(
  q: Queryable,
  pseudonymId: string,
): Promise<{ clientId: string; appName: string; connectedOn: string; scopes: McpScope[]; devices: number }[]> {
  const { rows } = await q.query<GrantRow & { app_name: string }>(
    `select g.pseudonym_id, g.client_id, g.scopes, to_char(g.connected_on, 'YYYY-MM-DD') as connected_on, g.grant_id, c.app_name
       from mcp_grants g join mcp_clients c on c.client_id = g.client_id
      where g.pseudonym_id = $1
      order by g.connected_on desc, c.app_name`,
    [pseudonymId],
  );
  const apps = new Map<string, { clientId: string; appName: string; connectedOn: string; scopes: McpScope[]; devices: number }>();
  for (const r of rows) {
    const g = toGrant(r);
    const app = apps.get(g.clientId);
    if (!app) apps.set(g.clientId, { clientId: g.clientId, appName: r.app_name, connectedOn: g.connectedOn, scopes: g.scopes, devices: 1 });
    else {
      app.devices += 1;
      app.scopes = MCP_SCOPES.filter((s) => app.scopes.includes(s) || g.scopes.includes(s));
    }
  }
  return [...apps.values()];
}

export async function deleteGrant(q: Queryable, pseudonymId: string, clientId: string): Promise<number> {
  const { rows } = await q.query('delete from mcp_grants where pseudonym_id = $1 and client_id = $2 returning client_id', [pseudonymId, clientId]);
  return rows.length;
}

export async function deleteGrantsFor(q: Queryable, pseudonymId: string): Promise<number> {
  const { rows } = await q.query('delete from mcp_grants where pseudonym_id = $1 returning client_id', [pseudonymId]);
  return rows.length;
}

export async function deleteGrantById(q: Queryable, clientId: string, grantId: string): Promise<number> {
  const { rows } = await q.query('delete from mcp_grants where client_id = $1 and grant_id = $2 returning client_id', [clientId, grantId]);
  return rows.length;
}

// ── 운영자 관리(11/3, 1단계). 연결한 사람은 셈만 내보내요. 가명 ID는 접속기록(처리한 정보주체 표시)에만 가요. ──

export interface ClientOverview extends Omit<ClientRecord, 'secretHash'> {
  people: number;
  devices: number;
  /** YYYY-MM-DD */
  createdOn: string;
}

/** 등록 클라이언트 전부와 지금 연결한 사람·기기 수. 비밀 해시는 읽지 않아요. */
export async function listClientsOverview(q: Queryable): Promise<ClientOverview[]> {
  const { rows } = await q.query<Omit<ClientRow, 'client_secret_hash'> & { people: number; devices: number; created_on: string }>(
    `select c.client_id, c.public_client, c.app_name, c.redirect_uris, c.security_approved, c.demo_only,
            to_char(c.created_at, 'YYYY-MM-DD') as created_on,
            count(distinct g.pseudonym_id)::int as people, count(g.grant_id)::int as devices
       from mcp_clients c left join mcp_grants g on g.client_id = c.client_id
      group by c.client_id
      order by c.app_name, c.client_id`,
  );
  return rows.map((r) => ({
    clientId: r.client_id,
    publicClient: r.public_client,
    appName: r.app_name,
    redirectUris: r.redirect_uris,
    securityApproved: r.security_approved,
    demoOnly: r.demo_only,
    people: r.people,
    devices: r.devices,
    createdOn: r.created_on,
  }));
}

/** 보안팀 승인 켜기·끄기. 바뀐 줄이 없으면(없는 클라이언트) 거짓이에요. */
export async function setSecurityApproved(q: Queryable, clientId: string, approved: boolean): Promise<boolean> {
  const { rows } = await q.query('update mcp_clients set security_approved = $2 where client_id = $1 returning client_id', [clientId, approved]);
  return rows.length === 1;
}

/** 그 앱에 연결한 사람(가명 ID, 겹침 없이). 강제 끊기의 접속기록에만 써요. */
export async function peopleOfClient(q: Queryable, clientId: string): Promise<string[]> {
  const { rows } = await q.query<{ pseudonym_id: string }>('select distinct pseudonym_id from mcp_grants where client_id = $1 order by pseudonym_id', [
    clientId,
  ]);
  return rows.map((r) => r.pseudonym_id);
}

/** 그 앱의 모든 연결(모든 사람·기기)을 지워요. 지운 승인 수를 돌려줘요. */
export async function deleteGrantsOfClient(q: Queryable, clientId: string): Promise<number> {
  const { rows } = await q.query('delete from mcp_grants where client_id = $1 returning grant_id', [clientId]);
  return rows.length;
}

/** 클라이언트 회수. 승인은 외래 키(on delete cascade)로 같이 지워져요. */
export async function deleteClient(q: Queryable, clientId: string): Promise<boolean> {
  const { rows } = await q.query('delete from mcp_clients where client_id = $1 returning client_id', [clientId]);
  return rows.length === 1;
}

export interface ReportCounts {
  month: { connects: number; calls: number; callers: number; disconnects: number };
  recent: {
    toolCalls: Record<string, number>;
    consents: Record<string, number>;
    tokenRefused: number;
    blockedApps: number;
    leaverEnded: number;
  };
  now: { clients: number; approvedClients: number; people: number; devices: number };
}

/** 월간·주간 보고의 셈. 감사 로그·접속기록에서 동작·결과별 수만 세고 줄 내용은 읽지 않아요. */
export async function reportCounts(q: Queryable, monthFrom: number, recentFrom: number): Promise<ReportCounts> {
  const month = (
    await q.query<{ connects: number; calls: number; callers: number; disconnects: number }>(
      `select (count(*) filter (where action = 'mcp.connect'))::int as connects,
              (count(*) filter (where action = 'mcp.call'))::int as calls,
              (count(distinct pseudonym_id) filter (where action = 'mcp.call'))::int as callers,
              (count(*) filter (where action = 'mcp.disconnect'))::int as disconnects
         from access_log where at >= $1 and action like 'mcp.%'`,
      [new Date(monthFrom).toISOString()],
    )
  ).rows[0]!;
  const since = new Date(recentFrom).toISOString();
  const grouped = (
    await q.query<{ channel: string; action: string | null; is_tool: boolean; result: string; n: number }>(
      `select channel, action, tool is not null as is_tool, result, count(*)::int as n
         from audit_log where at >= $1 and channel in ('mcp', 'auth')
        group by channel, action, tool is not null, result`,
      [since],
    )
  ).rows;
  const sum = (pick: (r: (typeof grouped)[number]) => boolean) => grouped.filter(pick).reduce((n, r) => n + r.n, 0);
  const byResult = (pick: (r: (typeof grouped)[number]) => boolean) => {
    const out: Record<string, number> = {};
    for (const r of grouped.filter(pick)) out[r.result] = (out[r.result] ?? 0) + r.n;
    return out;
  };
  const now = (
    await q.query<{ clients: number; approved: number; people: number; devices: number }>(
      `select (select count(*) from mcp_clients)::int as clients,
              (select count(*) from mcp_clients where security_approved)::int as approved,
              (select count(distinct pseudonym_id) from mcp_grants)::int as people,
              (select count(*) from mcp_grants)::int as devices`,
    )
  ).rows[0]!;
  return {
    month,
    recent: {
      toolCalls: byResult((r) => r.channel === 'mcp' && r.is_tool),
      consents: byResult((r) => r.channel === 'mcp' && r.action === 'consent'),
      tokenRefused: sum((r) => r.channel === 'mcp' && r.action === 'token' && r.result === 'refused'),
      blockedApps: sum((r) => r.channel === 'mcp' && r.action === 'authorize' && r.result !== 'ok'),
      leaverEnded: sum((r) => r.channel === 'auth' && r.action === 'employment.recheck' && r.result === 'ended'),
    },
    now: { clients: now.clients, approvedClients: now.approved, people: now.people, devices: now.devices },
  };
}
