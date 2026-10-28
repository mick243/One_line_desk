import { type DemoInboxResponse, formatKstDateTime, kstTime, recordCutoff } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import { MockGroupwareCalendar, MockMessenger } from '../adapters/mock/groupware';
import type { AppContext } from '../context';

// 시연 받은편지함(ADR-17): 모의 그룹웨어 캘린더·모의 Slack이 나에게 보낸 것만 보여 줘요. 실제 어댑터면 닫혀 있어요.

/** 보관 기간(7일, 10/28)이 지난 시연 메시지와, 끝났거나 취소한 지 7일 지난 시연 일정을 지워요. 서버가 한 시간마다, 열 때도 불러요. */
export async function purgeDemoInbox(ctx: Pick<AppContext, 'db' | 'now'>): Promise<void> {
  const at = new Date(recordCutoff(ctx.now())).toISOString();
  await ctx.db.query('delete from mock_messenger_messages where sent_at < $1', [at]);
  await ctx.db.query('delete from mock_calendar_events where ends_at < $1 or (cancelled and updated_at < $1)', [at]);
}

export function registerDemoInboxRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/demo/inbox', { preHandler: ctx.guards.user }, async (req): Promise<DemoInboxResponse> => {
    const user = req.deskUser!;
    const calendarMock = ctx.adapters.calendar instanceof MockGroupwareCalendar;
    const messengerMock = ctx.adapters.messenger instanceof MockMessenger;
    if ((!calendarMock && !messengerMock) || !user.email) return { enabled: false, calendar: [], messages: [] };

    await purgeDemoInbox(ctx);
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
