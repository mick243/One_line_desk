import type { NotificationReadRequest, NotificationsResponse } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';

// 앱 안 알림(ADR-16). 내 알림만 읽고, 읽음 표시만 써요. 알림 글에는 내용이 없어요.
export function registerNotificationRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/notifications', { preHandler: ctx.guards.user }, async (req): Promise<NotificationsResponse> => ctx.notify.list(req.deskUser!));

  app.post<{ Body: NotificationReadRequest }>(
    '/api/notifications/read',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { ids: { type: 'array', maxItems: 50, items: { type: 'string', pattern: '^[0-9]{1,18}$' } } },
        },
      },
    },
    async (req): Promise<NotificationsResponse> => {
      await ctx.notify.markRead(req.deskUser!, req.body?.ids);
      return ctx.notify.list(req.deskUser!);
    },
  );
}
