import {
  type Card,
  formatKstDateTime,
  INVITE_MAX,
  INVITE_RESPONSE_LABEL,
  type InvitedMeeting,
  type InvitedMeetingsResponse,
  type InviteRequest,
  type InviteResponse,
  type OpsSettings,
  type ReservationAttendee,
} from '@one-line-desk/shared';
import type { EmployeeProfile } from '../../adapters/types';
import type { AppContext } from '../../context';
import { makeCard } from '../../core/cards';
import type { Queryable } from '../../core/db';
import { DeskError } from '../../core/errors';
import { readPersonRef } from '../../core/person-ref';
import { pseudonymize } from '../../core/pseudonym';
import type { DeskUser } from '../../core/user';
import { icsPath, whenText } from './cards';
import { buildIcs } from './ics';

// 회의 참석자 초대(10/26, ADR-17). 예약한 사람이 직원 검색에서 고른 사람에게만 알려요.
// - 앱 안 알림은 늘 가요(쓰기 트랜잭션 안). 그룹웨어 캘린더 초대·Slack DM은 고르면 트랜잭션이 끝난 뒤 보내요.
// - 초대받은 사람만 회의실·시간·부른 사람 이름을 봐요. 다른 직원의 하루 일정에는 그대로 "예약됨"만 보여요(ADR-06 예외).
// - 바깥으로 가는 글에는 부른 사람 이름·시간·회의실만 넣어요. 회의 제목 칸은 없어요. LLM은 부르지 않아요.

interface Meeting {
  id: string;
  roomName: string;
  floor: string;
  start: number;
  end: number;
  owner: string;
}

interface InviteRow {
  attendeePseudonym: string;
  attendeeSubject: string;
  inviterPseudonym: string;
  inviterSubject: string;
  response: InviteResponse;
  viaCalendar: boolean;
  viaSlack: boolean;
}

const MEETING_COLUMNS = `x.id::text as id, r.name as "roomName", r.floor,
  (extract(epoch from lower(x.slot)) * 1000)::float8 as start,
  (extract(epoch from upper(x.slot)) * 1000)::float8 as "end", x.pseudonym_id as owner`;

const INVITE_COLUMNS = `attendee_pseudonym as "attendeePseudonym", attendee_subject as "attendeeSubject",
  inviter_pseudonym as "inviterPseudonym", inviter_subject as "inviterSubject", response,
  via_calendar as "viaCalendar", via_slack as "viaSlack"`;

async function findMeeting(q: Queryable, id: string): Promise<Meeting | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const { rows } = await q.query<Meeting>(
    `select ${MEETING_COLUMNS} from room_reservations x join rooms r on r.id = x.room_id where x.id = $1 and x.source = 'app'`,
    [id],
  );
  return rows[0] ?? null;
}

async function invitesOf(q: Queryable, reservationId: string): Promise<InviteRow[]> {
  const { rows } = await q.query<InviteRow>(`select ${INVITE_COLUMNS} from room_invites where reservation_id = $1 order by invited_at, attendee_pseudonym`, [
    reservationId,
  ]);
  return rows;
}

const writeOn = (s: OpsSettings) => s.modules.rooms === 'on' && s.roomsWrite;
const calendarUid = (reservationId: string) => `one-line-desk-reservation-${reservationId}`;

/** 취소한 뒤 바깥으로 알릴 것(트랜잭션이 끝난 뒤 보내요) */
export interface CancelFollowUp {
  meeting: Meeting;
  invites: InviteRow[];
  by: DeskUser;
}

