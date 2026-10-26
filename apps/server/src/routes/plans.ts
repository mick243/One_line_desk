import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';

// 쓰기 확인 경로(ADR-03, R2). 확인 시트 버튼은 planId만 보내요.
export function registerPlanRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post<{ Body: { proposalToken: string } }>(
    '/api/plans',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: { type: 'object', required: ['proposalToken'], additionalProperties: false, properties: { proposalToken: { type: 'string', maxLength: 4000 } } },
      },
    },
    async (req) => ctx.plans.create(req.deskUser!, req.body.proposalToken),
  );

  app.post<{ Params: { planId: string } }>(
    '/api/plans/:planId/confirm',
    {
      preHandler: ctx.guards.user,
      schema: { params: { type: 'object', required: ['planId'], properties: { planId: { type: 'string', format: 'uuid' } } } },
    },
    async (req) => ctx.plans.confirm(req.deskUser!, req.params.planId),
  );

  // 공개 미리보기 [올리기]: 미리보기 카드 자체가 확인이에요. 사용자가 고친 칸만 edits로 받아요.
  app.post<{ Body: { proposalToken: string; edits?: Record<string, unknown> } }>(
    '/api/plans/direct',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['proposalToken'],
          additionalProperties: false,
          properties: {
            proposalToken: { type: 'string', maxLength: 4000 },
            // 고칠 수 있는 칸은 처리기가 다시 막아요(editableKeys). 여기서는 모양만 봐요.
            edits: { type: 'object', maxProperties: 5, additionalProperties: { type: 'string', maxLength: 200 } },
          },
        },
      },
    },
    async (req) => ctx.plans.direct(req.deskUser!, req.body.proposalToken, req.body.edits ?? {}),
  );
}
