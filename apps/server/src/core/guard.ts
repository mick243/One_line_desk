import type { Role } from '@one-line-desk/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext, PreHandler } from '../context';
import { computeRoles } from './roles';
import type { DeskSession } from './session';
import type { DeskUser } from './user';

export const SESSION_COOKIE = 'desk_sid';

declare module 'fastify' {
  interface FastifyRequest {
    deskUser?: DeskUser;
  }
  interface FastifyContextConfig {
    /** 사람이 쓴 게 아닌 반복 요청(알림 폴링 등). 쉬는 시간을 늘리지 않아요(ADR-20). */
    background?: boolean;
  }
}

const LOGIN_REQUIRED = { error: 'login-required', message: '보안을 위해 다시 로그인해 주세요' };
/** 쉬는 시간이 지나 끊겼을 때. 다음 회사 로그인은 IdP에 다시 인증을 요청해요(prompt=login). */
export const IDLE_ENDED = { error: 'login-required', reason: 'idle', message: '오래 쉬어서 보안을 위해 다시 로그인해 주세요' };

type GuardCtx = Omit<AppContext, 'guards'>;

// 쉬어서 끊긴 브라우저 표시(10/29 회의 A5). 화면 깃발(?reauth=idle)은 새로 고치면 사라져서, 서버가 서명 쿠키로 기억해요.
// 이 표시가 있으면 회사 로그인은 늘 다시 인증을 요청하고(prompt=login·max_age=0), 다시 인증한 로그인이 성공하면 지워요.
const REAUTH_MAX_AGE_S = 24 * 60 * 60;
const reauthCookie = (ctx: GuardCtx) => `${ctx.config.production ? '__Host-' : ''}desk_reauth`;
const reauthCookieOptions = (ctx: GuardCtx) => ({ path: '/', httpOnly: true, sameSite: 'lax' as const, secure: ctx.config.production, signed: true });

/** 이 브라우저가 쉬어서 끊긴 뒤 아직 다시 인증하지 않았는지 */
export function needsReauth(ctx: GuardCtx, req: FastifyRequest): boolean {
  const raw = req.cookies[reauthCookie(ctx)];
  return raw ? req.unsignCookie(raw).valid : false;
}

export function clearReauth(ctx: GuardCtx, reply: FastifyReply): void {
  reply.clearCookie(reauthCookie(ctx), reauthCookieOptions(ctx));
}

/** 세션 쿠키가 가리키는 세션. 없거나 서명이 틀리면 undefined예요. */
export function sessionOf(ctx: GuardCtx, req: FastifyRequest): DeskSession | undefined {
  const raw = req.cookies[SESSION_COOKIE];
  const unsigned = raw ? req.unsignCookie(raw) : undefined;
  return unsigned?.valid ? ctx.sessions.get(unsigned.value ?? undefined) : undefined;
}

/**
 * 일정 시간 쓰지 않았으면 세션을 끊고 다시 인증 표시를 남겨요(안전성 확보조치 기준 제6조④). 끊었으면 true예요.
 * 배경 요청만 오는 동안에도 시간은 흘러요.
 */
export async function endIfIdle(ctx: GuardCtx, session: DeskSession, reply: FastifyReply): Promise<boolean> {
  if (ctx.now() - session.lastActiveAt <= ctx.ops.get().values.idleTimeoutMinutes * 60_000) return false;
  ctx.sessions.destroy(session.id);
  await ctx.audit.record({ pseudonymId: session.pseudonymId, channel: 'auth', action: 'idle', result: 'ended' });
  reply.setCookie(reauthCookie(ctx), '1', { ...reauthCookieOptions(ctx), maxAge: REAUTH_MAX_AGE_S });
  return true;
}

/** 세션 확인 → 쉬는 시간 확인 → 재직 재확인(간격이 지났을 때) → 쓰기 요청이면 CSRF 토큰 확인 → 역할 계산(ADR-13·20, R17). */
export function createGuards(ctx: GuardCtx): AppContext['guards'] {
  const user: PreHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const session = sessionOf(ctx, req);
    // 새로 고쳐서 화면이 이유를 잊어도, 쉬어서 끊긴 브라우저면 같은 이유를 다시 알려 줘요.
    if (!session) return reply.code(401).send(needsReauth(ctx, req) ? IDLE_ENDED : LOGIN_REQUIRED);
    if (await endIfIdle(ctx, session, reply)) return reply.code(401).send(IDLE_ENDED);

    const recheckMs = ctx.ops.get().values.employmentRecheckSeconds * 1000;
    if (ctx.now() - session.lastEmploymentCheckAt >= recheckMs) {
      if (!(await ctx.adapters.idp.isActive(session.idpSubject))) {
        await endEverything(ctx, session.pseudonymId);
        await ctx.audit.record({ pseudonymId: session.pseudonymId, channel: 'auth', action: 'employment.recheck', result: 'ended' });
        return reply.code(401).send(LOGIN_REQUIRED);
      }
      session.lastEmploymentCheckAt = ctx.now();
    }

    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== session.csrfToken) {
      return reply.code(403).send({ error: 'csrf', message: '화면을 새로 고친 뒤 다시 해 주세요' });
    }

    const resolved = await resolveUser(ctx, session);
    if (!resolved) return reply.code(401).send(LOGIN_REQUIRED);
    // 배경 요청은 경로 설정(background) 또는 웹이 붙인 머리로 알아요. 머리를 붙이면 자기 세션만 빨리 끊겨서 속일 까닭이 없어요.
    if (!req.routeOptions.config.background && req.headers['x-desk-background'] !== '1') session.lastActiveAt = ctx.now();
    req.deskUser = resolved;
    return undefined;
  };

  return {
    user,
    role(role: Role): PreHandler {
      return async (req, reply) => {
        if (!req.deskUser?.roles.includes(role)) return reply.code(403).send({ error: 'forbidden', message: '이 일을 할 권한이 없어요' });
        return undefined;
      };
    },
  };
}

async function resolveUser(ctx: Omit<AppContext, 'guards'>, session: DeskSession): Promise<DeskUser | null> {
  const profile = await ctx.adapters.directory.getProfile(session.idpSubject);
  if (!profile) return null;
  const owners = ctx.services.navi ? await ctx.services.navi.ownerDepartments() : await ctx.adapters.directory.chartOwnerDepartments();
  return {
    sessionId: session.id,
    pseudonymId: session.pseudonymId,
    idpSubject: session.idpSubject,
    displayName: profile.displayName,
    department: profile.department,
    floor: profile.floor,
    roles: computeRoles(profile, owners),
    ...(profile.email ? { email: profile.email } : {}),
  };
}

/** 모든 기기 로그아웃·퇴사: 웹 세션과 MCP 승인을 모두 끊어요(ADR-13·15). */
export async function endEverything(ctx: Pick<AppContext, 'sessions' | 'services'>, pseudonymId: string): Promise<{ sessions: number; grants: number }> {
  const sessions = ctx.sessions.destroyAllFor(pseudonymId);
  const grants = ctx.services.mcp ? await ctx.services.mcp.revokeAll(pseudonymId) : 0;
  return { sessions, grants };
}
