import type { Db } from '../../core/db';
import type { AdapterCapabilities, CalendarAdapter, CalendarEvent, MessengerAdapter } from '../types';

// 모의 그룹웨어 캘린더·모의 Slack(10/26, ADR-17). 실제 서비스 대신 DB 표에 적고, "마이 페이지"의 시연 받은편지함에서 보여 줘요.
// 가상 직원 메일만 들어와요. 실제 어댑터(그룹웨어 API·Slack 봇)로 바꿔도 부르는 쪽은 그대로예요(ADR-05).

export class MockGroupwareCalendar implements CalendarAdapter {
  readonly capabilities: AdapterCapabilities = { name: 'mock-groupware-calendar', label: '그룹웨어 캘린더(모의)', mock: true };

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  async upsertEvent(e: CalendarEvent): Promise<void> {
    await this.db.query(
      `insert into mock_calendar_events (uid, title, starts_at, ends_at, location, organizer_email, attendee_emails, cancelled, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, false, $8)
       on conflict (uid) do update set title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         location = excluded.location, attendee_emails = excluded.attendee_emails, cancelled = false, updated_at = excluded.updated_at`,
      [e.uid, e.title, e.start, e.end, e.location, e.organizerEmail, e.attendeeEmails, new Date(this.now()).toISOString()],
    );
  }

  async cancelEvent(uid: string): Promise<void> {
    await this.db.query('update mock_calendar_events set cancelled = true, updated_at = $2 where uid = $1', [uid, new Date(this.now()).toISOString()]);
  }
}

export class MockMessenger implements MessengerAdapter {
  readonly capabilities: AdapterCapabilities = { name: 'mock-slack', label: 'Slack(모의)', mock: true };

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  async sendDirect(m: { toEmail: string; text: string }): Promise<'sent' | 'not-found'> {
    // 모의 워크스페이스에는 가상 직원(corp.example 메일)만 있어요.
    if (!m.toEmail.endsWith('@corp.example')) return 'not-found';
    await this.db.query('insert into mock_messenger_messages (to_email, text, sent_at) values ($1, $2, $3)', [
      m.toEmail,
      m.text.slice(0, 500),
      new Date(this.now()).toISOString(),
    ]);
    return 'sent';
  }
}
