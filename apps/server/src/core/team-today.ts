import { addDays, KST_OFFSET, kstDate, TEAM_TODAY_SMALL, type TeamTodayPeopleResponse, type TeamTodayResponse } from '@one-line-desk/shared';
import type { EmployeeProfile } from '../adapters/types';
import type { AppContext } from '../context';
import type { AccessEntry } from './access-record';
import { DeskError } from './errors';
import { gatherTeamSchedule, LEAVE_CONCURRENCY, mapLimited, TEAM_MAX } from './home-team';
import { pseudonymize } from './pseudonym';
import type { TeamAway } from './services';
import type { DeskUser } from './user';

/** 부서마다 오늘 빠지는 사람을 기억하는 시간. 홈을 열 때마다 근태 시스템을 사람 수만큼 부르지 않게 해요(11/25 개발 의견). */
const CACHE_MS = 5 * 60_000;

interface DeptToday {
  day: string;
  until: number;
  /** 부서 재직자 가명 ID(나 포함) */
  members: string[];
  leave: Set<string>;
  away: Set<string>;
  leaveConnected: boolean;
}

const dayStart = (date: string) => Date.parse(`${date}T00:00:00${KST_OFFSET}`);
type From = Pick<AccessEntry, 'ip' | 'requestId'>;

/**
 * 오늘 우리 팀 한 줄(11/25 회의 결정, ADR-18 보강).
 * - 수(summary): 같은 부서에서 오늘 휴가·자리비움이 있는 사람 수만 돌려줘요(나 빼고). 부서마다 5분 메모리 캐시이고 저장하지 않아요.
 *   수를 보여 준 날마다 사람당 한 번, 빠진 사람의 가명 ID로 접속기록 team.headcount를 남겨요(홈을 열 때마다 쌓이지 않게).
 * - 펼치기(people): 이름과 하루/오전/오후·자리비움 시간을 보여 줘요. 같은 팀 일정과 같은 길(gatherTeamSchedule)이라 team.schedule 접속기록이 남아요.
 *   회의는 읽지 않아요. 나 포함 TEAM_TODAY_SMALL명 이하인 팀은 수도 이름도 보여 주지 않아요(수만으로도 누구인지 드러나요).
 * 같은 팀 일정 스위치(teamSchedule, 출시 기본 끔)가 꺼져 있으면 아무것도 읽지 않아요. AI에는 보내지 않아요.
 */
export function createTeamToday(ctx: AppContext) {
  const cache = new Map<string, DeptToday>();
  const countedDay = new Map<string, string>();

  async function load(department: string): Promise<DeptToday | null> {
    const now = ctx.now();
    const day = kstDate(now);
    const hit = cache.get(department);
    if (hit && hit.day === day && hit.until > now) return hit;
    let people: EmployeeProfile[];
    try {
      people = await ctx.adapters.directory.departmentMembers(department, TEAM_MAX + 1);
    } catch {
      return null;
    }
    const ids = people.map((p) => pseudonymize(ctx.config.pseudonymSecret, p.idpSubject));
    const away = ctx.ops.get().modules.navi === 'on' ? ctx.services.navi?.away : undefined;
    const [records, aways] = await Promise.all([
      mapLimited(people, LEAVE_CONCURRENCY, (p) =>
        ctx.adapters.leave.leaveOf({ idpSubject: p.idpSubject, ...(p.email ? { email: p.email } : {}) }).catch(() => null),
      ),
      away ? away.ofPeople(ids, dayStart(day), dayStart(addDays(day, 1))).catch(() => [] as TeamAway[]) : Promise.resolve([] as TeamAway[]),
    ]);
    const out: DeptToday = {
      day,
      until: now + CACHE_MS,
      members: ids,
      leave: new Set(ids.filter((_, i) => (records[i]?.uses ?? []).some((u) => u.date === day))),
      away: new Set(aways.map((a) => a.pseudonymId)),
      leaveConnected: people.length === 0 || records.some((r) => r !== null),
    };
    cache.set(department, out);
    return out;
  }

  const off = (user: DeskUser): TeamTodayResponse => ({ enabled: false, team: user.department, leave: 0, away: 0, small: false, leaveConnected: true });

  return {
    async summary(user: DeskUser, from: From): Promise<TeamTodayResponse> {
      if (!ctx.ops.get().teamSchedule || !user.department) return off(user);
      const d = await load(user.department);
      if (!d) return off(user);
      // 작은 팀(나 포함 TEAM_TODAY_SMALL명 이하)은 수만으로도 누구인지 드러나서(2명 팀의 "자리비움 1명") 한 줄 자체를 보여 주지 않아요.
      if (d.members.length <= TEAM_TODAY_SMALL) return { ...off(user), small: true };
      const others = (set: Set<string>) => [...set].filter((id) => id !== user.pseudonymId);
      const leave = others(d.leave);
      const away = others(d.away);
      if (countedDay.get(user.pseudonymId) !== d.day) {
        countedDay.set(user.pseudonymId, d.day);
        const refs = [...new Set([...leave, ...away])].map((id) => `person:${id}`);
        await ctx.access.record({ pseudonymId: user.pseudonymId, action: 'team.headcount', subjectRefs: refs, ...from });
      }
      return {
        enabled: true,
        team: user.department,
        leave: leave.length,
        away: away.length,
        small: false,
        leaveConnected: d.leaveConnected,
      };
    },

    async people(user: DeskUser, from: From): Promise<TeamTodayPeopleResponse> {
      if (!ctx.ops.get().teamSchedule || !user.department) throw new DeskError('feature-off', 409, '이 회사에서는 팀 현황을 보여 주지 않아요');
      const d = await load(user.department);
      if (d && d.members.length <= TEAM_TODAY_SMALL) throw new DeskError('small-team', 409, '팀이 작아 이름은 보여 주지 않아요');
      const today = kstDate(ctx.now());
      const got = await gatherTeamSchedule(ctx, user, '', { from: today, to: today }, from, ['leave', 'away']);
      if (got.status !== 'shown') throw new DeskError('unavailable', 503, '지금은 팀 현황을 불러오지 못했어요');
      return {
        entries: got.entries.filter((e): e is TeamTodayPeopleResponse['entries'][number] => e.what === 'leave' || e.what === 'away'),
        leaveConnected: got.leaveConnected,
      };
    },
  };
}
