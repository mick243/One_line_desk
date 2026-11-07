import type { NoticeAudienceCountRequest, NoticeAudienceSendRequest } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import { AUDIENCE_SCHEMA, type AudienceService } from './audience-service';

// 공지 모듈 경로(11/6 새 공지 알림 대상). 확인 화면·대상 수·[알리기]·[알리지 않기]는 총무(역할 facilities)만, "새 공지"는 누구나예요.
// 공지 기능이 켬이 아니면 409예요(고정 버튼 실행기도 같은 스위치를 봐요).

const ID = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^[0-9]{1,18}$' } } } as const;

export function registerNoticeRoutes(app: FastifyInstance, ctx: AppContext, audience: AudienceService): void {
  const user = ctx.guards.user;
  const facilities = [ctx.guards.user, ctx.guards.role('facilities')];
  const on = () => {
    if (ctx.ops.get().modules.notices !== 'on') throw new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
  };

  // 공지 탭 "새 공지": 제목·게시일·원문 링크와 나에게 알림이 간 공지인지만이에요.
  app.get('/api/notices/new', { preHandler: user }, async (req) => {
    on();
    return audience.fresh(req.deskUser!);
  });

  app.get('/api/notices/audience', { preHandler: facilities }, async () => {
    on();
    return audience.list();
  });

  app.post<{ Body: NoticeAudienceCountRequest }>(
    '/api/notices/audience/count',
    {
      preHandler: facilities,
      schema: { body: { type: 'object', required: ['audience'], additionalProperties: false, properties: { audience: AUDIENCE_SCHEMA } } },
    },
    async (req) => {
      on();
      return audience.count(req.body.audience);
    },
  );

  app.post<{ Params: { id: string }; Body: NoticeAudienceSendRequest }>(
    '/api/notices/audience/:id/send',
    {
      preHandler: facilities,
      schema: { params: ID, body: { type: 'object', additionalProperties: false, properties: { audience: AUDIENCE_SCHEMA } } },
    },
    async (req) => audience.send(req.deskUser!, req.params.id, req.body?.audience),
  );

  app.post<{ Params: { id: string } }>('/api/notices/audience/:id/skip', { preHandler: facilities, schema: { params: ID } }, async (req) =>
    audience.skip(req.deskUser!, req.params.id),
  );
}
