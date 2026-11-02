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
