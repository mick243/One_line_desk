import { CAFE_LIMITS, type CafeProposeRequest, type CafeSoldOutRequest, type CafeStatusRequest } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import type { CafeDesk } from './service';

// 사내 카페 경로(F4 1묶음, ADR-29). 경로마다 JSON 스키마로 본문을 검증하고 additionalProperties: false를 둬요.
// - 직원: 로그인한 누구나. 카페가 끔이면 닫혀요(409), 링크만이면 카페 페이지가 링크 카드예요.
// - 카페 판: 바리스타(역할 cafe)만이에요. 아니면 403이에요. 응답에 이름·가명 ID·금액이 없어요.
// 금액 칸은 어떤 본문에도 없어요. 서버가 메뉴 직원가로 계산해요.

const ORDER_ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9]{1,18}$' } } } as const;
const MENU_ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' } } } as const;

export function registerCafeRoutes(app: FastifyInstance, ctx: AppContext, desk: CafeDesk): void {
  const user = ctx.guards.user;
  const barista = [ctx.guards.user, ctx.guards.role('cafe')];

  // ── S7 카페 주문(직원) ──

  app.get('/api/cafe', { preHandler: user }, async (req) => desk.view(req.deskUser!));

  // 고른 메뉴·픽업 칸으로 제안 토큰만 만들어요. 화면은 기존 확인 시트 흐름(POST /api/plans → [주문하기])을 그대로 써요.
  app.post<{ Body: CafeProposeRequest }>(
    '/api/cafe/order/propose',
    {
      preHandler: user,
      schema: {
        body: {
          type: 'object',
          required: ['lines', 'pickupSlot'],
          additionalProperties: false,
          properties: {
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: CAFE_LIMITS.maxLines,
              items: {
                type: 'object',
                required: ['menuId', 'qty', 'options'],
                additionalProperties: false,
                properties: {
                  menuId: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' },
                  qty: { type: 'integer', minimum: 1, maximum: CAFE_LIMITS.maxQty },
                  options: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 20 } },
                },
              },
            },
            pickupSlot: { type: 'string', maxLength: 40 },
          },
        },
      },
    },
    async (req) => desk.propose(req.deskUser!, req.body),
  );

  // [취소](고정 버튼, 확인 시트 뒤): 내 주문이고 접수 대기일 때만
  app.post<{ Params: { id: string } }>('/api/cafe/orders/:id/cancel', { preHandler: user, schema: { params: ORDER_ID } }, async (req) =>
    desk.cancel(req.deskUser!, req.params.id),
  );

  // ── S8 카페 판(바리스타만) ──

  // 웹은 3초마다 배경 요청(x-desk-background)으로 불러요. 쉬는 시간을 늘리지 않아요(ADR-20).
  app.get('/api/cafe/board', { preHandler: barista }, async () => desk.board());

  app.post('/api/cafe/board/open', { preHandler: barista }, async (req) => desk.setOpen(req.deskUser!, true));
  app.post('/api/cafe/board/close', { preHandler: barista }, async (req) => desk.setOpen(req.deskUser!, false));

  app.post<{ Params: { id: string }; Body: CafeStatusRequest }>(
    '/api/cafe/orders/:id/status',
    {
      preHandler: barista,
      schema: {
        params: ORDER_ID,
        body: { type: 'object', required: ['to'], additionalProperties: false, properties: { to: { enum: ['making', 'ready', 'picked'] } } },
      },
    },
    async (req) => desk.advance(req.deskUser!, req.params.id, req.body.to),
  );

  app.put<{ Params: { id: string }; Body: CafeSoldOutRequest }>(
    '/api/cafe/menu/:id/sold-out',
    {
      preHandler: barista,
      schema: {
        params: MENU_ID,
        body: { type: 'object', required: ['soldOut'], additionalProperties: false, properties: { soldOut: { type: 'boolean' } } },
      },
    },
    async (req) => desk.setSoldOut(req.deskUser!, req.params.id, req.body.soldOut),
  );
}
