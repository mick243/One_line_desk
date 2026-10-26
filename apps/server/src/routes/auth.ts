import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { endEverything, SESSION_COOKIE } from '../core/guard';
import { pseudonymize } from '../core/pseudonym';
import { SESSION_MAX_AGE_MS } from '../core/session';

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  // 모의 OIDC 고르기 목록. 실제 IdP로 바꾸면 이 경로 대신 리디렉트 로그인을 써요(IdP 등록 뒤).
  app.get('/api/auth/mock-users', async (_req, reply) => {
    const choices = ctx.config.mockLogin ? ctx.adapters.idp.loginChoices?.() : undefined;
    if (!choices) return reply.code(404).send({ error: 'not-mock', message: '모의 로그인이 꺼져 있어요' });
    return choices.map(({ idpSubject, displayName, department, floor }) => ({ idpSubject, displayName, department, floor }));
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
