import { isPantryStandalone, MODULES, RULES_VERSION, type ModuleKind, type ModuleSwitch } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { dbStatus } from '../db/pool';
import { listMcpTools } from '../core/tool-registry';
import { rolesOf, sessionGuard } from './guard';

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext) {
  const requireSession = sessionGuard(ctx);

  app.get('/health', async () => ({ ok: true, db: await dbStatus(ctx.pool), rulesVersion: RULES_VERSION }));

  // 로그인 전에도 띠와 탭 구성을 그리려고 공개해요. 운영 값(횟수 상한 등)은 넣지 않아요.
  app.get('/api/config/public', async () => {
    const s = ctx.ops.get();
    return {
      modules: s.modules,
      roomsWrite: s.roomsWrite,
      standalone: isPantryStandalone(s),
      demoData: ctx.adapters.all().filter((a) => a.mock).map((a) => a.label),
      rulesVersion: RULES_VERSION,
    };
  });

  // 운영 설정은 운영자만 봐요. 운영자 전용 화면은 S1~S6에 없어요(R7).
  app.get('/api/ops/settings', { preHandler: requireSession }, async (req, reply) => {
    if (!(await rolesOf(ctx, req.deskSession!)).includes('operator')) return reply.code(403).send({ error: 'forbidden' });
    const s = ctx.ops.get();
    return { ...s, mcpTools: listMcpTools(s).map((t) => t.name), recentAudit: ctx.audit.recent(20) };
  });

  app.put<{ Body: { module: ModuleKind; value: ModuleSwitch } }>(
    '/api/ops/switch',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['module', 'value'],
          additionalProperties: false,
          properties: { module: { enum: [...MODULES] }, value: { enum: ['on', 'link', 'off'] } },
        },
      },
    },
    async (req, reply) => {
      const session = req.deskSession!;
      if (!(await rolesOf(ctx, session)).includes('operator')) return reply.code(403).send({ error: 'forbidden' });
      return ctx.ops.setModule(session.pseudonymId, req.body.module, req.body.value);
    },
  );
}
