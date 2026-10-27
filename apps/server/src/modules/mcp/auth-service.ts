import { randomUUID } from 'node:crypto';
import { kstDate, MCP_SCOPES, type McpScope } from '@one-line-desk/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { endEverything } from '../../core/guard';
import { pseudonymize } from '../../core/pseudonym';
import type { ToolDef } from '../../core/tool-registry';
import { availableTools, canRunMcp, isAllMockData, isClientAllowed } from './policy';
import * as repo from './repo';
import { pkceMatches, randomToken, TOKEN_PREFIX, TokenKit } from './tokens';

// MCP 인가 서버의 상태와 규칙(ADR-15). HTTP 모양은 oauth-routes.ts·mcp-route.ts가 맡아요.
// - 인가 코드: 서버 메모리, 60초, 한 번만 써요.
// - 접근 토큰: 짧게(재확인 간격의 절반, 최대 5분). aud = MCP 주소. 요청마다 승인이 남아 있는지 봐요.
// - 갱신 토큰: 쓸 때마다 바꾸고, 갱신마다 재직을 다시 확인해요. 재확인 결과는 "간격 − 접근 토큰 수명" 동안만 재사용해서
//   퇴사 뒤 늦어도 재확인 간격 안에 호출·갱신이 모두 막혀요(ADR-13).
// - 갱신 토큰 안에는 IdP 식별자를 봉인해 둬요. DB에는 가명 ID와 해시만 남아요.

export const AUTH_CODE_TTL_MS = 60_000;
export const CONSENT_REQUEST_TTL_MS = 10 * 60_000;
const ACCESS_TOKEN_MAX_SECONDS = 300;

export function mcpUrls(publicBaseUrl: string) {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return {
    issuer: base,
    resource: `${base}/mcp`,
    resourceMetadata: `${base}/.well-known/oauth-protected-resource/mcp`,
    authorize: `${base}/oauth/authorize`,
    token: `${base}/oauth/token`,
    revoke: `${base}/oauth/revoke`,
    consent: `${base}/oauth/consent`,
  };
}
export type McpUrls = ReturnType<typeof mcpUrls>;

const scopeSchema = z.enum(MCP_SCOPES);

/** /oauth/authorize에서 검사를 마친 요청. 동의 시트 주소에 봉인해서 실어요(서버 상태 없음). */
const consentRequestSchema = z.object({
  cid: z.string(),
  ru: z.string(),
  cc: z.string(),
  sc: z.array(scopeSchema).nullable(),
  st: z.string().optional(),
  rs: z.string(),
  exp: z.number(),
});
export type ConsentRequest = z.infer<typeof consentRequestSchema>;

const accessPayloadSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string(),
  cid: z.string(),
  scope: z.array(scopeSchema),
  gid: z.string(),
  iat: z.number(),
  exp: z.number(),
});
export type AccessPayload = z.infer<typeof accessPayloadSchema>;

const refreshPayloadSchema = z.object({ sub: z.string(), cid: z.string(), n: z.string() });

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: McpScope[];
  pseudonymId: string;
  idpSubject: string;
  exp: number;
}

export interface McpPrincipal {
  pseudonymId: string;
  clientId: string;
  scopes: McpScope[];
  grantId: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export type OAuthResult = { ok: true; body: TokenResponse } | { ok: false; status: 400 | 401; error: string; description: string };

const fail = (error: string, description: string, status: 400 | 401 = 400): OAuthResult => ({ ok: false, status, error, description });

export class McpAuth {
  readonly urls: McpUrls;
  readonly tokens: TokenKit;
  private readonly codes = new Map<string, PendingCode>();
  /** 가명 ID → 마지막으로 재직을 확인한 시각. 서버 메모리에만 있어요. */
  private readonly employmentConfirmedAt = new Map<string, number>();

  constructor(private readonly ctx: AppContext) {
    this.urls = mcpUrls(ctx.config.publicBaseUrl);
    // MCP 전용 비밀(MCP_TOKEN_SECRET)에서 용도별 키를 뽑아 써요(HKDF, tokens.ts).
    this.tokens = new TokenKit(ctx.config.mcpTokenSecret);
  }

  // ── 정책 ─────────────────────────────────────────────

