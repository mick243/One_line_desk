import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import { DEFAULT_OPS_SETTINGS, hasControlChar, LAUNCH_OPS_SETTINGS, LOCK_MESSAGE, type ModuleKind, recordCutoff } from '@one-line-desk/shared';
import { NON_HTML_CSP } from '@one-line-desk/shared/web-headers';
import Fastify, { type FastifyReply, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { type Adapters, createAdapters, withOutboundAdapters } from './adapters';
import type { ServerConfig } from './config';
import type { AppContext } from './context';
import { AnthropicProvider } from './core/ai/anthropic-provider';
import { AiGateway, FakeProvider, type LlmProvider } from './core/ai/gateway';
import { AccessRecorder } from './core/access-record';
import { AuditLog } from './core/audit';
import { applyMigrations, type Db, openDb, pendingMigrations } from './core/db';
import { DeskError } from './core/errors';
import { FixedActions } from './core/fixed-action';
import { errorSummary, maskedLogger, pathOnly } from './core/logging';
import { Notifier } from './core/notifications';
import { createGuards } from './core/guard';
import type { DeskModule } from './core/module';
import { OpsSettingsStore } from './core/ops-settings';
import { PlanService } from './core/plans';
import { ProposalTokens } from './core/proposal-token';
import { RateLimiter } from './core/rate-limit';
import { Router } from './core/router';
import { SessionStore } from './core/session';
import { registerWebFiles } from './core/web-files';
import { createModules } from './modules';
import { registerAskRoutes } from './routes/ask';
import { registerAuthRoutes } from './routes/auth';
import { purgeDemoInbox, registerDemoInboxRoutes } from './routes/demo-inbox';
import { registerPeopleRoutes } from './routes/people';
import { registerConfigRoutes, registerHealthRoutes } from './routes/config';
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
  /** 보관 기간 지우기를 한 시간마다 돌릴지. 시험은 끄고 runRetention()을 직접 불러요. 기본은 켬이에요. */
  retentionTimer?: boolean;
  /** 웹 화면 파일(apps/web/dist) 폴더. 넣으면 서버가 화면도 줘요(운영, 10/29 배포 준비 회의 A3). 개발은 Vite가 줘요. */
  webDir?: string;
}

const RETENTION_EVERY_MS = 60 * 60_000;
const RETENTION_RETRY_MS = 5 * 60_000;

