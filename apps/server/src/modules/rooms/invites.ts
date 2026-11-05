import {
  type Card,
  checkInput,
  formatKstDateTime,
  INVITE_MAX,
  INVITE_REASON_MAX,
  type InviteColleaguesResponse,
  type InviteDeclineBody,
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
import { personRef, readPersonRef } from '../../core/person-ref';
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
  declineReason: string | null;
  delegatedBySubject: string | null;
  delegateReason: string | null;
}

const MEETING_COLUMNS = `x.id::text as id, r.name as "roomName", r.floor,
  (extract(epoch from lower(x.slot)) * 1000)::float8 as start,
  (extract(epoch from upper(x.slot)) * 1000)::float8 as "end", x.pseudonym_id as owner`;

const INVITE_COLUMNS = `attendee_pseudonym as "attendeePseudonym", attendee_subject as "attendeeSubject",
  inviter_pseudonym as "inviterPseudonym", inviter_subject as "inviterSubject", response,
  via_calendar as "viaCalendar", via_slack as "viaSlack", decline_reason as "declineReason",
  delegated_by_subject as "delegatedBySubject", delegate_reason as "delegateReason"`;

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

/** 못 가요·대신 부탁 사유(11/4): 꼭 적고, 200자까지, 공통 입력 검사(키·주민번호 등)를 지나야 해요. */
function checkedReason(text: string): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new DeskError('bad-request', 400, '못 가는 사유를 적어 주세요');
  if (trimmed.length > INVITE_REASON_MAX) throw new DeskError('bad-request', 400, `사유는 ${INVITE_REASON_MAX}자까지 적을 수 있어요`);
  const result = checkInput(trimmed);
  if (result.locks.length) throw new DeskError('locked', 400, `보낼 수 없는 글자가 있어요: ${[...new Set(result.locks.map((l) => l.message))].join(' · ')}`);
  return result.text;
}

/**
 * 내가 대신 부탁해서 생긴 초대 중 아직 참석한다고 하지 않은 것(11/5). 부탁받은 사람이 못 간다고 하며 또 부탁했으면 그 아래도 따라가요.
 * 참석한다고 한 사람에서 멈춰요. 다시 참석할 때 이 초대들을 거둬요.
 */
