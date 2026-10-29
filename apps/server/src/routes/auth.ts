import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EmployeeProfile, LoginEvidence } from '../adapters/types';
import type { ServerConfig } from '../config';
import type { AppContext } from '../context';
import { accessFrom } from '../core/access-record';
import { clearReauth, endEverything, endIfIdle, needsReauth, SESSION_COOKIE, sessionOf } from '../core/guard';
import { pseudonymize } from '../core/pseudonym';
import { computeRoles } from '../core/roles';
import { type LoginAssurance, SESSION_MAX_AGE_MS } from '../core/session';

const RETURN_BASE = 'http://return.invalid';

/**
 * 로그인 뒤 돌아갈 앱 안 주소. 우리 앱 경로만 받아요(다른 사이트로 보내지 않아요).
 * 브라우저는 주소를 풀 때 tab·줄바꿈을 지우고 `\`를 `/`로 읽어서 `/\t/evil.example`이 바깥 주소가 돼요(QA-1).
 * 그래서 눈에 보이는 ASCII만 받고, 풀어 본 주소가 같은 출처의 `/`로 시작할 때만 그 풀린 모양을 돌려줘요.
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1000 || !/^\/[!-~]*$/.test(value) || value.includes('\\')) return '/';
  const path = value.split(/[?#]/, 1)[0]!;
  if (path.startsWith('//') || /%(2f|5c)/i.test(path)) return '/';
  let url: URL;
  try {
    url = new URL(value, RETURN_BASE);
  } catch {
    return '/';
  }
  if (url.origin !== RETURN_BASE || url.pathname.startsWith('//') || url.pathname === '/api' || url.pathname.startsWith('/api/')) return '/';
  return url.pathname + url.search + url.hash;
}

const OIDC_PENDING_MS = 10 * 60_000;
/** 성공한 로그인의 state를 잠깐 기억해서 같은 쿠키로 다시 오면 막아요. 성공한 것만 들어가서 남이 채울 수 없어요. */
const USED_STATES_MAX = 10_000;
/** 다시 인증 확인(auth_time)에서 IdP와 서버 시계 차이를 이만큼 봐줘요. */
const CLOCK_SKEW_MS = 60_000;
const b64url = (n: number) => randomBytes(n).toString('base64url');

/** 로그인 시작 → 돌아오기 사이에 브라우저 쿠키에 묶어 두는 값(state·nonce·검증 값·돌아갈 곳·다시 인증·시작 시각) */
interface OidcPending {
  s: string;
  n: string;
  v: string;
  r: string;
  a: 0 | 1;
  t: number;
}

function isPending(x: unknown): x is OidcPending {
  const p = x as Partial<OidcPending> | null;
  return (
    !!p &&
    typeof p.s === 'string' &&
    typeof p.n === 'string' &&
    typeof p.v === 'string' &&
    typeof p.r === 'string' &&
    (p.a === 0 || p.a === 1) &&
    typeof p.t === 'number'
  );
}

/** IdP가 돌려준 오류 → 화면이 보여 줄 이유(Login.tsx). 모르는 오류는 "로그인하지 못했어요"예요. */
export function loginErrorReason(error: string): 'denied' | 'mfa-required' | 'idp-unreachable' | 'failed' {
  if (error === 'access_denied') return 'denied';
  if (error === 'unmet_authentication_requirements') return 'mfa-required';
  if (error === 'temporarily_unavailable' || error === 'server_error') return 'idp-unreachable';
  return 'failed';
}

