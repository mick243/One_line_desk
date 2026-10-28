import { isPantryStandalone, MODULES, type ModuleKind, type ModuleSwitch, RULES_VERSION } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AdapterCapabilities } from '../adapters/types';
import type { AppContext } from '../context';
import { DeskError } from '../core/errors';
import { type OpsFlag, OPS_VALUE_RANGE, type OpsValues } from '../core/ops-settings';
import { listMcpTools } from '../core/tool-registry';

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext, demoAdapters: () => AdapterCapabilities[]) {
  // 부하 분산기·배포가 보는 건강 확인. DB가 안 되면 503이라 그 서버로 요청을 보내지 않아요(L-17).
  app.get('/health', async (_req, reply) => {
    let db: 'connected' | 'error' = 'connected';
    try {
      await ctx.db.query('select 1');
    } catch {
      db = 'error';
    }
    if (db === 'error') reply.code(503);
    return { ok: db === 'connected', db: `${ctx.db.kind}-${db}`, ai: ctx.gateway.providerName, rulesVersion: RULES_VERSION };
  });

  // 로그인 전에도 띠와 탭 구성을 그리려고 공개해요. 운영 값(횟수 상한 등)은 넣지 않아요.
  app.get('/api/config/public', async () => {
    const s = ctx.ops.get();
    return {
      modules: s.modules,
      roomsWrite: s.roomsWrite,
      mcp: s.mcp,
      autoActions: s.autoActions,
      standalone: isPantryStandalone(s),
      demoData: demoAdapters()
        .filter((a) => a.mock)
        .map((a) => a.label),
      rulesVersion: RULES_VERSION,
      // 로그인 방식: 모의(가상 직원 고르기) 또는 IdP 리디렉트(임시 IdP·회사 IdP)
      login: ctx.adapters.idp.oidc ? { kind: 'oidc' as const, label: ctx.adapters.idp.oidc.label } : { kind: 'mock' as const },
      // 회의 초대에 쓸 수 있는 바깥 길(ADR-17)
      inviteChannels: { calendar: ctx.adapters.calendar.capabilities.label, slack: ctx.adapters.messenger.capabilities.label },
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

  app.put<{ Body: { flag: OpsFlag; value: boolean } }>(
    '/api/ops/flag',
    {
      preHandler: [ctx.guards.user, ctx.guards.role('operator')],
      schema: {
        body: {
          type: 'object',
          required: ['flag', 'value'],
          additionalProperties: false,
          properties: { flag: { enum: ['roomsWrite', 'mcp', 'autoActions'] }, value: { type: 'boolean' } },
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
  // 운영 값(재확인 간격·토큰 시간·분당 상한 등, CD-14). 범위를 벗어나면 하나도 바꾸지 않아요.
  const valueProps = Object.fromEntries(Object.entries(OPS_VALUE_RANGE).map(([k, [minimum, maximum]]) => [k, { type: 'integer', minimum, maximum }]));
  app.put<{ Body: Partial<OpsValues> }>(
    '/api/ops/values',
    {
      preHandler: [ctx.guards.user, ctx.guards.role('operator')],
      schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: valueProps } },
    },
    async (req) => ctx.ops.setValues(req.deskUser!.pseudonymId, req.body),
  );

  // "링크만"일 때 보내는 그룹웨어 주소(CD-4). https 주소만 받아요.
  app.put<{ Body: { module: ModuleKind; url: string } }>(
    '/api/ops/link',
    {
      preHandler: [ctx.guards.user, ctx.guards.role('operator')],
      schema: {
        body: {
          type: 'object',
          required: ['module', 'url'],
          additionalProperties: false,
          properties: { module: { enum: [...MODULES] }, url: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (req) => ctx.ops.setLink(req.deskUser!.pseudonymId, req.body.module, req.body.url),
  );
}
