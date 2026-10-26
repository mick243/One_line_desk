import { checkInput, KINDS, type Kind } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { Router } from '../core/router';

// 앞문 /ask(ADR-02·04). 아무것도 저장·게시하지 않아요. 원문은 이 요청의 메모리에서만 다뤄요.
export function registerAskRoutes(app: FastifyInstance, ctx: AppContext, router: Router) {
  app.post<{ Body: { text: string; kind?: Kind } }>(
    '/api/ask',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: 1000 }, kind: { enum: [...KINDS] } },
        },
      },
    },
    async (req, reply) => {
      const user = req.deskUser!;
      if (!ctx.rateLimiter.hit(user.pseudonymId, 'ask')) {
        return reply.code(429).send({ error: 'rate-limited', message: '요청이 많아요. 잠시 뒤에 다시 보내 주세요.' });
      }

      // 브라우저와 같은 규칙으로 다시 검사해요. 걸리면 내용 없이 버리고 "잠김"만 남겨요(ADR-11).
      const checked = checkInput(req.body.text);
      if (checked.locks.length > 0) {
        await ctx.audit.record({ pseudonymId: user.pseudonymId, channel: 'ask', result: 'locked' });
        return reply.code(422).send({ error: 'locked', message: checked.locks[0]!.message, locks: checked.locks, rulesVersion: checked.rulesVersion });
      }
      return router.ask(user, checked.text, req.body.kind);
    },
  );
}