function openDelegations(all: InviteRow[], fromSubject: string): InviteRow[] {
  const out: InviteRow[] = [];
  const seen = new Set([fromSubject]);
  let parents = [fromSubject];
  while (parents.length) {
    const next = all.filter(
      (i) => i.delegatedBySubject !== null && parents.includes(i.delegatedBySubject) && i.response !== 'accepted' && !seen.has(i.attendeeSubject),
    );
    for (const i of next) seen.add(i.attendeeSubject);
    out.push(...next);
    parents = next.filter((i) => i.response === 'declined').map((i) => i.attendeeSubject);
  }
  return out;
}

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

  /** Slack이 연결돼 있는지(연결 안 함 어댑터면 보내지 않아요) */
  const slackOn = () => ctx.adapters.messenger.capabilities.name !== 'messenger-off';

  /** 그룹웨어 일정 참석자 메일. 못 간다고 한 사람은 빼요(11/5 사용자 결정). */
  async function calendarEmails(rows: InviteRow[], profile: ReturnType<typeof lookup>): Promise<string[]> {
    const people = await Promise.all(rows.filter((i) => i.response !== 'declined').map((i) => profile(i.attendeeSubject)));
    return people.flatMap((p) => (p?.email ? [p.email] : []));
  }

  /**
   * 그룹웨어 일정이 있는 회의면 참석자를 지금 답에 맞춰요(11/5): 못 간다고 하면 빼고, 다시 참석하면 넣고, 거둔 부탁은 빼요.
   * 주최자는 부른 사람(예약한 사람)이에요. 트랜잭션이 끝난 뒤 부르고, 실패해도 답은 그대로예요.
   */
  async function syncCalendar(meeting: Meeting, reservationId: string, organizerSubject: string): Promise<void> {
    const profile = lookup();
    const organizer = await profile(organizerSubject).catch(() => null);
    if (!organizer?.email) return;
    const emails = await calendarEmails(await invitesOf(ctx.db, reservationId), profile);
    await ctx.adapters.calendar
      .upsertEvent({
        uid: calendarUid(reservationId),
        title: `회의 · ${meeting.roomName}`,
        start: new Date(meeting.start).toISOString(),
        end: new Date(meeting.end).toISOString(),
        location: `${meeting.roomName} (${meeting.floor})`,
        organizerEmail: organizer.email,
        attendeeEmails: emails,
      })
      .catch(() => undefined);
  }

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

  /**
   * 앱 알림 뒤 바깥으로 알리기(트랜잭션이 끝난 뒤). 예약한 사람이 직접 고른 초대와 여러 팀 회의에서 팀장·담당자가 고른 초대(ADR-28)가 같이 써요.
   * - 그룹웨어 캘린더: 지금 참석자(못 간다고 한 사람 빼고, 11/5)로 일정을 만들거나 고쳐요(초대 메일은 그룹웨어가 보내요). 주최자는 예약한 사람이에요.
   * - Slack DM: 이번에 새로 부른 사람에게만 보내요. 대신 부탁(delegated)이면 "대신 가 달라는 부탁" 글이에요.
   *   글에는 부른 사람 이름·시간·회의실·앱 주소만 넣어요. 부탁한 사람 이름과 사유는 앱 안에서만 보여요.
   */
  async function deliver(
    meeting: Meeting,
    reservationId: string,
    inviter: { displayName: string; email?: string },
    added: EmployeeProfile[],
    opts: { calendar: boolean; slack: boolean; delegated?: boolean },
  ): Promise<{ calendar: number | null; slack: { sent: number; missing: number; failed: number } | null }> {
    const profile = lookup();
    let calendar: number | null = null;
    if (opts.calendar && added.length) {
      calendar = 0;
      const emails = await calendarEmails(await invitesOf(ctx.db, reservationId), profile);
      if (inviter.email && emails.length) {
        try {
          await ctx.adapters.calendar.upsertEvent({
            uid: calendarUid(reservationId),
            title: `회의 · ${meeting.roomName}`,
            start: new Date(meeting.start).toISOString(),
            end: new Date(meeting.end).toISOString(),
            location: `${meeting.roomName} (${meeting.floor})`,
            organizerEmail: inviter.email,
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
    let slack: { sent: number; missing: number; failed: number } | null = null;
    if (opts.slack && added.length) {
      const what = opts.delegated ? `${inviter.displayName}님 회의에 대신 가 달라는 부탁이 왔어요` : `${inviter.displayName}님이 회의에 불렀어요`;
      const text = `${what} · ${whenText(meeting.start, meeting.end)} · ${meeting.roomName}(${meeting.floor}) · 한 줄 데스크에서 보기: ${appUrl}`;
      const r = await outboundSlack(added, text);
      slack = { sent: r.sent, missing: r.missing, failed: r.failed };
      const sentSubjects = added.filter((p) => p.email && r.sentTo.has(p.email)).map((p) => p.idpSubject);
      if (sentSubjects.length)
        await ctx.db.query('update room_invites set via_slack = true where reservation_id = $1 and attendee_subject = any($2)', [reservationId, sentSubjects]);
    }
    return { calendar, slack };
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

      const { calendar, slack } = await deliver(meeting, reservationId, user, added, { calendar: req.calendar, slack: req.slack });

      await ctx.audit.record({
        pseudonymId: user.pseudonymId,
        channel: 'write',
        module: 'rooms',
        action: 'invite.outbound',
        result: `app:${added.length},calendar:${calendar ?? 'no'},slack:${slack ? `${slack.sent}/${added.length}` : 'no'}`,
      });
      return { status: 'done', card: invitedCard(meeting, { app: added.length, calendar, slack }) };
    },

    /**
     * 여러 팀 회의에서 팀장·담당자가 고른 사람에게 바깥으로 알려요(ADR-28, 트랜잭션이 끝난 뒤). 부른 사람(주최자)은 예약한 사람이에요.
     * 감사에는 고른 사람(by) 이름 없이 동작·수만 남겨요.
     */
    async deliverPicked(by: DeskUser, reservationId: string, subjects: string[], opts: { calendar: boolean; slack: boolean; delegated?: boolean }) {
      const meeting = await findMeeting(ctx.db, reservationId);
      if (!meeting || !subjects.length) return { calendar: null, slack: null };
      const owner = (await invitesOf(ctx.db, reservationId)).find((i) => subjects.includes(i.attendeeSubject));
      const profile = lookup();
      const inviter = owner ? await profile(owner.inviterSubject) : null;
      const added = (await Promise.all(subjects.map((s) => profile(s)))).filter((p): p is EmployeeProfile => Boolean(p));
      const out = await deliver(
        meeting,
        reservationId,
        { displayName: inviter?.displayName ?? '예약한 사람', ...(inviter?.email ? { email: inviter.email } : {}) },
        added,
        opts,
      );
      await ctx.audit.record({
        pseudonymId: by.pseudonymId,
        channel: 'write',
        module: 'rooms',
        action: 'invite.outbound',
        result: `app:${added.length},calendar:${out.calendar ?? 'no'},slack:${out.slack ? `${out.slack.sent}/${added.length}` : 'no'}`,
      });
      return out;
    },

    /** 회의실을 옮긴 뒤(ADR-28) 그룹웨어 캘린더 일정이 있으면 장소를 고쳐요. 실패해도 옮기기는 그대로예요. */
    async relocated(user: DeskUser, reservationId: string): Promise<void> {
      const meeting = await findMeeting(ctx.db, reservationId);
      const all = await invitesOf(ctx.db, reservationId);
      if (!meeting || !user.email || !all.some((i) => i.viaCalendar)) return;
      const emails = await calendarEmails(all, lookup());
      await ctx.adapters.calendar
        .upsertEvent({
          uid: calendarUid(reservationId),
          title: `회의 · ${meeting.roomName}`,
          start: new Date(meeting.start).toISOString(),
          end: new Date(meeting.end).toISOString(),
          location: `${meeting.roomName} (${meeting.floor})`,
          organizerEmail: user.email,
          attendeeEmails: emails,
        })
        .catch(() => undefined);
    },

    /** 예약한 사람이 보는 참석자와 답(내 예약 칸) */
    async attendees(reservationId: string): Promise<ReservationAttendee[]> {
      const profile = lookup();
      const rows = await invitesOf(ctx.db, reservationId);
      const out: ReservationAttendee[] = [];
      for (const r of rows) {
        const p = await profile(r.attendeeSubject);
        const by = r.delegatedBySubject ? await profile(r.delegatedBySubject) : null;
        out.push({
          name: p?.displayName ?? '알 수 없는 직원',
          department: p?.department ?? '',
          response: r.response,
          ...(r.response === 'declined' && r.declineReason ? { reason: r.declineReason } : {}),
          ...(r.delegatedBySubject ? { delegatedBy: by?.displayName ?? '알 수 없는 직원' } : {}),
        });
      }
      return out;
    },

    /** 나를 부른 회의(다가오는 것만). 초대받은 사람만 회의실·시간·부른 사람을 봐요. */
    async invited(user: DeskUser): Promise<InvitedMeetingsResponse> {
      const enabled = writeOn(ctx.ops.get());
      if (!enabled) return { enabled, items: [] };
      const { rows } = await ctx.db.query<
        Meeting & {
          response: InviteResponse;
          inviterSubject: string;
          declineReason: string | null;
          delegatedBySubject: string | null;
          delegateReason: string | null;
          openDelegation: boolean;
        }
      >(
        `select ${MEETING_COLUMNS}, i.response, i.inviter_subject as "inviterSubject", i.decline_reason as "declineReason",
                i.delegated_by_subject as "delegatedBySubject", i.delegate_reason as "delegateReason",
                exists (select 1 from room_invites d
                         where d.reservation_id = i.reservation_id and d.delegated_by_pseudonym = i.attendee_pseudonym
                           and d.response <> 'accepted') as "openDelegation"
           from room_invites i join room_reservations x on x.id = i.reservation_id join rooms r on r.id = x.room_id
          where i.attendee_pseudonym = $1 and upper(x.slot) > $2
          order by lower(x.slot), x.id`,
        [user.pseudonymId, new Date(ctx.now()).toISOString()],
      );
      const profile = lookup();
      const items: InvitedMeeting[] = [];
      for (const m of rows) {
        const inviter = await profile(m.inviterSubject);
        const by = m.delegatedBySubject ? await profile(m.delegatedBySubject) : null;
        items.push({
          reservationId: m.id,
          roomName: m.roomName,
          floor: m.floor,
          when: whenText(m.start, m.end),
          start: new Date(m.start).toISOString(),
          end: new Date(m.end).toISOString(),
          inviter: { name: inviter?.displayName ?? '알 수 없는 직원', department: inviter?.department ?? '' },
          response: m.response,
          ...(m.response === 'declined' && m.declineReason ? { declineReason: m.declineReason } : {}),
          ...(m.delegatedBySubject && m.delegateReason ? { delegatedBy: { name: by?.displayName ?? '알 수 없는 직원', reason: m.delegateReason } } : {}),
          icsPath: icsPath(m.id),
          // [못 가요]는 사유를 꼭 적는 양식이라 화면이 띄워요(11/4). 고정 버튼은 [참석할게요]뿐이에요.
          actions:
            m.response === 'accepted'
              ? []
              : [
                  {
                    type: 'fixed' as const,
                    text: '참석할게요',
                    method: 'POST' as const,
                    path: `/api/rooms/invites/${m.id}/response`,
                    body: { response: 'accepted' },
                    // 대신 부탁한 사람이 아직 참석한다고 하지 않았으면, 다시 참석할 때 그 부탁을 거둬요(11/5). 먼저 알려요.
                    ...(m.openDelegation
                      ? {
                          confirm: {
                            title: '다시 참석할까요?',
                            lines: [`${m.roomName} · ${whenText(m.start, m.end)}`, '대신 가 달라고 한 부탁은 거둬요. 이미 참석한다고 한 사람은 그대로예요'],
                            confirmLabel: '참석할게요',
                          },
                        }
                      : {}),
                  },
                ],
          canDecline: m.response !== 'declined',
        });
      }
      return { enabled, items };
    },

    /**
     * [참석할게요]. 부른 사람에게 알림이 가요. 못 갔다가 다시 간다고 하면 적었던 사유는 지워요. 못 가요는 decline(사유 필수)이에요.
     * 11/5: 내가 대신 부탁한 사람이 아직 참석한다고 하지 않았으면 그 부탁을 거둬요. 그 사람이 또 부탁했으면 거기까지 같은 규칙이에요.
     * 이미 참석한다고 한 사람은 그대로 둬요. 그룹웨어 일정이 있으면 참석자를 지금 답에 맞춰요.
     */
    async respond(user: DeskUser, reservationId: string, response: 'accepted'): Promise<{ ok: true }> {
      const meeting = await findMeeting(ctx.db, reservationId);
      if (!meeting || meeting.end <= ctx.now()) throw new DeskError('not-found', 404, '초대받은 회의를 찾지 못했어요');
      let followUp: { inviterSubject: string; withdrawn: InviteRow[]; calendar: boolean } | null = null;
      const result = await ctx.fixed.run(user, {
        module: 'rooms',
        action: 'invite.respond',
        enabled: writeOn,
        run: async (q, now) => {
          const all = await invitesOf(q, reservationId);
          const { rows } = await q.query<{ inviter: string; before: InviteResponse }>(
            `update room_invites i set response = $3, responded_at = $4, decline_reason = null
               from room_invites old
              where i.reservation_id = $1 and i.attendee_pseudonym = $2
                and old.reservation_id = i.reservation_id and old.attendee_pseudonym = i.attendee_pseudonym
              returning i.inviter_pseudonym as inviter, old.response as before`,
            [reservationId, user.pseudonymId, response, new Date(now).toISOString()],
          );
          const row = rows[0];
          if (!row) throw new DeskError('not-found', 404, '초대받은 회의를 찾지 못했어요');
          const withdrawn = openDelegations(all, user.idpSubject);
          const when = formatKstDateTime(meeting.start);
          if (withdrawn.length) {
            await q.query('delete from room_invites where reservation_id = $1 and attendee_pseudonym = any($2)', [
              reservationId,
              withdrawn.map((i) => i.attendeePseudonym),
            ]);
            const inviter = await ctx.adapters.directory.getProfile(withdrawn[0]!.inviterSubject).catch(() => null);
            for (const w of withdrawn)
              await ctx.notify.toUser(q, w.attendeePseudonym, {
                module: 'rooms',
                title: `${inviter?.displayName ?? '예약한 사람'}님 회의에 대신 가 달라는 부탁이 취소됐어요 · ${when}`,
                page: 'mine',
              });
          }
          if (row.before !== response || withdrawn.length)
            await ctx.notify.toUser(q, row.inviter, {
              module: 'rooms',
              title: `${user.displayName}님이 참석해요${withdrawn.length ? '. 대신 부탁은 거뒀어요' : ''} · ${when}`,
              page: 'mine',
            });
          const mine = all.find((i) => i.attendeePseudonym === user.pseudonymId);
          if (mine && (row.before !== response || withdrawn.length))
            followUp = { inviterSubject: mine.inviterSubject, withdrawn, calendar: all.some((i) => i.viaCalendar) };
          return { ok: true as const };
        },
      });
      // 트랜잭션이 끝난 뒤 바깥으로: 그룹웨어 일정 참석자를 맞추고, Slack으로 부탁을 받았던 사람에게 취소를 알려요.
      const f = followUp as { inviterSubject: string; withdrawn: InviteRow[]; calendar: boolean } | null;
      if (f) {
        if (f.calendar) await syncCalendar(meeting, reservationId, f.inviterSubject);
        const profile = lookup();
        const slackPeople = (await Promise.all(f.withdrawn.filter((i) => i.viaSlack).map((i) => profile(i.attendeeSubject)))).flatMap((p) => (p ? [p] : []));
        if (slackPeople.length) {
          const inviter = await profile(f.inviterSubject).catch(() => null);
          await outboundSlack(
            slackPeople,
            `${inviter?.displayName ?? '예약한 사람'}님 회의에 대신 가 달라는 부탁이 취소됐어요 · ${whenText(meeting.start, meeting.end)} · ${meeting.roomName}(${meeting.floor})`,
          );
        }
      }
      return result;
    },

    /** 대신 부탁할 수 있는 같은 팀 사람(11/4). 나·부른 사람·이미 초대받은 사람은 빼요. ref는 나에게 묶여요. */
    async colleagues(user: DeskUser, reservationId: string): Promise<InviteColleaguesResponse> {
      const meeting = await findMeeting(ctx.db, reservationId);
      const invites = meeting ? await invitesOf(ctx.db, reservationId) : [];
      if (!meeting || meeting.end <= ctx.now() || !invites.some((i) => i.attendeePseudonym === user.pseudonymId) || !user.department)
        throw new DeskError('not-found', 404, '초대받은 회의를 찾지 못했어요');
      const taken = new Set([user.idpSubject, ...invites.map((i) => i.attendeeSubject), ...invites.map((i) => i.inviterSubject)]);
      const members = await ctx.adapters.directory.departmentMembers(user.department, 100).catch(() => [] as EmployeeProfile[]);
      const now = ctx.now();
      return {
        items: members
          .filter((m) => !taken.has(m.idpSubject) && pseudonymize(ctx.config.pseudonymSecret, m.idpSubject) !== meeting.owner)
          .map((m) => ({ ref: personRef(ctx.config.pseudonymSecret, m.idpSubject, user.pseudonymId, now), name: m.displayName })),
      };
    },

    /**
     * [못 가요](11/4): 사유를 꼭 적어요(공통 입력 검사, 200자). 같은 팀 사람(delegate)을 고르면 그 사람에게 대신 가 달라고 부탁해요.
     * 부탁받은 사람에게는 부른 사람 이름으로 초대가 가고, 부탁한 사람·사유가 보여요. 사유는 부른 사람과 부탁받은 사람에게만 보여요.
     * 알림 글·감사 로그에는 사유를 넣지 않아요. 고정 버튼(화면이 확인을 먼저 띄워요)이에요.
     * 11/5: 부탁받은 사람도 같은 팀 다른 사람에게 다시 부탁할 수 있어요. 나에게 부탁한 사람에게는 되돌려 부탁하지 못하고,
     * 이미 못 간다고 한 초대는 다시 보낼 수 없고, 내가 부탁한 사람이 회의에 남아 있는 동안은 또 부탁하지 못해요.
     * 부탁받은 사람에게는 앱 알림이 가고, Slack이 연결돼 있으면 DM도 가요. 그룹웨어 일정이 있으면 못 간 사람은 빼고 부탁받은 사람을 넣어요.
     */
    async decline(user: DeskUser, reservationId: string, body: InviteDeclineBody): Promise<{ ok: true; delegated: boolean }> {
      if (!writeOn(ctx.ops.get())) throw new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
      if (!ctx.rateLimiter.hit(user.pseudonymId, 'invite')) throw new DeskError('rate-limited', 429, '요청이 많아요. 잠시 뒤에 다시 보내 주세요');
      const reason = checkedReason(body.reason);
      const meeting = await findMeeting(ctx.db, reservationId);
      if (!meeting || meeting.end <= ctx.now()) throw new DeskError('not-found', 404, '초대받은 회의를 찾지 못했어요');
      const now = ctx.now();
      let delegate: EmployeeProfile | null = null;
      if (body.delegate) {
        const subject = readPersonRef(ctx.config.pseudonymSecret, body.delegate, user.pseudonymId, now);
        const p = subject ? await ctx.adapters.directory.getProfile(subject).catch(() => null) : null;
        if (!p || !user.department || p.department !== user.department || p.idpSubject === user.idpSubject)
          throw new DeskError('bad-request', 400, '같은 팀 다른 사람에게만 부탁할 수 있어요');
        if (!(await ctx.adapters.idp.isActive(p.idpSubject))) throw new DeskError('bad-request', 400, '그 사람은 지금 부를 수 없어요');
        delegate = p;
      }
      // 같은 requestId가 다시 오면 run이 돌지 않아요. 그때는 바깥으로 다시 보내지 않아요.
      let followUp: { calendar: boolean; inviterSubject: string } | null = null;
      const result = await ctx.fixed.run<{ ok: true; delegated: boolean }>(user, {
        module: 'rooms',
        action: delegate ? 'invite.delegate' : 'invite.decline',
        idempotencyKey: body.requestId,
        enabled: writeOn,
        run: async (q, at) => {
          const all = await invitesOf(q, reservationId);
          const mine = all.find((i) => i.attendeePseudonym === user.pseudonymId);
          if (!mine) throw new DeskError('not-found', 404, '초대받은 회의를 찾지 못했어요');
          // 화면은 [못 가요]를 숨기지만, 서버도 한 번만 받아요(같은 초대로 여러 사람에게 부탁하지 못하게).
          if (mine.response === 'declined') throw new DeskError('already-declined', 409, '이미 못 간다고 보냈어요');
          if (delegate) {
            if (mine.delegatedBySubject === delegate.idpSubject)
              throw new DeskError('bad-request', 400, `나에게 부탁한 ${delegate.displayName}님에게는 다시 부탁할 수 없어요`);
            // 내가 부탁한 사람이 회의에 남아 있으면(참석한다고 했으면) 또 부탁하지 못해요. 다시 참석해 거둔 부탁은 남지 않아요.
            if (all.some((i) => i.delegatedBySubject === user.idpSubject))
              throw new DeskError('bad-request', 400, '이 회의에는 내가 대신 부탁한 사람이 이미 있어요');
          }
          await q.query(
            "update room_invites set response = 'declined', decline_reason = $3, responded_at = $4 where reservation_id = $1 and attendee_pseudonym = $2",
            [reservationId, user.pseudonymId, reason, new Date(at).toISOString()],
          );
          const when = formatKstDateTime(meeting.start);
          followUp = { calendar: all.some((i) => i.viaCalendar), inviterSubject: mine.inviterSubject };
          if (!delegate) {
            await ctx.notify.toUser(q, mine.inviterPseudonym, { module: 'rooms', title: `${user.displayName}님이 못 온대요 · ${when}`, page: 'mine' });
            return { ok: true as const, delegated: false };
          }
          const p = pseudonymize(ctx.config.pseudonymSecret, delegate.idpSubject);
          if (p === meeting.owner || all.some((i) => i.attendeeSubject === delegate!.idpSubject))
            throw new DeskError('bad-request', 400, '그 사람은 이미 이 회의에 있어요');
          if (all.length + 1 > INVITE_MAX) throw new DeskError('bad-request', 400, `한 회의에 ${INVITE_MAX}명까지 부를 수 있어요`);
          await q.query(
            `insert into room_invites (reservation_id, attendee_pseudonym, attendee_subject, inviter_pseudonym, inviter_subject, invited_at,
                                       delegated_by_pseudonym, delegated_by_subject, delegate_reason)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              reservationId,
              p,
              delegate.idpSubject,
              mine.inviterPseudonym,
              mine.inviterSubject,
              new Date(at).toISOString(),
              user.pseudonymId,
              user.idpSubject,
              reason,
            ],
          );
          const inviter = await ctx.adapters.directory.getProfile(mine.inviterSubject).catch(() => null);
          await ctx.notify.toUser(q, p, {
            module: 'rooms',
            title: `${inviter?.displayName ?? '예약한 사람'}님 회의에 ${user.displayName}님이 대신 가 달라고 했어요 · ${when}`,
            page: 'mine',
          });
          await ctx.notify.toUser(q, mine.inviterPseudonym, {
            module: 'rooms',
            title: `${user.displayName}님이 못 온대요. ${delegate.displayName}님에게 대신 부탁했어요 · ${when}`,
            page: 'mine',
          });
          return { ok: true as const, delegated: true };
        },
      });
      // 트랜잭션이 끝난 뒤 바깥으로(11/5). 그룹웨어 일정이 있으면 못 간 사람은 빼요(주최자는 부른 사람).
      // 대신 부탁이면 부탁받은 사람을 일정에 넣고, Slack이 연결돼 있으면 DM도 보내요(글에는 부른 사람 이름·시간·회의실·앱 주소만).
      const f = followUp as { calendar: boolean; inviterSubject: string } | null;
      if (f && !delegate && f.calendar) await syncCalendar(meeting, reservationId, f.inviterSubject);
      if (f && delegate && (f.calendar || slackOn()))
        await this.deliverPicked(user, reservationId, [delegate.idpSubject], { calendar: f.calendar, slack: slackOn(), delegated: true });
      return result;
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
