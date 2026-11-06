import {
  CAFE_BILLING_LIMITS,
  CAFE_LIMITS,
  type CafeLimitRequestBody,
  type CafeMenuInput,
  type CafeProposeRequest,
  type CafeSettleResponse,
  type CafeSoldOutRequest,
  type CafeStatusRequest,
} from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import { accessFrom } from '../../core/access-record';
import type { CafeDesk } from './service';

// 사내 카페 경로(F4 1묶음, ADR-29). 경로마다 JSON 스키마로 본문을 검증하고 additionalProperties: false를 둬요.
// - 직원: 로그인한 누구나. 카페가 끔이면 닫혀요(409), 링크만이면 카페 페이지가 링크 카드예요.
// - 카페 판: 바리스타(역할 cafe)만이에요. 아니면 403이에요. 응답에 이름·가명 ID·금액이 없어요.
// - 카페 정산(S9, 2묶음): 총무(역할 facilities)만이에요. 아니면 403이고, 카페가 '켬'일 때만 열려요. 볼 때·바꿀 때 접속기록에 남아요.
// 주문 금액 칸은 어떤 본문에도 없어요. 서버가 메뉴 직원가로 계산해요. 직원이 보내는 금액은 한도로 바라는 값(한도 요청)뿐이에요.

const ORDER_ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9]{1,18}$' } } } as const;
const MENU_ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' } } } as const;
const ROW_ID = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^[0-9]{1,18}$' } } } as const;
const MONTH = '^[0-9]{4}-(0[1-9]|1[0-2])$';
/** 이름·옵션 길이는 서버가 앞뒤 빈칸을 지운 뒤 다시 봐요. */
const MENU_BODY = {
  name: { type: 'string', minLength: 1, maxLength: CAFE_BILLING_LIMITS.menuNameMax + 10 },
  priceWon: { type: 'integer', minimum: 0, maximum: CAFE_BILLING_LIMITS.maxPriceWon },
  options: {
    type: 'array',
    maxItems: CAFE_BILLING_LIMITS.maxOptions,
    items: { type: 'string', minLength: 1, maxLength: CAFE_BILLING_LIMITS.optionNameMax + 10 },
  },
} as const;

export function registerCafeRoutes(app: FastifyInstance, ctx: AppContext, desk: CafeDesk): void {
  const user = ctx.guards.user;
  const barista = [ctx.guards.user, ctx.guards.role('cafe')];
  const facilities = [ctx.guards.user, ctx.guards.role('facilities')];

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
  // ── S7 내 청구(직원, 2묶음) ──

  // [한도 늘려 달라고 하기](고정 버튼): 그 달 한도로 바라는 금액만(사유 글 없음). 총무 역할에게 알림이 가요.
  app.post<{ Body: CafeLimitRequestBody }>(
    '/api/cafe/limit/request',
    {
      preHandler: user,
      schema: {
        body: {
          type: 'object',
          required: ['amountWon'],
          additionalProperties: false,
          properties: { amountWon: { type: 'integer', minimum: CAFE_BILLING_LIMITS.minLimitWon, maximum: CAFE_BILLING_LIMITS.maxLimitWon } },
        },
      },
    },
    async (req) => desk.billing.requestLimit(req.deskUser!, req.body.amountWon),
  );

  // ── S9 카페 정산(총무만, 2묶음) ──

  // 정산 화면: 고른 달 청구서(이름·청구액·입금 코드·납부 상태)·한도 요청·메뉴. 열 때마다 접속기록(cafe.settle)에 가명 ID가 남아요.
  app.get<{ Querystring: { month?: string } }>(
    '/api/cafe/settle',
    {
      preHandler: facilities,
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { month: { type: 'string', pattern: MONTH } } } },
    },
    async (req): Promise<CafeSettleResponse> => desk.billing.settle(req.deskUser!, req.query.month, accessFrom(req)),
  );

  // [입금 확인](고정 버튼): 통장을 본 총무가 눌러요. 두 번 눌러도 한 번이에요.
  app.post<{ Params: { id: string } }>('/api/cafe/bills/:id/paid', { preHandler: facilities, schema: { params: ROW_ID } }, async (req) =>
    desk.billing.markPaid(req.deskUser!, req.params.id, accessFrom(req)),
  );

  // 한도 요청 [늘려 주기]·[안 돼요](고정 버튼). 늘린 한도는 그 달에만 써요.
  app.post<{ Params: { id: string } }>('/api/cafe/limit/:id/approve', { preHandler: facilities, schema: { params: ROW_ID } }, async (req) =>
    desk.billing.decideLimit(req.deskUser!, req.params.id, 'approved', accessFrom(req)),
  );
  app.post<{ Params: { id: string } }>('/api/cafe/limit/:id/reject', { preHandler: facilities, schema: { params: ROW_ID } }, async (req) =>
    desk.billing.decideLimit(req.deskUser!, req.params.id, 'rejected', accessFrom(req)),
  );

  // 메뉴·직원가 관리(고정 버튼): 더하기·바꾸기(이름·직원가·옵션·파는지). 품절은 바리스타가 카페 판에서 바꿔요.
  app.post<{ Body: CafeMenuInput }>(
    '/api/cafe/menu',
    {
      preHandler: facilities,
      schema: { body: { type: 'object', required: ['name', 'priceWon', 'options'], additionalProperties: false, properties: MENU_BODY } },
    },
    async (req) => desk.billing.addMenu(req.deskUser!, req.body),
  );
  app.put<{ Params: { id: string }; Body: CafeMenuInput }>(
    '/api/cafe/menu/:id',
    {
      preHandler: facilities,
      schema: {
        params: MENU_ID,
        body: {
          type: 'object',
          required: ['name', 'priceWon', 'options', 'active'],
          additionalProperties: false,
          properties: { ...MENU_BODY, active: { type: 'boolean' } },
        },
      },
    },
    async (req) => desk.billing.updateMenu(req.deskUser!, req.params.id, req.body),
  );

  // [지난달 매출 합계 내려받기]: 날·메뉴별 잔 수·금액 CSV(이름·가명 ID 없음). 접속기록(cafe.sales)에 남아요.
  app.get<{ Querystring: { month: string } }>(
    '/api/cafe/sales.csv',
    {
      preHandler: facilities,
      schema: { querystring: { type: 'object', required: ['month'], additionalProperties: false, properties: { month: { type: 'string', pattern: MONTH } } } },
    },
    async (req, reply) => {
      const file = await desk.billing.salesCsv(req.deskUser!, req.query.month, accessFrom(req));
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${file.filename}"`).send(file.body);
    },
  );
}
