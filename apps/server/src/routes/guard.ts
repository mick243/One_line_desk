import type { Role } from '@one-line-desk/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { computeRoles } from '../core/roles';
import type { DeskSession } from '../core/session';

export const SESSION_COOKIE = 'desk_sid';

declare module 'fastify' {
  interface FastifyRequest {
    deskSession?: DeskSession;
  }
}

/** 세션 확인 → 재직 재확인(간격이 지났을 때) → 쓰기 요청이면 CSRF 토큰 확인. */
export function sessionGuard(ctx: AppContext) {
  return async function requireSession(req: FastifyRequest, reply: FastifyReply) {
    const raw = req.cookies[SESSION_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : undefined;
    const session = unsigned?.valid ? ctx.sessions.get(unsigned.value ?? undefined) : undefined;
    if (!session) {
      return reply.code(401).send({ error: 'login-required', message: '보안을 위해 다시 로그인해 주세요' });
    }

    const recheckMs = ctx.ops.get().values.employmentRecheckSeconds * 1000;
    if (ctx.now() - session.lastEmploymentCheckAt >= recheckMs) {
      if (!(await ctx.adapters.idp.isActive(session.idpSubject))) {
        ctx.sessions.destroyAllFor(session.pseudonymId);
        ctx.audit.record({ pseudonymId: session.pseudonymId, channel: 'auth', action: 'employment.recheck', result: 'ended' });
        return reply.code(401).send({ error: 'login-required', message: '보안을 위해 다시 로그인해 주세요' });
      }
      session.lastEmploymentCheckAt = ctx.now();
    }

    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== session.csrfToken) {
      return reply.code(403).send({ error: 'csrf', message: '화면을 새로 고친 뒤 다시 해 주세요' });
    }
    req.deskSession = session;
  };
}

export async function rolesOf(ctx: AppContext, session: DeskSession): Promise<Role[]> {
  const profile = await ctx.adapters.directory.getProfile(session.idpSubject);
  if (!profile) return [];
  return computeRoles(profile, await ctx.adapters.directory.chartOwnerDepartments());
}
