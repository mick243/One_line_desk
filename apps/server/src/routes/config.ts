import { isPantryStandalone, MODULES, type ModuleKind, type ModuleSwitch, RULES_VERSION } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AdapterCapabilities } from '../adapters/types';
import type { AppContext } from '../context';
import { DeskError } from '../core/errors';
import { listMcpTools } from '../core/tool-registry';

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext, demoAdapters: () => AdapterCapabilities[]) {
  app.get('/health', async () => {
    let db: 'connected' | 'error' = 'connected';
    try {
      await ctx.db.query('select 1');
    } catch {
      db = 'error';
    }
    return { ok: db === 'connected', db: `${ctx.db.kind}-${db}`, ai: ctx.gateway.providerName, rulesVersion: RULES_VERSION };
  });

  // 로그인 전에도 띠와 탭 구성을 그리려고 공개해요. 운영 값(횟수 상한 등)은 넣지 않아요.
  app.get('/api/config/public', async () => {
    const s = ctx.ops.get();
    return {
      modules: s.modules,
      roomsWrite: s.roomsWrite,
      mcp: s.mcp,
      standalone: isPantryStandalone(s),
      demoData: demoAdapters()
        .filter((a) => a.mock)
        .map((a) => a.label),
      rulesVersion: RULES_VERSION,
    };
  });

  // 운영 설정·운영 표는 운영자만 봐요. 운영자 전용 화면은 S1~S6에 없어요(R7).
  app.get('/api/ops/settings', { preHandler: [ctx.guards.user, ctx.guards.role('operator')] }, async () => {
    const s = ctx.ops.get();
    return { ...s, mcpTools: listMcpTools(s).map((t) => t.name), aiUsage: await ctx.gateway.usageByModule(), recentAudit: await ctx.audit.recent(20) };
  });

  app.put<{ Body: { module: ModuleKind; value: ModuleSwitch } }>(
    '/api/ops/switch',
    {
      preHandler: [ctx.guards.user, ctx.guards.role('operator')],
      schema: {
        body: {
          type: 'object',
          required: ['module', 'value'],
          additionalProperties: false,
          properties: { module: { enum: [...MODULES] }, value: { enum: ['on', 'link', 'off'] } },
        },
      },
    },
    async (req) => ctx.ops.setModule(req.deskUser!.pseudonymId, req.body.module, req.body.value),
  );

  app.put<{ Body: { flag: 'roomsWrite' | 'mcp'; value: boolean } }>(
    '/api/ops/flag',
    {
      preHandler: [ctx.guards.user, ctx.guards.role('operator')],
      schema: {
        body: {
          type: 'object',
          required: ['flag', 'value'],
          additionalProperties: false,
          properties: { flag: { enum: ['roomsWrite', 'mcp'] }, value: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      if (req.body.flag === 'mcp' && req.body.value && !(await ctx.services.mcp?.canEnable())) {
        throw new DeskError('mcp-not-allowed', 409, '실제 데이터인데 보안팀이 승인한 앱이 없어서 MCP를 켤 수 없어요');
      }
      return ctx.ops.setFlag(req.deskUser!.pseudonymId, req.body.flag, req.body.value);
    },
  );
}
