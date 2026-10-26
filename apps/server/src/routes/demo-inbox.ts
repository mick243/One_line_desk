import { type DemoInboxResponse, formatKstDateTime, kstTime } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import { MockGroupwareCalendar, MockMessenger } from '../adapters/mock/groupware';
import type { AppContext } from '../context';

// 시연 받은편지함(ADR-17): 모의 그룹웨어 캘린더·모의 Slack이 나에게 보낸 것만 보여 줘요. 실제 어댑터면 닫혀 있어요.
const KEEP_DAYS = 30;

export function registerDemoInboxRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/demo/inbox', { preHandler: ctx.guards.user }, async (req): Promise<DemoInboxResponse> => {
    const user = req.deskUser!;
    const calendarMock = ctx.adapters.calendar instanceof MockGroupwareCalendar;
    const messengerMock = ctx.adapters.messenger instanceof MockMessenger;
    if ((!calendarMock && !messengerMock) || !user.email) return { enabled: false, calendar: [], messages: [] };

    await ctx.db.query('delete from mock_messenger_messages where sent_at < $1', [new Date(ctx.now() - KEEP_DAYS * 86_400_000).toISOString()]);
    const calendar = calendarMock
      ? (
          await ctx.db.query<{ uid: string; title: string; start: number; end: number; location: string; cancelled: boolean }>(
            `select uid, title, (extract(epoch from starts_at) * 1000)::float8 as start, (extract(epoch from ends_at) * 1000)::float8 as end,
                    location, cancelled
               from mock_calendar_events where $1 = any(attendee_emails) or organizer_email = $1
              order by starts_at desc limit 20`,
            [user.email],
          )
        ).rows.map((e) => ({
          uid: e.uid,
          title: e.title,
          when: `${formatKstDateTime(e.start)}~${kstTime(e.end)}`,
          location: e.location,
          cancelled: e.cancelled,
        }))
      : [];
    const messages = messengerMock
      ? (
          await ctx.db.query<{ id: string; text: string; sent: number }>(
            `select id::text as id, text, (extract(epoch from sent_at) * 1000)::float8 as sent
               from mock_messenger_messages where to_email = $1 order by sent_at desc, id desc limit 20`,
            [user.email],
          )
        ).rows.map((m) => ({ id: m.id, text: m.text, sentAt: formatKstDateTime(m.sent) }))
      : [];
    return { enabled: true, calendar, messages };
  });
}
