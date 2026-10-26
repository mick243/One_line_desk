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
}

const LOGIN_REQUIRED = { error: 'login-required', message: '보안을 위해 다시 로그인해 주세요' };

/** 세션 확인 → 재직 재확인(간격이 지났을 때) → 쓰기 요청이면 CSRF 토큰 확인 → 역할 계산(ADR-13, R17). */
export function createGuards(ctx: Omit<AppContext, 'guards'>): AppContext['guards'] {
  const user: PreHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.cookies[SESSION_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : undefined;
    const session = unsigned?.valid ? ctx.sessions.get(unsigned.value ?? undefined) : undefined;
    if (!session) return reply.code(401).send(LOGIN_REQUIRED);

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
  };
}

/** 모든 기기 로그아웃·퇴사: 웹 세션과 MCP 승인을 모두 끊어요(ADR-13·15). */
export async function endEverything(ctx: Pick<AppContext, 'sessions' | 'services'>, pseudonymId: string): Promise<{ sessions: number; grants: number }> {
  const sessions = ctx.sessions.destroyAllFor(pseudonymId);
  const grants = ctx.services.mcp ? await ctx.services.mcp.revokeAll(pseudonymId) : 0;
  return { sessions, grants };
}
