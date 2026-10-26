import cookie from '@fastify/cookie';
import type { ModuleKind } from '@one-line-desk/shared';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { type Adapters, createMockAdapters } from './adapters';
import type { ServerConfig } from './config';
import type { AppContext } from './context';
import { AnthropicProvider } from './core/ai/anthropic-provider';
import { AiGateway, FakeProvider, type LlmProvider } from './core/ai/gateway';
import { AuditLog } from './core/audit';
import { applyMigrations, type Db, openDb } from './core/db';
import { DeskError } from './core/errors';
import { FixedActions } from './core/fixed-action';
import { Notifier } from './core/notifications';
import { createGuards } from './core/guard';
import type { DeskModule } from './core/module';
import { OpsSettingsStore } from './core/ops-settings';
import { PlanService } from './core/plans';
import { ProposalTokens } from './core/proposal-token';
import { RateLimiter } from './core/rate-limit';
import { Router } from './core/router';
import { SessionStore } from './core/session';
import { createModules } from './modules';
import { registerAskRoutes } from './routes/ask';
import { registerAuthRoutes } from './routes/auth';
import { registerConfigRoutes } from './routes/config';
import { registerNotificationRoutes } from './routes/notifications';
import { registerPlanRoutes } from './routes/plans';

export interface BuildOptions {
  config: ServerConfig;
  /** 시험은 createTestDb()로 만든 DB를 넘겨요. 넘긴 DB는 부르는 쪽이 닫아요. */
  db?: Db;
  adapters?: Adapters;
  provider?: LlmProvider;
  now?: () => number;
  /** 비어 있는 DB에 가상 자료를 넣을지. 기본은 config.seedDemo예요. */
  seed?: boolean;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(opts: BuildOptions) {
  const { config } = opts;
  const now = opts.now ?? Date.now;
  const db = opts.db ?? (await openDb(config.databaseUrl));
  await applyMigrations(db);

  const audit = new AuditLog(db);
  const ops = new OpsSettingsStore(audit);
  const settings = () => ops.get();
  const provider = opts.provider ?? (config.aiProvider === 'anthropic' ? new AnthropicProvider(config.aiModel) : new FakeProvider());
  const tokens = new ProposalTokens(config.proposalSecret, now, () => settings().values.proposalTtlSeconds * 1000);
  const adapters = opts.adapters ?? createMockAdapters();
  // 운영 환경에서 모의 IdP로 뜨면 누구나 운영자로 들어와요. 시연 배포는 DESK_MOCK_LOGIN=true로 드러내 놓고 열어요.
  if (adapters.idp.loginChoices && !config.mockLogin) {
    throw new Error('운영 환경에서는 모의 로그인을 쓸 수 없어요. 실제 IdP 어댑터를 넘기거나, 시연 배포면 DESK_MOCK_LOGIN=true를 넣어 주세요');
  }
  const base: Omit<AppContext, 'guards'> = {
    config,
    db,
    adapters,
    dataAdapters: () => adapters.all(),
    sessions: new SessionStore(now),
    audit,
    ops,
    rateLimiter: new RateLimiter(now, () => settings().values.rateLimitPerMinute),
    gateway: new AiGateway(provider, config.noRetentionContractConfirmed, db),
    plans: new PlanService(db, tokens, audit, settings, now),
    fixed: new FixedActions(db, audit, settings, now),
    notify: new Notifier(db, now),
    services: {},
    now,
  };
  const ctx: AppContext = { ...base, guards: createGuards(base) };

  const modules = createModules(ctx);
  for (const module of modules) for (const handler of module.planHandlers ?? []) ctx.plans.register(handler);
  const askModules = new Map(modules.filter((m): m is DeskModule & { kind: ModuleKind } => m.kind !== 'mcp').map((m) => [m.kind, m]));
  const router = new Router(askModules, ctx.gateway, ops, audit, now);

  // 요청 로그에는 방법·주소·상태만 남아요. 본문은 로그·오류 응답에 넣지 않아요(R13).
  // additionalProperties: false인 본문에 모르는 칸이 오면 조용히 지우지 않고 400으로 거부해요.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024, ajv: { customOptions: { removeAdditional: false } } });
  await app.register(cookie, { secret: config.sessionSecret });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof DeskError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err.validation || err instanceof ZodError) return reply.code(400).send({ error: 'bad-request', message: '요청 형식이 맞지 않아요' });
    // 본문 해석 실패(400)·형식(415)·크기(413) 같은 요청 쪽 오류는 내용 없이 bad-request로 답하고 경고로만 남겨요.
    if (err.statusCode && err.statusCode < 500) {
      req.log.warn({ msg: 'client-error', statusCode: err.statusCode });
      return reply.code(err.statusCode).send({ error: 'bad-request', message: '요청 형식이 맞지 않아요' });
    }
    req.log.error({ msg: err.message });
    return reply.code(500).send({ error: 'server-error', message: '지금 처리하지 못했어요' });
  });

  ctx.dataAdapters = () => [...ctx.adapters.all(), ...modules.flatMap((m) => m.adapters?.() ?? [])];
  registerConfigRoutes(app, ctx, ctx.dataAdapters);
  registerAuthRoutes(app, ctx);
  registerAskRoutes(app, ctx, router);
  registerPlanRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);
  for (const module of modules) module.register?.(app);

  if (opts.seed ?? config.seedDemo) {
    for (const module of modules) await module.seed?.();
  }

  app.addHook('onClose', async () => {
    if (!opts.db) await db.close();
  });

  return { app, ctx, modules };
}
