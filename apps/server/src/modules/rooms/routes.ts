import { EQUIPMENT, type RoomCardsResponse, type RoomQuery } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import { linkCard } from '../../core/router';
import { kstIso } from './search';
import type { RoomDesk } from './service';

// 회의실 경로(F2, M3). 읽기 경로(찾기·다시 확인·내 예약)는 DB에 쓰지 않아요.
// 쓰기는 /api/plans(확인 시트)와 아래 DELETE(고정 버튼, 확인 시트 뒤)뿐이에요(ADR-03).

const QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    start: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
    minutes: { type: 'integer', minimum: 10, maximum: 600 },
    people: { type: 'integer', minimum: 1, maximum: 200 },
    equipment: { type: 'array', items: { enum: [...EQUIPMENT] }, maxItems: EQUIPMENT.length, uniqueItems: true },
    floor: { type: 'string', pattern: '^\\d{1,2}층$' },
  },
} as const;

export function registerRoomRoutes(app: FastifyInstance, ctx: AppContext, desk: RoomDesk): void {
  // 조건 칩을 고친 뒤 다시 찾기. 아무것도 쓰지 않아요. 길이가 비면 운영 설정 기본값이에요.
  app.post<{ Body: { query: Partial<RoomQuery> } }>(
    '/api/rooms/search',
    {
      preHandler: ctx.guards.user,
      schema: { body: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: QUERY_SCHEMA } } },
    },
    async (req): Promise<RoomCardsResponse> => {
      if (!ctx.rateLimiter.hit(req.deskUser!.pseudonymId, 'rooms.search')) throw new DeskError('rate-limited', 429, '요청이 많아요. 잠시 뒤에 다시 해 주세요');
      const settings = ctx.ops.get();
      if (settings.modules.rooms !== 'on') return { checkedAt: kstIso(ctx.now()), cards: [linkCard('rooms', settings.links.rooms)] };
      const query = { minutes: settings.values.defaultMeetingMinutes, ...req.body.query };
      const found = await desk.cards(query, req.deskUser!, {
        headline: '고친 조건으로 다시 찾았어요',
        evidence: '내가 고친 조건 · 칩을 고치면 다시 찾아요',
        aiSummarized: false,
      });
      return { checkedAt: kstIso(found.checkedAt), cards: found.cards };
    },
  );

  // 앱 확인 링크(M3). 토큰 주인만 열고, 연 것만으로는 아무것도 쓰지 않아요.
  app.post<{ Body: { proposalToken: string } }>(
    '/api/rooms/recheck',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['proposalToken'],
          additionalProperties: false,
          properties: { proposalToken: { type: 'string', minLength: 1, maxLength: 4000 } },
        },
      },
    },
    async (req) => desk.recheck(req.deskUser!, req.body.proposalToken),
  );

  app.get('/api/rooms/my-reservations', { preHandler: ctx.guards.user }, async (req) => desk.myReservations(req.deskUser!));

  app.delete<{ Params: { id: string } }>(
    '/api/rooms/reservations/:id',
    {
      preHandler: ctx.guards.user,
      schema: { params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^[0-9]{1,18}$' } } } },
    },
    async (req) => desk.cancel(req.deskUser!, req.params.id),
  );
}
