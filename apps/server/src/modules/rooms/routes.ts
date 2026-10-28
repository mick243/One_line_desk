import {
  checkInput,
  EQUIPMENT,
  INVITE_MAX,
  type InviteRequest,
  type RoomCardsResponse,
  type RoomChatRequest,
  type RoomChatResponse,
  type RoomDayResponse,
  type RoomListResponse,
  type RoomQuery,
  type RoomSlotRequest,
  type Equipment,
  type FacilityStatus,
} from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import { linkCard } from '../../core/router';
import { kstIso } from './search';
import type { RoomChat } from './chat';
import type { RoomEquipment } from './equipment';
import type { RoomDesk } from './service';

// 회의실 경로(F2, M3). 읽기 경로(찾기·다시 확인·내 예약)는 DB에 쓰지 않아요.
// 쓰기는 /api/plans(확인 시트), 아래 DELETE·PUT(고정 버튼, 확인 시트 뒤), 채팅 명령(자동 실행 허용 목록, ADR-19)뿐이에요(ADR-03).

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

export function registerRoomRoutes(app: FastifyInstance, ctx: AppContext, desk: RoomDesk, equipment: RoomEquipment, chat: RoomChat): void {
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

  // 회의실 둘러보기(10/26). 읽기만 해요. 남의 예약은 "예약됨"만 보여요(ADR-06).
  const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
  const ROOM_ID = { type: 'string', pattern: '^[a-z0-9-]{1,40}$' } as const;
  const today = () => kstIso(ctx.now()).slice(0, 10);

  app.get<{ Querystring: { date?: string } }>(
    '/api/rooms/list',
    { preHandler: ctx.guards.user, schema: { querystring: { type: 'object', additionalProperties: false, properties: { date: DATE } } } },
    async (req): Promise<RoomListResponse> => desk.directory(req.query.date ?? today()),
  );

  app.get<{ Params: { id: string }; Querystring: { date?: string } }>(
    '/api/rooms/:id/day',
    {
      preHandler: ctx.guards.user,
      schema: {
        params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ROOM_ID } },
        querystring: { type: 'object', additionalProperties: false, properties: { date: DATE } },
      },
    },
    async (req): Promise<RoomDayResponse> => desk.day(req.deskUser!, req.params.id, req.query.date ?? today()),
  );

  app.post<{ Params: { id: string }; Body: RoomSlotRequest }>(
    '/api/rooms/:id/slot',
    {
      preHandler: ctx.guards.user,
      schema: {
        params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ROOM_ID } },
        body: {
          type: 'object',
          required: ['date', 'start', 'minutes'],
          additionalProperties: false,
          properties: {
            date: DATE,
            start: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
            minutes: { type: 'integer', minimum: 10, maximum: 600 },
          },
        },
      },
    },
    async (req): Promise<RoomCardsResponse> => {
      if (!ctx.rateLimiter.hit(req.deskUser!.pseudonymId, 'rooms.search')) throw new DeskError('rate-limited', 429, '요청이 많아요. 잠시 뒤에 다시 해 주세요');
      return desk.slotForRoom(req.deskUser!, req.params.id, req.body);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/rooms/reservations/:id',
    {
      preHandler: ctx.guards.user,
      schema: { params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^[0-9]{1,18}$' } } } },
    },
    async (req) => desk.cancel(req.deskUser!, req.params.id),
  );

  // 회의 참석자 초대(ADR-17). 화면이 확인 시트를 먼저 띄우고, 같은 requestId로 두 번 와도 한 번만 보내요.
  const ID_PARAMS = {
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: { id: { type: 'string', pattern: '^[0-9]{1,18}$' } },
  } as const;
  app.post<{ Params: { id: string }; Body: InviteRequest }>(
    '/api/rooms/reservations/:id/invites',
    {
      preHandler: ctx.guards.user,
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          required: ['people', 'calendar', 'slack', 'requestId'],
          additionalProperties: false,
          properties: {
            people: { type: 'array', minItems: 1, maxItems: INVITE_MAX, uniqueItems: true, items: { type: 'string', maxLength: 300 } },
            calendar: { type: 'boolean' },
            slack: { type: 'boolean' },
            requestId: { type: 'string', minLength: 8, maxLength: 64 },
          },
        },
      },
    },
    async (req) => desk.invites.send(req.deskUser!, req.params.id, req.body),
  );

  app.get('/api/rooms/invites', { preHandler: ctx.guards.user }, async (req) => desk.invites.invited(req.deskUser!));

  app.post<{ Params: { id: string }; Body: { response: 'accepted' | 'declined' } }>(
    '/api/rooms/invites/:id/response',
    {
      preHandler: ctx.guards.user,
      schema: {
        params: ID_PARAMS,
        body: { type: 'object', required: ['response'], additionalProperties: false, properties: { response: { enum: ['accepted', 'declined'] } } },
      },
    },
    async (req) => desk.invites.respond(req.deskUser!, req.params.id, req.body.response),
  );

  // 캘린더 파일(.ics). 예약한 사람과 초대받은 사람만 받아요. 서버는 어디에도 보내지 않아요.
  app.get<{ Params: { id: string } }>('/api/rooms/reservations/:id/ics', { preHandler: ctx.guards.user, schema: { params: ID_PARAMS } }, async (req, reply) => {
    const file = await desk.invites.ics(req.deskUser!, req.params.id);
    return reply
      .header('content-type', 'text/calendar; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .header('cache-control', 'no-store')
      .send(file.body);
  });

  // ── 회의실 채팅·장비 대여(ADR-19) ─────────────────────────────

  // 채팅 한 줄. 글은 이 요청의 메모리에서만 다루고 저장하지 않아요(R13). 시킨 예약·대여만 바로 실행해요.
  app.post<{ Body: RoomChatRequest }>(
    '/api/rooms/chat',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['text', 'requestId'],
          additionalProperties: false,
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 500 },
            requestId: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' },
          },
        },
      },
    },
    async (req, reply): Promise<RoomChatResponse | undefined> => {
      const user = req.deskUser!;
      if (!ctx.rateLimiter.hit(user.pseudonymId, 'ask')) {
        return reply.code(429).send({ error: 'rate-limited', message: '요청이 많아요. 잠시 뒤에 다시 보내 주세요.' });
      }
      // 브라우저와 같은 규칙으로 다시 검사해요. 걸리면 내용 없이 버리고 "잠김"만 남겨요(ADR-11).
      const checked = checkInput(req.body.text);
      if (checked.locks.length > 0) {
        await ctx.audit.record({ pseudonymId: user.pseudonymId, channel: 'ask', module: 'rooms', action: 'chat', result: 'locked' });
        return reply.code(422).send({ error: 'locked', message: checked.locks[0]!.message, locks: checked.locks, rulesVersion: checked.rulesVersion });
      }
      const { code, ...answer } = await chat.reply(user, checked.text, req.body.requestId);
      await ctx.audit.record({ pseudonymId: user.pseudonymId, channel: 'ask', module: 'rooms', action: 'chat', result: code });
      return answer;
    },
  );

  app.get('/api/rooms/my-loans', { preHandler: ctx.guards.user }, async (req) => equipment.myLoans(req.deskUser!));

  // [대여 취소](시작 전)·[반납](쓰는 중). 화면이 확인 시트를 먼저 띄워요.
  app.delete<{ Params: { id: string } }>('/api/rooms/loans/:id', { preHandler: ctx.guards.user, schema: { params: ID_PARAMS } }, async (req) =>
    equipment.endLoan(req.deskUser!, req.params.id),
  );

  // 방 설비 상태(정상·점검 중). 총무만 바꿔요.
  app.put<{ Params: { id: string }; Body: { facility: Equipment; status: FacilityStatus } }>(
    '/api/rooms/:id/facilities',
    {
      preHandler: [ctx.guards.user, ctx.guards.role('facilities')],
      schema: {
        params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ROOM_ID } },
        body: {
          type: 'object',
          required: ['facility', 'status'],
          additionalProperties: false,
          properties: { facility: { enum: [...EQUIPMENT] }, status: { enum: ['ok', 'repair'] } },
        },
      },
    },
    async (req) => equipment.setFacility(req.deskUser!, req.params.id, req.body.facility, req.body.status),
  );
}
