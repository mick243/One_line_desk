import {
  type JointPickRequest,
  type JointRequestsResponse,
  type OpsSettings,
  recordCutoff,
  TEAM_DELEGATE_MAX,
  type TeamDelegatesResponse,
} from '@one-line-desk/shared';
import type { EmployeeProfile } from '../../adapters/types';
import type { AppContext } from '../../context';
import type { Queryable } from '../../core/db';
import { DeskError } from '../../core/errors';
import { personRef, readPersonRef } from '../../core/person-ref';
import { pseudonymize } from '../../core/pseudonym';
import type { DeskUser } from '../../core/user';
import { roomLine, whenText } from './cards';
import type { InviteService } from './invites';
import { kstIso, MINUTE } from './search';

// 여러 팀 회의 참석자 고르기(11/4 사용자 결정, ADR-28).
// - 여러 팀 회의를 예약하면 팀마다 요청 한 줄을 만들고, 그 팀 팀장(IdP 역할 team-lead)과 팀장이 정한 회의 담당자에게 동시에 알려요.
//   부재인지 보지 않아요(다른 팀 근태를 읽지 않아요). 먼저 고른 사람의 선택이 초대가 되고, 나머지 사람에게는 닫혀요.
// - 고르는 사람은 자기 부서 사람만 골라요. 고른 사람에게는 부른 사람(예약한 사람) 이름으로 초대가 가요(ADR-17과 같은 칸).
// - 다 고르면(또는 시간이 지나면) 참석 인원을 다시 세서 회의실 정원보다 많거나 절반이 안 되면 예약한 사람에게 알려요. 회의실을 옮기지는 않아요.
// - 알림 글에는 부른 사람 이름·팀·시간·회의실만 넣어요. LLM은 부르지 않아요.

/** 고르는 사람에게 보여 주는 같은 부서 사람 수 상한 */
const MEMBERS_MAX = 100;

const writeOn = (s: OpsSettings) => s.modules.rooms === 'on' && s.roomsWrite;

interface RequestRow {
  id: string;
  reservationId: string;
  department: string;
  requesterPseudonym: string;
  requesterSubject: string;
  status: 'open' | 'picked' | 'expired';
  estimate: number;
  deadline: number;
  roomName: string;
  floor: string;
  capacity: number;
  start: number;
  end: number;
}

const REQUEST_COLUMNS = `j.id::text as id, j.reservation_id::text as "reservationId", j.department,
  j.requester_pseudonym as "requesterPseudonym", j.requester_subject as "requesterSubject", j.status, j.estimate,
  (extract(epoch from j.deadline_at) * 1000)::float8 as deadline, r.name as "roomName", r.floor, r.capacity,
  (extract(epoch from lower(x.slot)) * 1000)::float8 as start, (extract(epoch from upper(x.slot)) * 1000)::float8 as "end"`;
const REQUEST_FROM = 'room_joint_requests j join room_reservations x on x.id = j.reservation_id join rooms r on r.id = x.room_id';

export interface JointTeam {
  department: string;
  estimate: number;
}