  /** 모의 자료로만 도는 시연인지. 운영(시연 배포 아님)에서는 늘 거짓이라 시연 클라이언트가 허용 목록에 들지 않아요(L-16). */
  allMockData(): boolean {
    return this.ctx.config.demo && isAllMockData(this.ctx.dataAdapters());
  }

  isClientAllowed(client: repo.ClientRecord): boolean {
    return isClientAllowed(client, this.allMockData());
  }

  async runnable(): Promise<boolean> {
    return this.ctx.ops.get().mcp && (await this.canEnable());
  }

  /** 스위치를 켜도 되는지. 실제 데이터인데 보안팀 승인 앱이 없으면 거짓이에요(ADR-12·15). */
  async canEnable(): Promise<boolean> {
    return canRunMcp({ switchOn: true, allMockData: this.allMockData(), approvedClients: await repo.countApprovedClients(this.ctx.db) });
  }

  async tools(): Promise<ToolDef[]> {
    return availableTools(this.ctx.ops.get(), await this.runnable());
  }

  // ── 수명 ─────────────────────────────────────────────

  accessTtlMs(): number {
    const recheck = this.ctx.ops.get().values.employmentRecheckSeconds;
    return Math.max(1, Math.min(ACCESS_TOKEN_MAX_SECONDS, Math.floor(recheck / 2))) * 1000;
  }

  /** 재직 확인 결과를 재사용하는 시간. 접근 토큰 수명과 더해 재확인 간격을 넘지 않아요. */
  employmentReuseMs(): number {
    return Math.max(0, this.ctx.ops.get().values.employmentRecheckSeconds * 1000 - this.accessTtlMs());
  }

  // ── 동의 요청 ─────────────────────────────────────────

  sealConsentRequest(r: Omit<ConsentRequest, 'exp'>): string {
    return this.tokens.seal('request', { ...r, exp: this.ctx.now() + CONSENT_REQUEST_TTL_MS });
  }

  openConsentRequest(token: string): { ok: true; request: ConsentRequest } | { ok: false; reason: 'invalid' | 'expired' } {
    const parsed = consentRequestSchema.safeParse(this.tokens.open('request', token));
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    if (this.ctx.now() > parsed.data.exp) return { ok: false, reason: 'expired' };
    return { ok: true, request: parsed.data };
  }

