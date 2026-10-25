import cookie from '@fastify/cookie';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { createMockAdapters, type Adapters } from './adapters';
import type { ServerConfig } from './config';
import type { AppContext } from './context';
import { AiGateway } from './core/ai-gateway';
import { AuditLog } from './core/audit';
import { OpsSettingsStore } from './core/ops-settings';
import { RateLimiter } from './core/rate-limit';
import { SessionStore } from './core/session';
import { createPool } from './db/pool';
import { registerAskRoutes } from './routes/ask';
import { registerAuthRoutes } from './routes/auth';
import { registerConfigRoutes } from './routes/config';

export interface BuildOptions {
  config: ServerConfig;
  adapters?: Adapters;
  now?: () => number;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(opts: BuildOptions) {
  const now = opts.now ?? Date.now;
  const audit = new AuditLog(now);
  const ops = new OpsSettingsStore(audit);
  const ctx: AppContext = {
    config: opts.config,
    adapters: opts.adapters ?? createMockAdapters(),
    sessions: new SessionStore(now),
    audit,
    ops,
    rateLimiter: new RateLimiter(now, () => ops.get().values.rateLimitPerMinute),
    gateway: new AiGateway(opts.config.noRetentionContractConfirmed),
    pool: createPool(opts.config.databaseUrl),
    now,
  };

  // 요청 로그에는 방법·주소·상태만 남아요. 본문은 로그·오류 응답에 넣지 않아요(R13).
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 16 * 1024 });
  await app.register(cookie, { secret: opts.config.sessionSecret });

  app.setErrorHandler((err: { statusCode?: number; validation?: unknown; message: string }, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'bad-request', message: '요청 형식이 맞지 않아요' });
    req.log.error({ msg: err.message });
    return reply.code(err.statusCode ?? 500).send({ error: 'server-error', message: '지금 처리하지 못했어요' });
  });

  registerConfigRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerAskRoutes(app, ctx);

  app.addHook('onClose', async () => {
    await ctx.pool?.end();
  });

  return { app, ctx };
}
