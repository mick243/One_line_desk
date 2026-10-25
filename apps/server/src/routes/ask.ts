import { checkInput } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { sessionGuard } from './guard';

// 앞문 라우터 /ask(ADR-02·04). 아무것도 저장·게시하지 않아요. 원문은 이 요청의 메모리에서만 다뤄요.
export function registerAskRoutes(app: FastifyInstance, ctx: AppContext) {
  const requireSession = sessionGuard(ctx);

  app.post<{ Body: { text: string } }>(
    '/api/ask',
    {
      preHandler: requireSession,
      schema: { body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } } } },
    },
    async (req, reply) => {
      const session = req.deskSession!;
      if (!ctx.rateLimiter.hit(session.pseudonymId, 'ask')) {
        return reply.code(429).send({ error: 'rate-limited', message: '요청이 많아요. 잠시 뒤에 다시 보내 주세요.' });
      }

      // 브라우저와 같은 규칙으로 다시 검사해요. 걸리면 내용 없이 버리고 "잠김"만 남겨요(ADR-11).
      const checked = checkInput(req.body.text);
      if (checked.locks.length > 0) {
        ctx.audit.record({ pseudonymId: session.pseudonymId, channel: 'ask', result: 'locked' });
        return reply.code(422).send({ error: 'locked', locks: checked.locks, rulesVersion: checked.rulesVersion });
      }

      // 3일 차: 규칙 → LLM 한 번(구조화 출력) → 확신 계산 → 모듈 읽기 → 카드 + 제안 토큰.
      return reply.code(501).send({ error: 'not-implemented', message: '앞문 라우터는 아직 만들지 않았어요(3일 차)' });
    },
  );
}