export function createInviteService(ctx: AppContext) {
  const appUrl = `${ctx.config.publicBaseUrl}/`;
  /** 한 번의 일 안에서 같은 사람을 여러 번 찾지 않게 기억해요(일이 끝나면 버려요). */
  const lookup = () => {
    const seen = new Map<string, Promise<EmployeeProfile | null>>();
    return (subject: string) => {
      let found = seen.get(subject);
      if (!found) {
        found = ctx.adapters.directory.getProfile(subject);
        seen.set(subject, found);
      }
      return found;
    };
  };

  async function outboundSlack(to: { email?: string }[], text: string): Promise<{ sent: number; missing: number; failed: number; sentTo: Set<string> }> {
    const out = { sent: 0, missing: 0, failed: 0, sentTo: new Set<string>() };
    for (const person of to) {
      if (!person.email) {
        out.missing += 1;
        continue;
      }
      try {
        const r = await ctx.adapters.messenger.sendDirect({ toEmail: person.email, text });
        if (r === 'sent') {
          out.sent += 1;
          out.sentTo.add(person.email);
        } else out.missing += 1;
      } catch {
        out.failed += 1;
      }
    }
    return out;
  }

  return {
    /** 참석자 초대 보내기. 같은 requestId로 두 번 와도 한 번만 보내요. */
    async send(user: DeskUser, reservationId: string, req: InviteRequest): Promise<{ status: 'done'; card: Card }> {
      if (!writeOn(ctx.ops.get())) throw new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
      if (!ctx.rateLimiter.hit(user.pseudonymId, 'invite')) throw new DeskError('rate-limited', 429, '요청이 많아요. 잠시 뒤에 다시 보내 주세요');
      const now = ctx.now();
      const subjects = [...new Set(req.people.map((ref) => readPersonRef(ctx.config.pseudonymSecret, ref, user.pseudonymId, now)))];
      if (subjects.length === 0 || subjects.some((s) => s === null)) throw new DeskError('bad-request', 400, '고른 사람을 확인하지 못했어요. 다시 골라 주세요');
      const meeting = await findMeeting(ctx.db, reservationId);
      if (!meeting || meeting.owner !== user.pseudonymId) throw new DeskError('not-found', 404, '내 예약을 찾지 못했어요');
      if (meeting.end <= ctx.now()) throw new DeskError('ended', 409, '이미 끝난 회의예요');
      const profile = lookup();

      const chosen: EmployeeProfile[] = [];
      for (const subject of subjects as string[]) {
        if (subject === user.idpSubject) continue;
        const p = await profile(subject);
        if (!p || !(await ctx.adapters.idp.isActive(subject))) throw new DeskError('bad-request', 400, '고른 사람 중에 지금 부를 수 없는 사람이 있어요');
        chosen.push(p);
      }
      const already = await invitesOf(ctx.db, reservationId);
      if (already.length + chosen.length > INVITE_MAX) throw new DeskError('bad-request', 400, `한 회의에 ${INVITE_MAX}명까지 부를 수 있어요`);

      let fresh: EmployeeProfile[] | null = null;
      const when = formatKstDateTime(meeting.start);
      const result = await ctx.fixed.run<{ status: 'done'; card: Card }>(user, {
        module: 'rooms',
        action: 'invite',
        idempotencyKey: req.requestId,
        enabled: writeOn,
        resultCode: () => 'done',
        run: async (q, now) => {
          const added: EmployeeProfile[] = [];
          for (const p of chosen) {
            const pseudonym = pseudonymize(ctx.config.pseudonymSecret, p.idpSubject);
            const { rows } = await q.query(
              `insert into room_invites (reservation_id, attendee_pseudonym, attendee_subject, inviter_pseudonym, inviter_subject, invited_at)
               values ($1, $2, $3, $4, $5, $6) on conflict do nothing returning attendee_pseudonym`,
              [reservationId, pseudonym, p.idpSubject, user.pseudonymId, user.idpSubject, new Date(now).toISOString()],
            );
            if (!rows.length) continue;
            added.push(p);
            await ctx.notify.toUser(q, pseudonym, { module: 'rooms', title: `${user.displayName}님이 회의에 불렀어요 · ${when}`, page: 'rooms' });
          }
          fresh = added;
          return { status: 'done', card: invitedCard(meeting, { app: added.length, calendar: null, slack: null }) };
        },
      });
      const added = fresh as EmployeeProfile[] | null;
      if (!added) return result; // 같은 요청이 다시 왔어요. 바깥으로 다시 보내지 않아요.

      // 그룹웨어 캘린더 초대: 지금 참석자 모두로 일정을 만들거나 고쳐요(초대 메일은 그룹웨어가 보내요).
      let calendar: number | null = null;
      if (req.calendar && added.length) {
        calendar = 0;
        const all = await invitesOf(ctx.db, reservationId);
        const emails = (await Promise.all(all.map((i) => profile(i.attendeeSubject)))).flatMap((p) => (p?.email ? [p.email] : []));
        if (user.email && emails.length) {
          try {
            await ctx.adapters.calendar.upsertEvent({
              uid: calendarUid(reservationId),
              title: `회의 · ${meeting.roomName}`,
              start: new Date(meeting.start).toISOString(),
              end: new Date(meeting.end).toISOString(),
              location: `${meeting.roomName} (${meeting.floor})`,
              organizerEmail: user.email,
              attendeeEmails: emails,
            });
            const addedEmails = new Set(added.flatMap((p) => (p.email ? [p.email] : [])));
            calendar = addedEmails.size;
            await ctx.db.query('update room_invites set via_calendar = true where reservation_id = $1 and attendee_subject = any($2)', [
              reservationId,
              added.filter((p) => p.email).map((p) => p.idpSubject),
            ]);
          } catch {
            calendar = -1;
          }
        }
      }

      // Slack DM: 이번에 새로 부른 사람에게만 보내요.
      let slack: { sent: number; missing: number; failed: number } | null = null;
      if (req.slack && added.length) {
        const text = `${user.displayName}님이 회의에 불렀어요 · ${whenText(meeting.start, meeting.end)} · ${meeting.roomName}(${meeting.floor}) · 한 줄 데스크에서 보기: ${appUrl}`;
        const r = await outboundSlack(added, text);
        slack = { sent: r.sent, missing: r.missing, failed: r.failed };
        const sentSubjects = added.filter((p) => p.email && r.sentTo.has(p.email)).map((p) => p.idpSubject);
        if (sentSubjects.length)
          await ctx.db.query('update room_invites set via_slack = true where reservation_id = $1 and attendee_subject = any($2)', [
            reservationId,
            sentSubjects,
          ]);
      }

      await ctx.audit.record({
        pseudonymId: user.pseudonymId,
        channel: 'write',
        module: 'rooms',
        action: 'invite.outbound',
        result: `app:${added.length},calendar:${calendar ?? 'no'},slack:${slack ? `${slack.sent}/${added.length}` : 'no'}`,
      });
      return { status: 'done', card: invitedCard(meeting, { app: added.length, calendar, slack }) };
    },

    /** 예약한 사람이 보는 참석자와 답(내 예약 칸) */
    async attendees(reservationId: string): Promise<ReservationAttendee[]> {
      const profile = lookup();
      const rows = await invitesOf(ctx.db, reservationId);
      const out: ReservationAttendee[] = [];
      for (const r of rows) {
        const p = await profile(r.attendeeSubject);
        out.push({ name: p?.displayName ?? '알 수 없는 직원', department: p?.department ?? '', response: r.response });
      }
      return out;
    },

    /** 나를 부른 회의(다가오는 것만). 초대받은 사람만 회의실·시간·부른 사람을 봐요. */
    async invited(user: DeskUser): Promise<InvitedMeetingsResponse> {
      const enabled = writeOn(ctx.ops.get());
      if (!enabled) return { enabled, items: [] };
      const { rows } = await ctx.db.query<Meeting & { response: InviteResponse; inviterSubject: string }>(
        `select ${MEETING_COLUMNS}, i.response, i.inviter_subject as "inviterSubject"
           from room_invites i join room_reservations x on x.id = i.reservation_id join rooms r on r.id = x.room_id
          where i.attendee_pseudonym = $1 and upper(x.slot) > $2
          order by lower(x.slot), x.id`,
        [user.pseudonymId, new Date(ctx.now()).toISOString()],
      );
      const profile = lookup();
      const items: InvitedMeeting[] = [];
      for (const m of rows) {
        const inviter = await profile(m.inviterSubject);
        items.push({
          reservationId: m.id,
          roomName: m.roomName,
          floor: m.floor,
          when: whenText(m.start, m.end),
          start: new Date(m.start).toISOString(),
          end: new Date(m.end).toISOString(),
          inviter: { name: inviter?.displayName ?? '알 수 없는 직원', department: inviter?.department ?? '' },
          response: m.response,
          icsPath: icsPath(m.id),
          actions: (['accepted', 'declined'] as const)
            .filter((r) => r !== m.response)
            .map((r) => ({
              type: 'fixed' as const,
              text: r === 'accepted' ? '참석할게요' : '못 가요',
              method: 'POST' as const,
              path: `/api/rooms/invites/${m.id}/response`,
              body: { response: r },
            })),
        });
      }
      return { enabled, items };
    },

    /** 참석·못 가요 답. 부른 사람에게 알림이 가요. 답은 몇 번이든 바꿀 수 있어요. */
    async respond(user: DeskUser, reservationId: string, response: 'accepted' | 'declined'): Promise<{ ok: true }> {
      const meeting = await findMeeting(ctx.db, reservationId);
      if (!meeting || meeting.end <= ctx.now()) throw new DeskError('not-found', 404, '초대받은 회의를 찾지 못했어요');
      return ctx.fixed.run(user, {
        module: 'rooms',
        action: 'invite.respond',
        enabled: writeOn,
        run: async (q, now) => {
          const { rows } = await q.query<{ inviter: string; before: InviteResponse }>(
            `update room_invites i set response = $3, responded_at = $4
               from room_invites old
              where i.reservation_id = $1 and i.attendee_pseudonym = $2
                and old.reservation_id = i.reservation_id and old.attendee_pseudonym = i.attendee_pseudonym
              returning i.inviter_pseudonym as inviter, old.response as before`,
            [reservationId, user.pseudonymId, response, new Date(now).toISOString()],
          );
          const row = rows[0];
          if (!row) throw new DeskError('not-found', 404, '초대받은 회의를 찾지 못했어요');
          if (row.before !== response) {
            const said = response === 'accepted' ? '참석해요' : '못 온대요';
            await ctx.notify.toUser(q, row.inviter, {
              module: 'rooms',
              title: `${user.displayName}님이 ${said} · ${formatKstDateTime(meeting.start)}`,
              page: 'mine',
            });
          }
          return { ok: true as const };
        },
      });
    },

    /** 캘린더 파일(.ics). 예약한 사람과 초대받은 사람만 받아요. */
    async ics(user: DeskUser, reservationId: string): Promise<{ filename: string; body: string }> {
      const meeting = await findMeeting(ctx.db, reservationId);
      if (!meeting) throw new DeskError('not-found', 404, '회의를 찾지 못했어요');
      const mine = meeting.owner === user.pseudonymId;
      const invited = !mine && (await invitesOf(ctx.db, reservationId)).some((i) => i.attendeePseudonym === user.pseudonymId);
      if (!mine && !invited) throw new DeskError('not-found', 404, '회의를 찾지 못했어요');
      const day = new Date(meeting.start + 9 * 3_600_000).toISOString().slice(0, 10);
      return {
        filename: `meeting-${day}-${reservationId}.ics`,
        body: buildIcs({
          uid: calendarUid(reservationId),
          roomName: meeting.roomName,
          floor: meeting.floor,
          start: meeting.start,
          end: meeting.end,
          stamp: ctx.now(),
          url: appUrl,
        }),
      };
    },

    /** 취소 트랜잭션 안: 참석자에게 앱 알림을 넣고, 바깥으로 알릴 것을 돌려줘요. 참석자 줄은 예약과 함께 지워져요. */
    async beforeCancel(q: Queryable, reservationId: string, by: DeskUser): Promise<CancelFollowUp | null> {
      const meeting = await findMeeting(q, reservationId);
      if (!meeting || meeting.owner !== by.pseudonymId) return null;
      const invites = await invitesOf(q, reservationId);
      for (const i of invites) {
        await ctx.notify.toUser(q, i.attendeePseudonym, {
          module: 'rooms',
          title: `${by.displayName}님이 회의를 취소했어요 · ${formatKstDateTime(meeting.start)}`,
          page: 'rooms',
        });
      }
      return invites.length ? { meeting, invites, by } : null;
    },

    /** 취소가 끝난 뒤: 캘린더 일정을 취소하고, Slack으로 알렸던 사람에게 취소를 알려요. 실패해도 취소는 그대로예요. */
    async afterCancel(f: CancelFollowUp): Promise<void> {
      const profile = lookup();
      if (f.invites.some((i) => i.viaCalendar)) await ctx.adapters.calendar.cancelEvent(calendarUid(f.meeting.id)).catch(() => undefined);
      const slackPeople = (await Promise.all(f.invites.filter((i) => i.viaSlack).map((i) => profile(i.attendeeSubject)))).flatMap((p) => (p ? [p] : []));
      if (slackPeople.length) {
        const text = `${f.by.displayName}님이 회의를 취소했어요 · ${whenText(f.meeting.start, f.meeting.end)} · ${f.meeting.roomName}(${f.meeting.floor})`;
        await outboundSlack(slackPeople, text);
      }
    },
  };
}

