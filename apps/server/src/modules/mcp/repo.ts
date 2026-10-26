import { MCP_SCOPES, type McpScope } from '@one-line-desk/shared';
import type { Queryable } from '../../core/db';

// MCP 인가 서버 표(ADR-15). SQL은 여기에만 둬요.
// - mcp_clients: 등록 클라이언트(동적 등록 없음)
// - mcp_grants: 승인(가명 ID·클라이언트·범위·연결한 날·갱신 토큰 해시·승인 ID). "마지막 사용"은 없어요.

export interface ClientRecord {
  clientId: string;
  secretHash: string;
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
  client_secret_hash: string;
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
    'select client_id, client_secret_hash, app_name, redirect_uris, security_approved, demo_only from mcp_clients where client_id = $1',
    [clientId],
  );
  return rows[0] ? toClient(rows[0]) : null;
}

/** 보안팀 승인 목록에 오른 클라이언트 수(계약 전 잠금 규칙에 써요). */
export async function countApprovedClients(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('select count(*)::int as n from mcp_clients where security_approved');
  return rows[0]?.n ?? 0;
}

/** 운영자 등록과 시연 seed가 써요. 이미 있으면 그대로 둬요. */
export async function insertClient(q: Queryable, c: ClientRecord): Promise<void> {
  await q.query(
    `insert into mcp_clients (client_id, client_secret_hash, app_name, redirect_uris, security_approved, demo_only)
     values ($1, $2, $3, $4, $5, $6) on conflict (client_id) do nothing`,
    [c.clientId, c.secretHash, c.appName, c.redirectUris, c.securityApproved, c.demoOnly],
  );
}

/** 인가 코드 교환 때 승인을 만들거나 새로 해요. 다시 연결하면 승인 ID와 연결한 날이 새로 바뀌어요. */
export async function upsertGrant(
  q: Queryable,
  g: { pseudonymId: string; clientId: string; scopes: McpScope[]; connectedOn: string; refreshTokenHash: string; grantId: string },
): Promise<void> {
  await q.query(
    `insert into mcp_grants (pseudonym_id, client_id, scopes, connected_on, refresh_token_hash, grant_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (pseudonym_id, client_id) do update
       set scopes = excluded.scopes, connected_on = excluded.connected_on,
           refresh_token_hash = excluded.refresh_token_hash, grant_id = excluded.grant_id`,
    [g.pseudonymId, g.clientId, g.scopes, g.connectedOn, g.refreshTokenHash, g.grantId],
  );
}

export async function findGrantByRefreshHash(q: Queryable, refreshTokenHash: string): Promise<GrantRecord | null> {
  const { rows } = await q.query<GrantRow>(`select ${GRANT_COLUMNS} from mcp_grants where refresh_token_hash = $1`, [refreshTokenHash]);
  return rows[0] ? toGrant(rows[0]) : null;
}

/** 갱신 토큰 회전. 그사이 다른 요청이 먼저 바꿨으면 거짓이에요(한 번만 이겨요). */
export async function rotateRefreshToken(q: Queryable, pseudonymId: string, clientId: string, oldHash: string, newHash: string): Promise<boolean> {
  const { rows } = await q.query<{ client_id: string }>(
    'update mcp_grants set refresh_token_hash = $4 where pseudonym_id = $1 and client_id = $2 and refresh_token_hash = $3 returning client_id',
    [pseudonymId, clientId, oldHash, newHash],
  );
  return rows.length === 1;
}

/** 접근 토큰 검사(요청마다): 그 승인이 아직 있는지 */
export async function grantExists(q: Queryable, pseudonymId: string, clientId: string, grantId: string): Promise<boolean> {
  const { rows } = await q.query('select 1 from mcp_grants where pseudonym_id = $1 and client_id = $2 and grant_id = $3', [pseudonymId, clientId, grantId]);
  return rows.length === 1;
}

/** S6 "연결된 AI 앱" */
export async function listGrantsWithApp(q: Queryable, pseudonymId: string): Promise<(GrantRecord & { appName: string })[]> {
  const { rows } = await q.query<GrantRow & { app_name: string }>(
    `select g.pseudonym_id, g.client_id, g.scopes, to_char(g.connected_on, 'YYYY-MM-DD') as connected_on, g.grant_id, c.app_name
       from mcp_grants g join mcp_clients c on c.client_id = g.client_id
      where g.pseudonym_id = $1
      order by g.connected_on desc, c.app_name`,
    [pseudonymId],
  );
  return rows.map((r) => ({ ...toGrant(r), appName: r.app_name }));
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