export async function buildApp(opts: BuildOptions) {
  const { config } = opts;
  const now = opts.now ?? Date.now;
  const db = opts.db ?? (await openDb(config.databaseUrl));
  // 운영은 앱 시작 적용을 끄고(앱 계정에 표 만들기 권한 없음) 배포 잡이 먼저 적용해요(L-22). 빠진 게 있으면 뜨지 않아요.
  if (config.migrateOnStart) await applyMigrations(db);
  else {
    const pending = await pendingMigrations(db);
    if (pending.length) throw new Error(`아직 적용하지 않은 마이그레이션이 있어요(${pending.join(', ')}). npm run db:migrate를 먼저 돌려 주세요`);
  }

  const audit = new AuditLog(db);
  // 운영(production)은 출시 기본값(회의실 쓰기·MCP 끔)에서 시작해요. 개발·시연은 모두 켠 기본값이에요. 바꾼 값은 표에서 읽어요.
  const ops = new OpsSettingsStore(audit, db, config.production ? LAUNCH_OPS_SETTINGS : DEFAULT_OPS_SETTINGS);
  await ops.load();
  const settings = () => ops.get();
  const provider = opts.provider ?? (config.aiProvider === 'anthropic' ? new AnthropicProvider(config.aiModel) : new FakeProvider());
  const tokens = new ProposalTokens(config.proposalSecret, now, () => settings().values.proposalTtlSeconds * 1000);
  const adapters = withOutboundAdapters(opts.adapters ?? createAdapters(config), db, now, config.demo);
  // 운영 환경에서 모의 IdP로 뜨면 누구나 운영자로 들어와요. 시연 배포는 DESK_MOCK_LOGIN=true로 드러내 놓고 열어요.
  if (adapters.idp.loginChoices && !config.demo) {
    throw new Error('운영 환경에서는 모의 로그인을 쓸 수 없어요. 실제 IdP 어댑터를 넘기거나, 시연 배포면 DESK_MOCK_LOGIN=true를 넣어 주세요');
  }
  const base: Omit<AppContext, 'guards'> = {
    config,
    db,
    adapters,
    dataAdapters: () => adapters.all(),
    sessions: new SessionStore(now),
    audit,
    access: new AccessRecorder(db, now),
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

  // 요청 로그에는 방법·경로·상태만 남아요. 쿼리·IP·본문은 로그·오류 응답에 넣지 않아요(R13, L-28 core/logging.ts).
  // additionalProperties: false인 본문에 모르는 칸이 오면 조용히 지우지 않고 400으로 거부해요.
  // 시간 제한(L-17): 요청 30초. 앞단 부하 분산기(보통 60초)보다 연결 유지를 길게 둬서 끊긴 연결로 502가 나지 않게 해요.
  const app = Fastify({
    logger: maskedLogger(opts.logger),
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
    trustProxy: config.trustProxy,
    requestTimeout: 30_000,
    connectionTimeout: 35_000,
    keepAliveTimeout: 65_000,
    return503OnClosing: true,
    // 요청 번호(배포 준비 회의 C5): 기본은 프로세스마다 req-1부터 다시 세서 1년 남는 접속기록의 request_id가 겹쳐요.
    // 무작위로 만들고 응답 머리 x-request-id로 돌려줘요. 들어온 요청 번호 머리는 믿지 않아요(꾸민 글이 1년 기록에 들어가지 않게).
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    // 읽지 못하는 주소(%zz 같은)는 기본 오류 글에 주소가 그대로 들어가요. 내용 없이 400으로 답해요(10/29 배포 준비 회의 B5).
    frameworkErrors: (err, req, reply: FastifyReply) => {
      req.log.warn({ msg: 'client-error', code: err.code });
      return reply.code(400).send({ error: 'bad-request', message: '요청 형식이 맞지 않아요' });
    },
  });
  await app.register(cookie, { secret: config.sessionSecret });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof DeskError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err.validation || err instanceof ZodError) return reply.code(400).send({ error: 'bad-request', message: '요청 형식이 맞지 않아요' });
    // 본문 해석 실패(400)·형식(415)·크기(413) 같은 요청 쪽 오류는 내용 없이 bad-request로 답하고 경고로만 남겨요.
    if (err.statusCode && err.statusCode < 500) {
      req.log.warn({ msg: 'client-error', statusCode: err.statusCode });
      return reply.code(err.statusCode).send({ error: 'bad-request', message: '요청 형식이 맞지 않아요' });
    }
    req.log.error({ msg: 'server-error', err: errorSummary(err) });
    return reply.code(500).send({ error: 'server-error', message: '지금 처리하지 못했어요' });
  });

  // 없는 주소: 기본 404는 쿼리까지 붙은 주소를 로그(info)와 응답 글에 그대로 넣어요. 경로만 로그에 남고 응답에는 주소가 없어요(B5).
  // /api에 없는 경로는 대개 배포 뒤 옛 화면이 이름이 바뀐 API를 부른 거라 새로 고치라고 해요(D2).
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: 'not-found',
      message: pathOnly(req.url).startsWith('/api/') ? '화면이 옛 버전이에요. 새로 고친 뒤 다시 해 주세요' : '찾는 주소가 없어요',
    }),
  );

  // 기본 머리(L-17): 응답을 캐시에 남기지 않고, 형식 추측·주소 넘김을 막아요.
  // 화면 HTML은 web-files.ts가 보안 머리 한 벌을 붙이고, 그 밖의 응답은 문서로 열려도 아무것도 못 불러오게 해요(B1).
  // 요청 번호와 떠 있는 판(build)도 실어요. 웹은 판이 다르면 "새 버전이 있어요"를 띄워요(C5·D1).
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-desk-build', config.build);
    // 시연(모의 로그인)은 검색에 걸리지 않게 해요(배포 준비 회의 A8·D8).
    if (config.demo) reply.header('x-robots-tag', 'noindex, nofollow');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', NON_HTML_CSP);
  });

  // NUL 같은 제어 문자(줄바꿈·tab 빼고)가 든 본문·쿼리는 어느 경로든 검사·저장 전에 400으로 돌려보내요(QA-10).
  // jsonb 저장이나 응답 머리에서 500이 나지 않게 해요. 브라우저도 같은 규칙으로 보내기를 잠가요.
  app.addHook('preValidation', async (req) => {
    if (hasControlChar(req.body) || hasControlChar(req.query)) throw new DeskError('bad-request', 400, LOCK_MESSAGE.control);
  });

  ctx.dataAdapters = () => [...ctx.adapters.all(), ...modules.flatMap((m) => m.adapters?.() ?? [])];
  registerConfigRoutes(app, ctx, ctx.dataAdapters);
  registerAuthRoutes(app, ctx);
  registerAskRoutes(app, ctx, router);
  registerPlanRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);
  registerPeopleRoutes(app, ctx);
  registerDemoInboxRoutes(app, ctx);
  for (const module of modules) module.register?.(app);
  if (opts.webDir) registerWebFiles(app, opts.webDir);

  if (opts.seed ?? config.seedDemo) {
    for (const module of modules) await module.seed?.();
  }

  // 보관 기간 지우기(L-33): 화면을 열지 않아도 지워요. 듣기 시작한 뒤 한 번, 그 뒤 한 시간마다예요.
  // 10/28 사용자 결정: 접속기록(법정 1년) 말고는 모두 7일(RECORD_KEEP_DAYS)이에요. 모듈 기록은 각 모듈 retention이 지워요.
  // 단계마다 따로 잡아서 한 단계가 실패해도 나머지는 지워요. 실패한 단계 이름을 돌려주고 retention-failed를 남겨요(배포 준비 회의 A5).
  let retentionLastOk: number | null = null;
  const runRetention = async (): Promise<string[]> => {
    const before = recordCutoff(ctx.now());
    const steps: [string, () => Promise<unknown>][] = [
      ['notifications', () => ctx.notify.purge()],
      ['audit', () => ctx.audit.purge(before)],
      ['plans', () => ctx.plans.purge(before)],
      ['ai-usage', () => ctx.gateway.purgeUsage(before)],
      ['demo-inbox', () => purgeDemoInbox(ctx)],
      ['access-log', () => ctx.access.purge()],
      ...modules.map((m): [string, () => Promise<unknown>] => [`module:${m.kind}`, async () => m.retention?.()]),
    ];
    const failed: string[] = [];
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (err) {
        failed.push(step);
        app.log.error({ msg: 'retention-failed', step, err: errorSummary(err) });
      }
    }
    // 모든 단계가 지운 마지막 시각이에요. /health/ready에 실어서 감시가 "오래 못 지움"을 알아채요(앞선 회의 A6).
    if (!failed.length) retentionLastOk = ctx.now();
    return failed;
  };

  // 첫 회차는 listen 뒤에 돌려요(앞선 회의 A6). 복원 직후처럼 지울 게 쌓여 있어도 서버가 뜨는 걸 막지 않고,
  // 첫 회차가 끝날 때까지(성공이든 실패든) 받을 준비(/health/ready)가 503이에요. 실패한 단계가 있으면 5분 뒤 다시 돌려요.
  const retentionOn = opts.retentionTimer ?? true;
  let firstRetentionDone = !retentionOn;
  let running: Promise<unknown> | undefined;
  let retentionTimer: NodeJS.Timeout | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  const scheduledRetention = () => {
    running = runRetention().then((failed) => {
      firstRetentionDone = true;
      if (!failed.length) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(scheduledRetention, RETENTION_RETRY_MS);
      retryTimer.unref();
    });
  };
  if (retentionOn) {
    app.addHook('onListen', async () => scheduledRetention());
    retentionTimer = setInterval(scheduledRetention, RETENTION_EVERY_MS);
    retentionTimer.unref();
  }
  registerHealthRoutes(app, ctx, () => ({ done: firstRetentionDone, lastOk: retentionLastOk }));

  // 닫을 때(SIGTERM): 돌던 보관 회차가 끝나기를 기다린 뒤 DB를 닫아요(배포 준비 회의 A5).
  app.addHook('onClose', async () => {
    clearInterval(retentionTimer);
    clearTimeout(retryTimer);
    await running;
    if (!opts.db) await db.close();
  });

  return { app, ctx, modules, runRetention };
}