/** ID 토큰 근거가 설정한 MFA 값 중 하나를 가졌는지(ADR-20) */
export function hasMfa(evidence: LoginEvidence, config: Pick<ServerConfig, 'mfaAmr' | 'mfaAcr'>): boolean {
  return evidence.amr.some((a) => config.mfaAmr.includes(a)) || (evidence.acr !== undefined && config.mfaAcr.includes(evidence.acr));
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  /** 확인된 직원으로 세션을 열어요(모의 로그인·IdP 로그인 같이 써요). */
  async function startSession(req: FastifyRequest, reply: FastifyReply, profile: EmployeeProfile, assurance: LoginAssurance = { mfa: false }): Promise<void> {
    const pseudonymId = pseudonymize(ctx.config.pseudonymSecret, profile.idpSubject);
    const session = ctx.sessions.create(profile.idpSubject, pseudonymId, assurance);
    await ctx.audit.record({ pseudonymId, channel: 'auth', action: 'login', result: assurance.mfa ? 'ok-mfa' : 'ok' });
    await ctx.access.record({ pseudonymId, action: 'login', ...accessFrom(req) });
    reply.setCookie(SESSION_COOKIE, session.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.production,
      signed: true,
      maxAge: SESSION_MAX_AGE_MS / 1000,
    });
    if (needsReauth(ctx, req)) clearReauth(ctx, reply);
  }

  // IdP 리디렉트 로그인(OIDC 인가 코드 + PKCE, 10/26 임시 IdP).
  // state·nonce·검증 값은 서버 메모리가 아니라 그 브라우저의 서명 쿠키에 10분만 둬요(10/28 망 회의 C-5).
  // 그래서 남이 시작한 로그인을 내 브라우저로 끝낼 수 없고(로그인 CSRF), 남이 시작을 많이 불러도 다른 사람 로그인이 지워지지 않아요.
  const redirectUri = () => `${ctx.config.publicBaseUrl}/api/auth/oidc/callback`;
  const pendingCookie = (state: string) => `${ctx.config.production ? '__Host-' : ''}desk_oidc_${state.slice(0, 8)}`;
  const pendingCookieOptions = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: ctx.config.production, signed: true };
  const usedStates = new Map<string, number>();

  function rememberUsed(state: string): void {
    const now = ctx.now();
    for (const [key, until] of usedStates) if (until < now) usedStates.delete(key);
    if (usedStates.size >= USED_STATES_MAX) usedStates.delete(usedStates.keys().next().value!);
    usedStates.set(state, now + OIDC_PENDING_MS);
  }

  app.get<{ Querystring: { return?: string; reauth?: string } }>('/api/auth/oidc/start', async (req, reply) => {
    const oidc = ctx.adapters.idp.oidc;
    if (!oidc) return reply.code(404).send({ error: 'no-idp', message: '회사 계정 로그인이 꺼져 있어요' });
    const state = b64url(24);
    const nonce = b64url(24);
    const verifier = b64url(48);
    // 쉬는 시간이 지나 끊긴 뒤에는 IdP에 지금 다시 인증해 달라고 해요(prompt=login, max_age=0).
    // 화면 깃발이 없어도(새로 고침, 주소를 직접 엶) 서버 표시나 아직 남은 쉰 세션을 보고 정해요(10/29 회의 A5).
    const stale = sessionOf(ctx, req);
    const endedNow = stale ? await endIfIdle(ctx, stale, reply) : false;
    const reauth = req.query.reauth === 'idle' || endedNow || needsReauth(ctx, req);
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    let url: string;
    try {
      url = await oidc.authorizationUrl({
        state,
        nonce,
        codeChallenge,
        redirectUri: redirectUri(),
        ...(reauth ? { prompt: 'login' as const, maxAge: 0 } : {}),
        ...(ctx.config.acrValues ? { acrValues: ctx.config.acrValues } : {}),
      });
    } catch {
      // 서버가 IdP에 닿지 못하면 JSON 대신 로그인 화면으로 이유와 함께 돌아가요(QA-40).
      req.log.warn({ msg: 'idp-unreachable', step: 'start' });
      return reply.redirect('/?login=idp-unreachable');
    }
    const pending: OidcPending = { s: state, n: nonce, v: verifier, r: safeReturnPath(req.query.return), a: reauth ? 1 : 0, t: ctx.now() };
    reply.setCookie(pendingCookie(state), JSON.stringify(pending), { ...pendingCookieOptions, maxAge: OIDC_PENDING_MS / 1000 });
    return reply.redirect(url);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/oidc/callback', async (req, reply) => {
    const oidc = ctx.adapters.idp.oidc;
    if (!oidc) return reply.code(404).send({ error: 'no-idp', message: '회사 계정 로그인이 꺼져 있어요' });
    const state = req.query.state ?? '';
    let p: OidcPending | null = null;
    if (state) {
      const raw = req.cookies[pendingCookie(state)];
      const unsigned = raw ? req.unsignCookie(raw) : undefined;
      try {
        const parsed: unknown = unsigned?.valid && unsigned.value ? JSON.parse(unsigned.value) : null;
        if (isPending(parsed)) p = parsed;
      } catch {
        p = null;
      }
      reply.clearCookie(pendingCookie(state), pendingCookieOptions);
    }
    if (req.query.error) return reply.redirect(`/?login=${loginErrorReason(req.query.error)}`);
    if (!p || p.s !== state || p.t + OIDC_PENDING_MS < ctx.now() || !req.query.code || usedStates.has(state)) return reply.redirect('/?login=failed');

    let result: Awaited<ReturnType<typeof oidc.finishLogin>>;
    try {
      result = await oidc.finishLogin({ code: req.query.code, codeVerifier: p.v, nonce: p.n, redirectUri: redirectUri() });
    } catch {
      req.log.warn({ msg: 'idp-unreachable', step: 'callback' });
      return reply.redirect('/?login=idp-unreachable');
    }
    if (!result) return reply.redirect('/?login=failed');
    rememberUsed(state);
    // 다시 인증을 요청하지 않고 시작한 로그인인데 그사이 쉬어서 끊겼으면, 다시 인증을 요청하며 처음부터 해요.
    if (p.a === 0 && needsReauth(ctx, req)) return reply.redirect(`/api/auth/oidc/start?reauth=idle&return=${encodeURIComponent(p.r)}`);
    const { profile, evidence } = result;
    // 다시 인증을 요청했으면 IdP가 지금 다시 인증했는지 봐요(auth_time). 근거가 없으면 받지 않아요.
    if (p.a === 1 && !(evidence.authTime !== undefined && evidence.authTime >= p.t - CLOCK_SKEW_MS)) return reply.redirect('/?login=failed');
    const mfa = hasMfa(evidence, ctx.config);
    if (ctx.config.requireMfa === 'always' && !mfa) {
      await ctx.audit.record({
        pseudonymId: pseudonymize(ctx.config.pseudonymSecret, profile.idpSubject),
        channel: 'auth',
        action: 'login',
        result: 'mfa-required',
      });
      return reply.redirect('/?login=mfa-required');
    }
    await startSession(req, reply, profile, { mfa, ...(evidence.authTime !== undefined ? { authTime: evidence.authTime } : {}) });
    return reply.redirect(p.r);
  });

  // 모의 OIDC 고르기 목록. 실제 IdP로 바꾸면 이 경로 대신 리디렉트 로그인을 써요(IdP 등록 뒤).
  app.get('/api/auth/mock-users', async (_req, reply) => {
    const choices = ctx.config.demo ? ctx.adapters.idp.loginChoices?.() : undefined;
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
      if (!ctx.adapters.idp.loginChoices || !ctx.config.demo) return reply.code(404).send({ error: 'not-mock', message: '모의 로그인이 꺼져 있어요' });
      const profile = await ctx.adapters.idp.authenticate(req.body.idpSubject);
      if (!profile) return reply.code(401).send({ error: 'login-failed', message: '로그인하지 못했어요' });
      await startSession(req, reply, profile);
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
    await ctx.access.record({ pseudonymId: user.pseudonymId, action: 'logout', ...accessFrom(req) });
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
    await ctx.access.record({ pseudonymId: user.pseudonymId, action: 'logout', ...accessFrom(req) });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true, ...ended };
  });
}
