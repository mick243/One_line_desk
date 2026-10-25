import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { pseudonymize } from '../core/pseudonym';
import { SESSION_MAX_AGE_MS } from '../core/session';
import { rolesOf, SESSION_COOKIE, sessionGuard } from './guard';

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  const requireSession = sessionGuard(ctx);

  // 모의 OIDC 고르기 목록. 실제 IdP로 바꾸면 이 경로 대신 리디렉트 로그인을 써요(1일 차 신청, 교체는 IdP 등록 뒤).
  app.get('/api/auth/mock-users', async (_req, reply) => {
    const choices = ctx.adapters.idp.loginChoices?.();
    if (!choices) return reply.code(404).send({ error: 'not-mock' });
    return choices.map(({ idpSubject, displayName, department, floor }) => ({ idpSubject, displayName, department, floor }));
  });

  app.post<{ Body: { idpSubject: string } }>(
    '/api/auth/login',
    { schema: { body: { type: 'object', required: ['idpSubject'], additionalProperties: false, properties: { idpSubject: { type: 'string', maxLength: 100 } } } } },
    async (req, reply) => {
      if (!ctx.adapters.idp.loginChoices) return reply.code(404).send({ error: 'not-mock' });
      const profile = await ctx.adapters.idp.authenticate(req.body.idpSubject);
      if (!profile) return reply.code(401).send({ error: 'login-failed', message: '로그인하지 못했어요' });

      const pseudonymId = pseudonymize(ctx.config.pseudonymSecret, profile.idpSubject);
      const session = ctx.sessions.create(profile.idpSubject, pseudonymId);
      ctx.audit.record({ pseudonymId, channel: 'auth', action: 'login', result: 'ok' });
      reply.setCookie(SESSION_COOKIE, session.id, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: ctx.config.production,
        signed: true,
        maxAge: SESSION_MAX_AGE_MS / 1000,
      });
      return { ok: true };
    },
  );

  app.get('/api/me', { preHandler: requireSession }, async (req) => {
    const session = req.deskSession!;
    const profile = await ctx.adapters.directory.getProfile(session.idpSubject);
    return {
      displayName: profile?.displayName ?? '',
      department: profile?.department ?? '',
      floor: profile?.floor ?? '',
      roles: await rolesOf(ctx, session),
      csrfToken: session.csrfToken,
    };
  });

  app.post('/api/auth/logout', { preHandler: requireSession }, async (req, reply) => {
    const session = req.deskSession!;
    ctx.sessions.destroy(session.id);
    ctx.audit.record({ pseudonymId: session.pseudonymId, channel: 'auth', action: 'logout', result: 'ok' });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // 모든 기기 로그아웃. MCP 인가 서버가 생기면(7~8일 차) 그 사람의 MCP 승인도 여기서 같이 폐기해요(ADR-15).
  app.post('/api/auth/logout-all', { preHandler: requireSession }, async (req, reply) => {
    const session = req.deskSession!;
    const count = ctx.sessions.destroyAllFor(session.pseudonymId);
    ctx.audit.record({ pseudonymId: session.pseudonymId, channel: 'auth', action: 'logout-all', result: `sessions:${count}` });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true, sessions: count };
  });
}