  /** [연결 허락] 뒤 짧은 인가 코드를 줘요. DB에는 쓰지 않아요. */
  issueCode(request: ConsentRequest, user: { pseudonymId: string; idpSubject: string }, scopes: McpScope[]): string {
    this.sweepCodes();
    const code = randomToken(32);
    this.codes.set(code, {
      clientId: request.cid,
      redirectUri: request.ru,
      codeChallenge: request.cc,
      resource: request.rs,
      scopes,
      pseudonymId: user.pseudonymId,
      idpSubject: user.idpSubject,
      exp: this.ctx.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  // ── 토큰 발급 ─────────────────────────────────────────

  async exchangeCode(client: repo.ClientRecord, p: { code?: string; redirectUri?: string; codeVerifier?: string; resource?: string }): Promise<OAuthResult> {
    if (!p.code) return fail('invalid_request', 'code is required');
    // 코드는 처음 보는 순간 지워요. 실패해도 다시 쓸 수 없어요.
    const pending = this.codes.get(p.code);
    this.codes.delete(p.code);
    if (!pending || pending.exp < this.ctx.now() || pending.clientId !== client.clientId) return fail('invalid_grant', 'invalid or expired code');
    if (p.redirectUri !== pending.redirectUri) return fail('invalid_grant', 'redirect_uri does not match');
    if (!p.codeVerifier) return fail('invalid_request', 'code_verifier is required (PKCE S256)');
    if (!pkceMatches(p.codeVerifier, pending.codeChallenge)) return fail('invalid_grant', 'PKCE verification failed');
    if (!p.resource) return fail('invalid_request', 'resource is required');
    if (p.resource !== this.urls.resource || p.resource !== pending.resource) return fail('invalid_target', 'resource is not this MCP server');
    if (!this.isClientAllowed(client)) return fail('unauthorized_client', 'client is not allowed');
    if (!(await this.runnable())) return fail('invalid_grant', 'MCP is not available');
    if (!(await this.confirmEmployment(pending.pseudonymId, pending.idpSubject))) return fail('invalid_grant', 'account is not active');

    const grantId = randomUUID();
    const refreshToken = this.newRefreshToken(pending.idpSubject, client.clientId);
    await repo.upsertGrant(this.ctx.db, {
      pseudonymId: pending.pseudonymId,
      clientId: client.clientId,
      scopes: pending.scopes,
      connectedOn: kstDate(this.ctx.now()),
      refreshTokenHash: this.tokens.hash(refreshToken),
      grantId,
    });
    await this.ctx.audit.record({ pseudonymId: pending.pseudonymId, channel: 'mcp', action: 'token', clientId: client.clientId, result: 'issued' });
    return {
      ok: true,
      body: this.tokenResponse({ pseudonymId: pending.pseudonymId, clientId: client.clientId, scopes: pending.scopes, grantId }, refreshToken),
    };
  }

  async refresh(client: repo.ClientRecord, p: { refreshToken?: string; scope?: string; resource?: string }): Promise<OAuthResult> {
    if (!p.refreshToken) return fail('invalid_request', 'refresh_token is required');
    const payload = refreshPayloadSchema.safeParse(this.tokens.open('refresh', p.refreshToken));
    if (!payload.success || payload.data.cid !== client.clientId) return fail('invalid_grant', 'invalid refresh token');
    const oldHash = this.tokens.hash(p.refreshToken);
    const grant = await repo.findGrantByRefreshHash(this.ctx.db, oldHash);
    // 끊기·모든 기기 로그아웃·퇴사 뒤에는 승인이 없어서 여기서 막혀요. 회전된 옛 토큰도 여기서 막혀요.
    if (!grant || grant.clientId !== client.clientId) return fail('invalid_grant', 'refresh token is revoked');
    if (pseudonymize(this.ctx.config.pseudonymSecret, payload.data.sub) !== grant.pseudonymId) return fail('invalid_grant', 'invalid refresh token');
    if (p.resource !== undefined && p.resource !== this.urls.resource) return fail('invalid_target', 'resource is not this MCP server');

    let scopes = grant.scopes;
    if (p.scope !== undefined) {
      const asked = p.scope.split(' ').filter(Boolean);
      if (!asked.every((s) => (grant.scopes as string[]).includes(s))) return fail('invalid_scope', 'scope exceeds the grant');
      scopes = grant.scopes.filter((s) => asked.includes(s));
    }

    const deny = async (description: string) => {
      await this.ctx.audit.record({ pseudonymId: grant.pseudonymId, channel: 'mcp', action: 'token', clientId: client.clientId, result: 'refused' });
      return fail('invalid_grant', description);
    };
    if (!this.isClientAllowed(client)) return deny('client is not allowed');
    if (!(await this.confirmEmployment(grant.pseudonymId, payload.data.sub))) return deny('account is not active');

    const refreshToken = this.newRefreshToken(payload.data.sub, client.clientId);
    if (!(await repo.rotateRefreshToken(this.ctx.db, grant.pseudonymId, client.clientId, oldHash, this.tokens.hash(refreshToken)))) {
      return deny('refresh token is revoked');
    }
    await this.ctx.audit.record({ pseudonymId: grant.pseudonymId, channel: 'mcp', action: 'token', clientId: client.clientId, result: 'refreshed' });
    return { ok: true, body: this.tokenResponse({ pseudonymId: grant.pseudonymId, clientId: client.clientId, scopes, grantId: grant.grantId }, refreshToken) };
  }

  /** RFC 7009. 갱신 토큰이든 접근 토큰이든 그 승인을 지워요. 모르는 토큰도 성공으로 답해요. */
  async revoke(client: repo.ClientRecord, token: string): Promise<void> {
    if (token.startsWith(TOKEN_PREFIX.refresh)) {
      const grant = await repo.findGrantByRefreshHash(this.ctx.db, this.tokens.hash(token));
      if (grant && grant.clientId === client.clientId) {
        await repo.deleteGrant(this.ctx.db, grant.pseudonymId, client.clientId);
        await this.ctx.audit.record({ pseudonymId: grant.pseudonymId, channel: 'mcp', action: 'revoke', clientId: client.clientId, result: 'done' });
      }
      return;
    }
    const access = accessPayloadSchema.safeParse(this.tokens.open('access', token));
    if (access.success && access.data.cid === client.clientId && (await repo.deleteGrantById(this.ctx.db, client.clientId, access.data.gid)) > 0) {
      await this.ctx.audit.record({ pseudonymId: access.data.sub, channel: 'mcp', action: 'revoke', clientId: client.clientId, result: 'done' });
    }
  }

  /** 시험이 aud·만료를 바꾼 토큰을 만들 때도 써요. */
  sealAccessToken(payload: AccessPayload): string {
    return this.tokens.seal('access', payload);
  }

  // ── 자원 서버 검사 ─────────────────────────────────────

  /** Authorization 머리를 검사해요. 자격이 없으면 error 없이, 맞지 않으면 invalid_token이에요. */
  async authenticate(header: string | undefined): Promise<{ ok: true; principal: McpPrincipal } | { ok: false; error?: 'invalid_token' }> {
    const match = header?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
    if (!match) return header ? { ok: false, error: 'invalid_token' } : { ok: false };
    const parsed = accessPayloadSchema.safeParse(this.tokens.open('access', match[1]!));
    if (!parsed.success) return { ok: false, error: 'invalid_token' };
    const t = parsed.data;
    // 다른 대상(aud)·다른 발급자의 토큰은 받지도, 넘기지도 않아요.
    if (t.iss !== this.urls.issuer || t.aud !== this.urls.resource || t.exp <= this.ctx.now()) return { ok: false, error: 'invalid_token' };
    if (!(await repo.grantExists(this.ctx.db, t.sub, t.cid, t.gid))) return { ok: false, error: 'invalid_token' };
    const client = await repo.findClient(this.ctx.db, t.cid);
    if (!client || !this.isClientAllowed(client)) return { ok: false, error: 'invalid_token' };
    return { ok: true, principal: { pseudonymId: t.sub, clientId: t.cid, scopes: t.scope, grantId: t.gid } };
  }

  // ── 재직·폐기 ─────────────────────────────────────────

  /** 재직 확인. 재직이 아니면 웹 세션과 MCP 승인을 모두 지워요(ADR-13·15). */
  async confirmEmployment(pseudonymId: string, idpSubject: string): Promise<boolean> {
    const at = this.employmentConfirmedAt.get(pseudonymId);
    if (at !== undefined && this.ctx.now() - at < this.employmentReuseMs()) return true;
    if (await this.ctx.adapters.idp.isActive(idpSubject)) {
      this.employmentConfirmedAt.set(pseudonymId, this.ctx.now());
      return true;
    }
    await endEverything(this.ctx, pseudonymId);
    await this.ctx.audit.record({ pseudonymId, channel: 'auth', action: 'employment.recheck', result: 'ended' });
    return false;
  }

  /** 모든 기기 로그아웃·퇴사 확인(core/guard.ts endEverything)이 불러요. */
  async revokeAll(pseudonymId: string): Promise<number> {
    this.employmentConfirmedAt.delete(pseudonymId);
    for (const [code, pending] of this.codes) if (pending.pseudonymId === pseudonymId) this.codes.delete(code);
    return repo.deleteGrantsFor(this.ctx.db, pseudonymId);
  }

  // ── 안쪽 ─────────────────────────────────────────────

  private newRefreshToken(idpSubject: string, clientId: string): string {
    return this.tokens.seal('refresh', { sub: idpSubject, cid: clientId, n: randomToken(16) });
  }

  private tokenResponse(principal: McpPrincipal, refreshToken: string): TokenResponse {
    const now = this.ctx.now();
    const ttl = this.accessTtlMs();
    const access = this.sealAccessToken({
      iss: this.urls.issuer,
      aud: this.urls.resource,
      sub: principal.pseudonymId,
      cid: principal.clientId,
      scope: principal.scopes,
      gid: principal.grantId,
      iat: now,
      exp: now + ttl,
    });
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ttl / 1000), refresh_token: refreshToken, scope: principal.scopes.join(' ') };
  }

  private sweepCodes(): void {
    const now = this.ctx.now();
    for (const [code, pending] of this.codes) if (pending.exp < now) this.codes.delete(code);
  }
}