export type InviteService = ReturnType<typeof createInviteService>;

/** 보낸 결과 카드: 앱 알림 N명 · 캘린더 · Slack */
function invitedCard(m: Meeting, sent: { app: number; calendar: number | null; slack: { sent: number; missing: number; failed: number } | null }): Card {
  const fields = [
    { name: '회의', value: `${m.roomName} · ${whenText(m.start, m.end)}` },
    { name: '앱 알림', value: sent.app ? `${sent.app}명에게 보냈어요` : '새로 부른 사람이 없어요(이미 부른 사람이에요)' },
  ];
  if (sent.calendar !== null) {
    fields.push({
      name: '그룹웨어 캘린더',
      value: sent.calendar < 0 ? '보내지 못했어요. 캘린더 파일로 직접 보내 주세요' : `${sent.calendar}명에게 초대를 보냈어요`,
    });
  }
  if (sent.slack) {
    const extra = [
      sent.slack.missing ? `${sent.slack.missing}명은 Slack에서 못 찾았어요` : '',
      sent.slack.failed ? `${sent.slack.failed}명은 보내지 못했어요` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    fields.push({ name: 'Slack DM', value: `${sent.slack.sent}명에게 보냈어요${extra ? ` · ${extra}` : ''}` });
  }
  return makeCard({
    id: `rooms-invite-${m.id}`,
    kind: 'rooms',
    label: '확정',
    headline: '참석자에게 알렸어요',
    fields,
    evidence: { text: '고른 사람만 회의실·시간·내 이름을 봐요. 다른 직원에게는 "예약됨"만 보여요', aiSummarized: false },
    primary: { type: 'link', text: '캘린더 파일 받기', href: icsPath(m.id) },
    secondary: [],
    tail: `답(${INVITE_RESPONSE_LABEL.accepted}·${INVITE_RESPONSE_LABEL.declined})은 마이 페이지 > 내 예약에서 봐요`,
  });
}
