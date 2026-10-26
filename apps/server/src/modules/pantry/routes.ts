import {
  checkInput,
  type KeepApartRequest,
  type MergeRequest,
  PANTRY_TEXT,
  type PantryDraftRequest,
  type PantryDraftResponse,
  type PantrySettingsUpdate,
  type RevertRequest,
  type VoteRequest,
} from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import type { BoardService } from './service';

// 같이 채워요 판 경로(F3). 경로마다 JSON 스키마로 본문을 검증하고 additionalProperties: false를 둬요.
// 응답에는 표 수만 있어요. 누가 표를 줬는지는 어디에도 없어요(총무 포함).

const FLOOR = { type: 'string', pattern: '^[0-9]{1,3}층$' } as const;
const FLOOR_QUERY = { type: 'object', additionalProperties: false, properties: { floor: FLOOR } } as const;
const ID = { type: 'integer', minimum: 1 } as const;
const VERSION = { type: 'integer', minimum: 0 } as const;
const PAIR = { type: 'array', items: ID, minItems: 2, maxItems: 2 } as const;

export function registerBoardRoutes(app: FastifyInstance, ctx: AppContext, svc: BoardService): void {
  const user = ctx.guards.user;
  const facilities = [ctx.guards.user, ctx.guards.role('facilities')];

  // 게시 초안(ADR-04). 저장하지 않아요. 글은 이 요청 메모리에서만 다루고, 판 표에는 쓰지 못해요.
  app.post<{ Body: PantryDraftRequest }>(
    '/api/pantry/draft',
    {
      preHandler: user,
      schema: {
        body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } } },
      },
    },
    async (req, reply) => {
      const u = req.deskUser!;
      svc.assertOn();
      if (!ctx.rateLimiter.hit(u.pseudonymId, 'draft')) return reply.code(429).send({ error: 'rate-limited', message: PANTRY_TEXT.rateLimited });
      // 브라우저와 같은 규칙으로 다시 검사해요. 걸리면 내용 없이 버리고 "잠김"만 남겨요(ADR-11).
      const checked = checkInput(req.body.text);
      if (checked.locks.length > 0) {
        await ctx.audit.record({ pseudonymId: u.pseudonymId, channel: 'ask', module: 'pantry', action: 'draft', result: 'locked' });
        return reply.code(422).send({ error: 'locked', message: checked.locks[0]!.message, locks: checked.locks, rulesVersion: checked.rulesVersion });
      }
      const cards = await svc.draftFromText(u, checked.text);
      const found = cards.some((c) => c.variant === 'pantry-preview' || c.variant === 'pantry-same');
      await ctx.audit.record({ pseudonymId: u.pseudonymId, channel: 'ask', module: 'pantry', action: 'draft', result: found ? 'card' : 'not-found' });
      const res: PantryDraftResponse = { cards };
      return res;
    },
  );

  app.get<{ Querystring: { floor?: string } }>('/api/pantry/board', { preHandler: user, schema: { querystring: FLOOR_QUERY } }, async (req) =>
    svc.board(req.deskUser!, req.query.floor),
  );

  app.get('/api/pantry/my-requests', { preHandler: user }, async (req) => svc.myRequests(req.deskUser!));

  // +1(고정 버튼, 바로 실행)
  app.post<{ Body: VoteRequest }>(
    '/api/pantry/votes',
    { preHandler: user, schema: { body: { type: 'object', required: ['bundleId'], additionalProperties: false, properties: { bundleId: ID } } } },
    async (req) => svc.vote(req.deskUser!, req.body.bundleId),
  );

  // 표 거두기(고정 버튼, 바로 실행)
  app.delete<{ Params: { bundleId: number } }>(
    '/api/pantry/votes/:bundleId',
    { preHandler: user, schema: { params: { type: 'object', required: ['bundleId'], properties: { bundleId: ID } } } },
    async (req) => svc.withdraw(req.deskUser!, req.params.bundleId),
  );

  // ── S4(총무만) ──

  app.get<{ Querystring: { floor?: string } }>('/api/pantry/suggestions', { preHandler: facilities, schema: { querystring: FLOOR_QUERY } }, async (req) =>
    svc.suggestions(req.deskUser!, req.query.floor ?? req.deskUser!.floor),
  );

  // S4를 열 때 남은 후보를 한 번 더 모아요(R15).
  app.post<{ Body: { floor?: string } }>(
    '/api/pantry/suggestions/collect',
    { preHandler: facilities, schema: { body: { type: 'object', additionalProperties: false, properties: { floor: FLOOR } } } },
    async (req) => svc.collect(req.deskUser!, req.body?.floor ?? req.deskUser!.floor),
  );

  // [따로 두기](바로 실행)
  app.post<{ Body: KeepApartRequest }>(
    '/api/pantry/suggestions/keep-apart',
    { preHandler: facilities, schema: { body: { type: 'object', required: ['bundleIds'], additionalProperties: false, properties: { bundleIds: PAIR } } } },
    async (req) => svc.keepApart(req.deskUser!, req.body.bundleIds),
  );

  // [합치기](확인 시트 뒤)
  app.post<{ Body: MergeRequest }>(
    '/api/pantry/merges',
    {
      preHandler: facilities,
      schema: {
        body: {
          type: 'object',
          required: ['bundleIds', 'versions'],
          additionalProperties: false,
          properties: { bundleIds: PAIR, versions: { type: 'array', items: VERSION, minItems: 2, maxItems: 2 } },
        },
      },
    },
    async (req) => svc.merge(req.deskUser!, req.body),
  );

  app.get<{ Querystring: { floor?: string } }>('/api/pantry/merges', { preHandler: facilities, schema: { querystring: FLOOR_QUERY } }, async (req) =>
    svc.merges(req.deskUser!, req.query.floor ?? req.deskUser!.floor),
  );

  // [되돌리기](확인 시트 뒤)
  app.post<{ Params: { mergeId: number }; Body: RevertRequest }>(
    '/api/pantry/merges/:mergeId/revert',
    {
      preHandler: facilities,
      schema: {
        params: { type: 'object', required: ['mergeId'], properties: { mergeId: ID } },
        body: { type: 'object', required: ['bundleVersion'], additionalProperties: false, properties: { bundleVersion: VERSION } },
      },
    },
    async (req) => svc.revert(req.deskUser!, req.params.mergeId, req.body.bundleVersion),
  );

  app.get('/api/pantry/settings', { preHandler: facilities }, async (req) => svc.settings(req.deskUser!));

  app.put<{ Params: { floor: string }; Body: PantrySettingsUpdate }>(
    '/api/pantry/settings/:floor',
    {
      preHandler: facilities,
      schema: {
        params: { type: 'object', required: ['floor'], properties: { floor: FLOOR } },
        body: {
          type: 'object',
          required: ['minShareWon', 'perPersonLimit', 'cycleNote'],
          additionalProperties: false,
          properties: {
            minShareWon: { type: 'integer', minimum: 0, maximum: 100_000_000 },
            perPersonLimit: { type: 'integer', minimum: 1, maximum: 50 },
            cycleNote: { type: 'string', maxLength: 60 },
          },
        },
      },
    },
    async (req) => svc.saveSettings(req.deskUser!, req.params.floor, req.body),
  );
}