export function createJointService(ctx: AppContext, invites: InviteService) {
  const pseudo = (subject: string) => pseudonymize(ctx.config.pseudonymSecret, subject);

  /** 그 부서의 재직자(디렉터리). 못 읽으면 빈 목록이에요. */
  async function membersOf(department: string): Promise<EmployeeProfile[]> {
    return ctx.adapters.directory.departmentMembers(department, MEMBERS_MAX).catch(() => [] as EmployeeProfile[]);
  }

  /** 그 부서에서 참석자를 고를 수 있는 사람: 팀장(역할) + 팀장이 정한 담당자(지금도 그 부서 재직자일 때만). 가명 ID 목록이에요. */
  async function pickersOf(q: Queryable, department: string): Promise<string[]> {
    const members = await membersOf(department);
    const inTeam = new Set(members.map((m) => pseudo(m.idpSubject)));
    const leads = members.filter((m) => m.groups.includes('team-lead')).map((m) => pseudo(m.idpSubject));
    const { rows } = await q.query<{ p: string }>('select delegate_pseudonym as p from room_team_delegates where department = $1 order by position', [
      department,
    ]);
    return [...new Set([...leads, ...rows.map((r) => r.p).filter((p) => inTeam.has(p))])];
  }

  async function isPicker(q: Queryable, user: DeskUser, department: string): Promise<boolean> {
    return user.department === department && (await pickersOf(q, department)).includes(user.pseudonymId);
  }

  /** 예약한 사람에게 다시 센 인원을 알려요. 그 예약의 요청이 모두 끝났을 때만이에요. */
  async function recount(q: Queryable, reservationId: string): Promise<void> {
    const { rows } = await q.query<RequestRow>(`select ${REQUEST_COLUMNS} from ${REQUEST_FROM} where j.reservation_id = $1`, [reservationId]);
    if (!rows.length || rows.some((r) => r.status === 'open')) return;
    const first = rows[0]!;
    const invited = await q.query<{ n: number }>(
      "select count(*)::int as n from room_invites where reservation_id = $1 and response <> 'declined' and attendee_pseudonym <> $2",
      [reservationId, first.requesterPseudonym],
    );
    const total = 1 + Number(invited.rows[0]!.n);
    const when = whenText(first.start, first.end);
    let title: string;
    if (total > first.capacity) title = `참석자가 ${total}명이라 정원(${first.capacity}명)보다 많아요. 회의실에서 더 큰 회의실을 찾아 주세요 · ${when}`;
    else if (total * 2 < first.capacity) title = `참석자가 ${total}명이에요. 작은 회의실로 옮기면 ${first.roomName}을 다른 팀이 쓸 수 있어요 · ${when}`;
    else title = `여러 팀 회의 참석자가 ${total}명으로 정해졌어요 · ${when}`;
    await ctx.notify.toUser(q, first.requesterPseudonym, { module: 'rooms', title, page: 'rooms' });
  }

  return {
    /**
     * 여러 팀 회의 예약(확정 트랜잭션 안). 팀마다 요청을 만들고 고를 사람에게 알려요.
     * 고를 사람이 없는 팀은 바로 끝내고(expired) 예약한 사람에게 직접 초대해 달라고 알려요.
     */
    async open(
      q: Queryable,
      user: DeskUser,
      reservationId: string,
      teams: JointTeam[],
      meeting: { start: number; end: number; roomName: string },
      now: number,
    ) {
      // 마감은 운영 값(jointPickLeadMinutes, 기본 60분) 만큼 회의 전이에요. 그보다 가까운 회의는 바로 마감이 아니라 지금부터 회의 시작까지 골라요.
      const lead = ctx.ops.get().values.jointPickLeadMinutes * MINUTE;
      const deadline = meeting.start - lead > now ? meeting.start - lead : meeting.start;
      const when = whenText(meeting.start, meeting.end);
      for (const team of teams) {
        const pickers = await pickersOf(q, team.department);
        const status = pickers.length ? 'open' : 'expired';
        await q.query(
          `insert into room_joint_requests (reservation_id, department, requester_pseudonym, requester_subject, status, estimate, created_at, deadline_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (reservation_id, department) do nothing`,
          [
            reservationId,
            team.department,
            user.pseudonymId,
            user.idpSubject,
            status,
            team.estimate,
            new Date(now).toISOString(),
            new Date(deadline).toISOString(),
          ],
        );
        if (!pickers.length) {
          await ctx.notify.toUser(q, user.pseudonymId, {
            module: 'rooms',
            title: `${team.department}에는 회의 담당자가 없어요. 참석자를 직접 초대해 주세요 · ${when}`,
            page: 'rooms',
          });
          continue;
        }
        for (const p of pickers)
          await ctx.notify.toUser(q, p, {
            module: 'rooms',
            title: `${user.displayName}님이 ${team.department} 회의 참석자를 골라 달라고 했어요 · ${when} · ${meeting.roomName}`,
            page: 'mine',
          });
      }
      await recount(q, reservationId);
    },

    /** 여러 팀 회의 예약이고 고르기가 모두 끝났으면 참석 인원(나 + 못 간다고 하지 않은 초대), 아니면 null이에요. */
    async closedCount(reservationId: string): Promise<number | null> {
      const { rows } = await ctx.db.query<{ open: number; n: number; requester: string }>(
        `select count(*) filter (where status = 'open')::int as open, count(*)::int as n, min(requester_pseudonym) as requester
           from room_joint_requests where reservation_id = $1`,
        [reservationId],
      );
      const r = rows[0];
      if (!r || Number(r.n) === 0 || Number(r.open) > 0) return null;
      const invited = await ctx.db.query<{ n: number }>(
        "select count(*)::int as n from room_invites where reservation_id = $1 and response <> 'declined' and attendee_pseudonym <> $2",
        [reservationId, r.requester],
      );
      return 1 + Number(invited.rows[0]!.n);
    },

    /** 내가 고를 요청(마이 페이지). 내 부서 요청 중 아직 열린 것, 내가 팀장·담당자일 때만이에요. */
    async mine(user: DeskUser): Promise<JointRequestsResponse> {
      if (!writeOn(ctx.ops.get()) || !user.department) return { items: [] };
      const now = ctx.now();
      if (!(await isPicker(ctx.db, user, user.department))) return { items: [] };
      const { rows } = await ctx.db.query<RequestRow>(
        `select ${REQUEST_COLUMNS} from ${REQUEST_FROM} where j.department = $1 and j.status = 'open' and j.deadline_at > $2 and upper(x.slot) > $2 order by lower(x.slot)`,
        [user.department, new Date(now).toISOString()],
      );
      if (!rows.length) return { items: [] };
      const members = await membersOf(user.department);
      const items: JointPickRequest[] = [];
      for (const r of rows) {
        const requester = await ctx.adapters.directory.getProfile(r.requesterSubject).catch(() => null);
        items.push({
          id: r.id,
          requester: requester ? `${requester.displayName}(${requester.department})` : '예약한 사람',
          department: r.department,
          when: whenText(r.start, r.end),
          room: roomLine({ name: r.roomName, floor: r.floor }),
          estimate: r.estimate,
          deadline: kstIso(r.deadline),
          members: members
            .filter((m) => m.idpSubject !== r.requesterSubject)
            .map((m) => ({ ref: personRef(ctx.config.pseudonymSecret, m.idpSubject, user.pseudonymId, now), name: m.displayName })),
        });
      }
      return { items };
    },

    /** 참석자 고르기(고정 버튼). 먼저 고른 사람만 돼요. 고른 사람에게 부른 사람 이름으로 초대가 가요. */
    async pick(
      user: DeskUser,
      id: string,
      people: string[],
      requestId: string,
      channels: { calendar: boolean; slack: boolean } = { calendar: false, slack: false },
    ): Promise<{ ok: true; invited: number }> {
      if (!writeOn(ctx.ops.get())) throw new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
      if (!/^\d{1,18}$/.test(id)) throw new DeskError('not-found', 404, '그 요청을 찾지 못했어요');
      const now = ctx.now();
      const subjects = [...new Set(people.map((ref) => readPersonRef(ctx.config.pseudonymSecret, ref, user.pseudonymId, now)))];
      if (subjects.some((s) => s === null)) throw new DeskError('bad-request', 400, '고른 사람을 확인하지 못했어요. 다시 골라 주세요');
      const team = new Map((await membersOf(user.department)).map((m) => [m.idpSubject, m]));
      const chosen = (subjects as string[]).map((s) => team.get(s));
      if (chosen.some((m) => !m)) throw new DeskError('bad-request', 400, '우리 팀 사람만 고를 수 있어요');

      // 이번에 새로 초대한 사람(같은 요청이 다시 오면 비어 있어서 바깥으로 다시 보내지 않아요).
      let fresh: { reservationId: string; subjects: string[] } | null = null;
      const result = await ctx.fixed.run<{ ok: true; invited: number }>(user, {
        module: 'rooms',
        action: 'joint.pick',
        idempotencyKey: requestId,
        enabled: writeOn,
        resultCode: (r) => `invited:${r.invited}`,
        run: async (q, at) => {
          const { rows } = await q.query<RequestRow>(`select ${REQUEST_COLUMNS} from ${REQUEST_FROM} where j.id = $1 for update of j`, [id]);
          const r = rows[0];
          if (!r || r.department !== user.department || !(await isPicker(q, user, r.department)))
            throw new DeskError('not-found', 404, '그 요청을 찾지 못했어요');
          if (r.status !== 'open') throw new DeskError('already', 409, '이미 다른 담당자가 골랐거나 시간이 지났어요');
          if (r.end <= at) throw new DeskError('ended', 409, '이미 끝난 회의예요');
          if (r.deadline <= at) throw new DeskError('already', 409, '고르는 시간이 지났어요. 처음 짐작한 인원 그대로예요');
          const when = whenText(r.start, r.end);
          const requester = await ctx.adapters.directory.getProfile(r.requesterSubject).catch(() => null);
          const by = requester?.displayName ?? '예약한 사람';
          let invited = 0;
          const subjectsAdded: string[] = [];
          for (const m of chosen as EmployeeProfile[]) {
            if (m.idpSubject === r.requesterSubject) continue;
            const p = pseudo(m.idpSubject);
            const added = await q.query(
              `insert into room_invites (reservation_id, attendee_pseudonym, attendee_subject, inviter_pseudonym, inviter_subject, invited_at)
               values ($1, $2, $3, $4, $5, $6) on conflict do nothing returning attendee_pseudonym`,
              [r.reservationId, p, m.idpSubject, r.requesterPseudonym, r.requesterSubject, new Date(at).toISOString()],
            );
            if (!added.rows.length) continue;
            invited += 1;
            subjectsAdded.push(m.idpSubject);
            await ctx.notify.toUser(q, p, { module: 'rooms', title: `${by}님이 회의에 불렀어요 · ${when}`, page: 'rooms' });
          }
          await q.query("update room_joint_requests set status = 'picked', picked_by_pseudonym = $2, picked_count = $3, picked_at = $4 where id = $1", [
            id,
            user.pseudonymId,
            chosen.length,
            new Date(at).toISOString(),
          ]);
          await ctx.notify.toUser(q, r.requesterPseudonym, {
            module: 'rooms',
            title: `${r.department} 참석자 ${chosen.length}명이 정해졌어요 · ${when}`,
            page: 'rooms',
          });
          await recount(q, r.reservationId);
          fresh = { reservationId: r.reservationId, subjects: subjectsAdded };
          return { ok: true as const, invited };
        },
      });
      // 그룹웨어 캘린더·Slack(고르는 사람이 고른 길)은 트랜잭션이 끝난 뒤 보내요. 주최자는 예약한 사람이에요.
      const done = fresh as { reservationId: string; subjects: string[] } | null;
      if (done && done.subjects.length && (channels.calendar || channels.slack)) await invites.deliverPicked(user, done.reservationId, done.subjects, channels);
      return result;
    },

    /** 마이 페이지 "팀 회의 담당자"(팀장만). */
    async delegates(user: DeskUser): Promise<TeamDelegatesResponse> {
      const isLead = user.roles.includes('team-lead') && Boolean(user.department);
      if (!isLead) return { isLead: false, department: user.department, delegates: [] };
      const { rows } = await ctx.db.query<{ position: number; subject: string }>(
        'select position, delegate_subject as subject from room_team_delegates where department = $1 order by position',
        [user.department],
      );
      const delegates: TeamDelegatesResponse['delegates'] = [];
      for (const r of rows) {
        const p = await ctx.adapters.directory.getProfile(r.subject).catch(() => null);
        if (p && p.department === user.department) delegates.push({ position: r.position, name: p.displayName });
      }
      return { isLead, department: user.department, delegates };
    },

    /** 담당자 정하기(팀장만, 고정 버튼). 같은 부서 재직자만, 순서대로 최대 2명. 비우면 지워요. */
    async setDelegates(user: DeskUser, people: string[], requestId: string): Promise<TeamDelegatesResponse> {
      if (!user.roles.includes('team-lead') || !user.department) throw new DeskError('forbidden', 403, '팀장만 정할 수 있어요');
      if (people.length > TEAM_DELEGATE_MAX) throw new DeskError('bad-request', 400, `담당자는 ${TEAM_DELEGATE_MAX}명까지 정할 수 있어요`);
      const now = ctx.now();
      const subjects = people.map((ref) => readPersonRef(ctx.config.pseudonymSecret, ref, user.pseudonymId, now));
      if (subjects.some((s) => s === null) || new Set(subjects).size !== subjects.length)
        throw new DeskError('bad-request', 400, '고른 사람을 확인하지 못했어요. 다시 골라 주세요');
      const team = new Set((await membersOf(user.department)).map((m) => m.idpSubject));
      if ((subjects as string[]).some((s) => s === user.idpSubject || !team.has(s)))
        throw new DeskError('bad-request', 400, '우리 팀 다른 사람만 정할 수 있어요');
      await ctx.fixed.run(user, {
        module: 'rooms',
        action: 'joint.delegates',
        idempotencyKey: requestId,
        enabled: () => true,
        resultCode: () => `count:${subjects.length}`,
        run: async (q, at) => {
          await q.query('delete from room_team_delegates where department = $1', [user.department]);
          for (const [i, s] of (subjects as string[]).entries())
            await q.query(
              'insert into room_team_delegates (department, position, delegate_pseudonym, delegate_subject, set_by_pseudonym, set_at) values ($1, $2, $3, $4, $5, $6)',
              [user.department, i + 1, pseudo(s), s, user.pseudonymId, new Date(at).toISOString()],
            );
          return { ok: true };
        },
      });
      return this.delegates(user);
    },

    /** 보관 회차(한 시간마다): 시간이 지난 요청은 짐작한 인원 그대로 두고 알려요. 만든 지 7일 지난 요청은 지워요. */
    async sweep(now: number): Promise<void> {
      await ctx.db.tx(async (q) => {
        const { rows } = await q.query<RequestRow>(
          `select ${REQUEST_COLUMNS} from ${REQUEST_FROM} where j.status = 'open' and j.deadline_at <= $1 for update of j`,
          [new Date(now).toISOString()],
        );
        for (const r of rows) {
          await q.query("update room_joint_requests set status = 'expired' where id = $1", [r.id]);
          await ctx.notify.toUser(q, r.requesterPseudonym, {
            module: 'rooms',
            title: `${r.department}에서 참석자를 고르지 않아 처음 짐작한 인원(${r.estimate}명) 그대로예요 · ${whenText(r.start, r.end)}`,
            page: 'rooms',
          });
        }
        for (const reservationId of new Set(rows.map((r) => r.reservationId))) await recount(q, reservationId);
        await q.query('delete from room_joint_requests where created_at < $1', [new Date(recordCutoff(now)).toISOString()]);
      });
    },
  };
}

export type JointService = ReturnType<typeof createJointService>;
