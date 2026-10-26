import type { OrderConfirmResponse, OrderCurrentResponse, OrderLineChangeRequest, OrderPlanCreateRequest, OrderPlanView } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../context';
import { OrderService } from './service';

// F3 주문안(ADR-08, R1·R16): 층 최소 몫 탐욕법(D8 1단계 보정) + 이유 코드, 확정·주기·파일 내보내기. 총무만 써요(D8).
// 경로: 만들기 · 지금 주문안 · 보기 · 설명 채우기 · 줄 바꾸기 · 줄 빼기 · 확정 · 파일 내보내기

const PLAN_PARAMS = {
  type: 'object',
  required: ['planId'],
  additionalProperties: false,
  properties: { planId: { type: 'string', format: 'uuid' } },
} as const;

const LINE_PARAMS = {
  type: 'object',
  required: ['planId', 'lineId'],
  additionalProperties: false,
  properties: { planId: { type: 'string', format: 'uuid' }, lineId: { type: 'string', pattern: '^L[0-9]{1,4}$' } },
} as const;

export function registerOrderRoutes(app: FastifyInstance, ctx: AppContext): void {
  const service = new OrderService(ctx);
  const preHandler = [ctx.guards.user, ctx.guards.role('facilities')];

  app.post<{ Body: OrderPlanCreateRequest }>(
    '/api/pantry/order/plans',
    {
      preHandler,
      schema: {
        body: {
          type: 'object',
          required: ['budget'],
          additionalProperties: false,
          properties: { budget: { type: 'integer', minimum: 0, maximum: 1_000_000_000 } },
        },
      },
    },
    async (req): Promise<OrderPlanView> => service.create(req.deskUser!, req.body.budget),
  );

  app.get('/api/pantry/order/plans/current', { preHandler }, async (): Promise<OrderCurrentResponse> => ({ plan: await service.current() }));

  app.get<{ Params: { planId: string } }>(
    '/api/pantry/order/plans/:planId',
    { preHandler, schema: { params: PLAN_PARAMS } },
    async (req): Promise<OrderPlanView> => service.view(req.params.planId),
  );

  app.post<{ Params: { planId: string } }>(
    '/api/pantry/order/plans/:planId/explain',
    { preHandler, schema: { params: PLAN_PARAMS } },
    async (req): Promise<OrderPlanView> => service.explain(req.deskUser!, req.params.planId),
  );

  app.put<{ Params: { planId: string; lineId: string }; Body: OrderLineChangeRequest }>(
    '/api/pantry/order/plans/:planId/lines/:lineId',
    {
      preHandler,
      schema: {
        params: LINE_PARAMS,
        body: {
          type: 'object',
          required: ['quantity'],
          additionalProperties: false,
          properties: { quantity: { type: 'integer', minimum: 1, maximum: 100_000 } },
        },
      },
    },
    async (req): Promise<OrderPlanView> => service.changeLine(req.deskUser!, req.params.planId, req.params.lineId, req.body.quantity),
  );

  app.delete<{ Params: { planId: string; lineId: string } }>(
    '/api/pantry/order/plans/:planId/lines/:lineId',
    { preHandler, schema: { params: LINE_PARAMS } },
    async (req): Promise<OrderPlanView> => service.removeLine(req.deskUser!, req.params.planId, req.params.lineId),
  );

  // 화면이 확인 시트("주문에 들어간 품목의 표가 닫혀요 …")를 한 번 띄운 뒤에만 불러요.
  app.post<{ Params: { planId: string } }>(
    '/api/pantry/order/plans/:planId/confirm',
    { preHandler, schema: { params: PLAN_PARAMS } },
    async (req): Promise<OrderConfirmResponse> => service.confirm(req.deskUser!, req.params.planId),
  );

  app.get<{ Params: { planId: string } }>('/api/pantry/order/plans/:planId/export.csv', { preHandler, schema: { params: PLAN_PARAMS } }, async (req, reply) => {
    const file = await service.exportCsv(req.params.planId);
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${file.filename}"`).send(file.body);
  });
}
