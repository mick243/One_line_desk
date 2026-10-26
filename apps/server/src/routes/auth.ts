import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { EmployeeProfile } from '../adapters/types';
import type { AppContext } from '../context';
import { endEverything, SESSION_COOKIE } from '../core/guard';
import { pseudonymize } from '../core/pseudonym';
import { computeRoles } from '../core/roles';
import { SESSION_MAX_AGE_MS } from '../core/session';

/** 로그인 뒤 돌아갈 앱 안 주소. 우리 앱 경로만 받아요(다른 사이트로 보내지 않아요). */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.startsWith('/api/')) return '/';
  return value.length > 1000 ? '/' : value;
}

const OIDC_PENDING_MS = 10 * 60_000;
const OIDC_PENDING_MAX = 1000;
const b64url = (n: number) => randomBytes(n).toString('base64url');

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  /** 확인된 직원으로 세션을 열어요(모의 로그인·IdP 로그인 같이 써요). */
  async function startSession(reply: FastifyReply, profile: EmployeeProfile): Promise<void> {
    const pseudonymId = pseudonymize(ctx.config.pseudonymSecret, profile.idpSubject);
    const session = ctx.sessions.create(profile.idpSubject, pseudonymId);
    await ctx.audit.record({ pseudonymId, channel: 'auth', action: 'login', result: 'ok' });
    reply.setCookie(SESSION_COOKIE, session.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.production,
      signed: true,
      maxAge: SESSION_MAX_AGE_MS / 1000,
    });
  }

  // IdP 리디렉트 로그인(OIDC 인가 코드 + PKCE, 10/26 임시 IdP). state·nonce·검증 값은 서버 메모리에 10분만 둬요.
  const pending = new Map<string, { nonce: string; verifier: string; returnTo: string; until: number }>();
  const redirectUri = () => `${ctx.config.publicBaseUrl}/api/auth/oidc/callback`;

  app.get<{ Querystring: { return?: string } }>('/api/auth/oidc/start', async (req, reply) => {
    const oidc = ctx.adapters.idp.oidc;
    if (!oidc) return reply.code(404).send({ error: 'no-idp', message: '회사 계정 로그인이 꺼져 있어요' });
    const now = ctx.now();
    for (const [key, value] of pending) if (value.until < now) pending.delete(key);
    if (pending.size >= OIDC_PENDING_MAX) pending.clear();
    const state = b64url(24);
    const nonce = b64url(24);
    const verifier = b64url(48);
    pending.set(state, { nonce, verifier, returnTo: safeReturnPath(req.query.return), until: now + OIDC_PENDING_MS });
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    return reply.redirect(await oidc.authorizationUrl({ state, nonce, codeChallenge, redirectUri: redirectUri() }));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/oidc/callback', async (req, reply) => {
    const oidc = ctx.adapters.idp.oidc;
    if (!oidc) return reply.code(404).send({ error: 'no-idp', message: '회사 계정 로그인이 꺼져 있어요' });
    const state = req.query.state ?? '';
    const p = pending.get(state);
    pending.delete(state);
    if (!p || p.until < ctx.now() || !req.query.code) return reply.redirect('/?login=failed');
    const profile = await oidc.finishLogin({ code: req.query.code, codeVerifier: p.verifier, nonce: p.nonce, redirectUri: redirectUri() });
    if (!profile) return reply.redirect('/?login=failed');
    await startSession(reply, profile);
    return reply.redirect(p.returnTo);
  });

  // 모의 OIDC 고르기 목록. 실제 IdP로 바꾸면 이 경로 대신 리디렉트 로그인을 써요(IdP 등록 뒤).
  app.get('/api/auth/mock-users', async (_req, reply) => {
    const choices = ctx.config.mockLogin ? ctx.adapters.idp.loginChoices?.() : undefined;
    if (!choices) return reply.code(404).send({ error: 'not-mock', message: '모의 로그인이 꺼져 있어요' });
    // 처음 쓰는 사람이 누구를 고를지 알 수 있게 역할도 같이 알려 줘요(가상 직원 목록에서만).
    const owners = ctx.services.navi ? await ctx.services.navi.ownerDepartments() : await ctx.adapters.directory.chartOwnerDepartments();
    return choices.map((p) => ({
      idpSubject: p.idpSubject,
      displayName: p.displayName,
      department: p.department,
      floor: p.floor,
      roles: computeRoles(p, owners),
    }));
  });

  app.post<{ Body: { idpSubject: string } }>(
    '/api/auth/login',
    {
      schema: {
        body: { type: 'object', required: ['idpSubject'], additionalProperties: false, properties: { idpSubject: { type: 'string', maxLength: 100 } } },
      },
    },
    async (req, reply) => {
      if (!ctx.adapters.idp.loginChoices || !ctx.config.mockLogin) return reply.code(404).send({ error: 'not-mock', message: '모의 로그인이 꺼져 있어요' });
      const profile = await ctx.adapters.idp.authenticate(req.body.idpSubject);
      if (!profile) return reply.code(401).send({ error: 'login-failed', message: '로그인하지 못했어요' });
      await startSession(reply, profile);
      return { ok: true };
    },
  );

  app.get('/api/me', { preHandler: ctx.guards.user }, async (req) => {
    const user = req.deskUser!;
    const session = ctx.sessions.get(user.sessionId)!;
    return {
      displayName: user.displayName,
      department: user.department,
      floor: user.floor,
      roles: user.roles,
      csrfToken: session.csrfToken,
    };
  });

  app.post('/api/auth/logout', { preHandler: ctx.guards.user }, async (req, reply) => {
    const user = req.deskUser!;
    ctx.sessions.destroy(user.sessionId);
    await ctx.audit.record({ pseudonymId: user.pseudonymId, channel: 'auth', action: 'logout', result: 'ok' });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // 모든 기기 로그아웃: 웹 세션과 MCP 승인(갱신 토큰)을 모두 지워요(ADR-13·15). 확인 시트는 화면이 띄워요.
  app.post('/api/auth/logout-all', { preHandler: ctx.guards.user }, async (req, reply) => {
    const user = req.deskUser!;
    const ended = await endEverything(ctx, user.pseudonymId);
    await ctx.audit.record({
      pseudonymId: user.pseudonymId,
      channel: 'auth',
      action: 'logout-all',
      result: `sessions:${ended.sessions},grants:${ended.grants}`,
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true, ...ended };
  });
}
