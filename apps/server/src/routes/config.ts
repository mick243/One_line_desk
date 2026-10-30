import { isPantryStandalone, MODULES, type ModuleKind, type ModuleSwitch, RULES_VERSION } from '@one-line-desk/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdapterCapabilities } from '../adapters/types';
import type { AppContext, PreHandler } from '../context';
import { DeskError } from '../core/errors';
import { type OpsFlag, OPS_VALUE_RANGE, type OpsValues } from '../core/ops-settings';
import { listMcpTools } from '../core/tool-registry';

const READY_DB_TIMEOUT_MS = 1000;

/**
 * 건강 확인(L-17, 10/29 배포 준비 회의 A5). 관문 밖에는 열지 않아요(부하 분산기만).
 * - /health/live: 살아 있음. DB를 보지 않아서, DB가 잠깐 흔들려도 재시작(= 메모리 세션을 잃어 모두 로그아웃)이 이어지지 않아요.
 * - /health/ready(= /health): 받을 준비. DB(1초)와 첫 보관 회차를 봐요. 닫는 중에는 Fastify가 503으로 답해요.
 * 안쪽 정보(AI 공급자 이름 등)는 내보내지 않고, 떠 있는 판(build)과 보관 지우기가 마지막으로 다 된 시각만 알려요.
 * 마지막 성공이 오래돼도 503으로 바꾸지 않아요(재시작이 이어지면 메모리 세션을 잃어요). 감시가 시각을 보고 알려요.
 */
export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext, retentionState: () => { done: boolean; lastOk: number | null }) {
  app.get('/health/live', async () => ({ ok: true }));

  const ready = async (_req: FastifyRequest, reply: FastifyReply) => {
    const dbOk = await Promise.race([
      ctx.db.query('select 1').then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), READY_DB_TIMEOUT_MS).unref()),
    ]);
    const retention = retentionState();
    const ok = dbOk && retention.done;
    if (!ok) reply.code(503);
    return {
      ok,
      db: `${ctx.db.kind}-${dbOk ? 'connected' : 'error'}`,
      retention: retention.done ? 'done' : 'pending',
      retentionLastOk: retention.lastOk === null ? null : new Date(retention.lastOk).toISOString(),
      build: ctx.config.build,
      rulesVersion: RULES_VERSION,
    };
  };
  app.get('/health/ready', ready);
  app.get('/health', ready);
}

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext, demoAdapters: () => AdapterCapabilities[]) {
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
      // password: 시연 비밀번호를 받아야 하는지(값은 내보내지 않아요)
      login: ctx.adapters.idp.oidc
        ? { kind: 'oidc' as const, label: ctx.adapters.idp.oidc.label }
        : { kind: 'mock' as const, password: ctx.config.demoPassword !== undefined },
      // 회의 초대에 쓸 수 있는 바깥 길(ADR-17)
      inviteChannels: { calendar: ctx.adapters.calendar.capabilities.label, slack: ctx.adapters.messenger.capabilities.label },
    };
  });

  // 운영 설정·운영 표는 운영자만 봐요. 운영자 전용 화면은 S1~S6에 없어요(R7).
  app.get('/api/ops/settings', { preHandler: [ctx.guards.user, ctx.guards.role('operator')] }, async () => {
    const s = ctx.ops.get();
    return { ...s, mcpTools: listMcpTools(s).map((t) => t.name), aiUsage: await ctx.gateway.usageByModule(), recentAudit: await ctx.audit.recent(20) };
  });

  // 운영 설정 바꾸기. 명단 밖으로 넓힌 시연은 누구나 가상 운영자로 들어와서 바꾸지 못하게 막아요(배포 준비 회의 쟁점 5).
  const demoWideLock: PreHandler = async (_req, reply) => {
    if (ctx.config.demoWide) return reply.code(403).send({ error: 'demo-locked', message: '넓게 연 시연에서는 운영 설정을 바꾸지 않아요' });
    return undefined;
  };
  const opsWrite = [ctx.guards.user, ctx.guards.role('operator'), demoWideLock];

  app.put<{ Body: { module: ModuleKind; value: ModuleSwitch } }>(
    '/api/ops/switch',
    {
      preHandler: opsWrite,
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
      preHandler: opsWrite,
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
      preHandler: opsWrite,
      schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: valueProps } },
    },
    async (req) => ctx.ops.setValues(req.deskUser!.pseudonymId, req.body),
  );

  // "링크만"일 때 보내는 그룹웨어 주소(CD-4). https 주소만 받아요.
  app.put<{ Body: { module: ModuleKind; url: string } }>(
    '/api/ops/link',
    {
      preHandler: opsWrite,
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
