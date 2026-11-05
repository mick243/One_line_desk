import {
  type AbsencePart,
  addDays,
  AWAY_KIND_LABEL,
  AWAY_MAX_DAYS,
  type AwayDraft,
  type AwayKind,
  HOME_PERIOD_LABEL,
  type HomePeriod,
  KST_OFFSET,
  kstDate,
  personNameWords,
  type TeamEntry,
} from '@one-line-desk/shared';
import type { EmployeeProfile, LeaveRecord } from '../adapters/types';
import type { AppContext } from '../context';
import type { AccessEntry } from './access-record';
import { pseudonymize } from './pseudonym';
import type { TeamAway, TeamMeeting } from './services';
import { parseSlots } from './slots';
import type { DeskUser } from './user';

// 홈 채팅 "같은 팀 일정"(11/3 사용자 결정). CLAUDE.md "연차는 본인 화면에만"·"사람 이름은 내보내지 않아요"·ADR-06(남의 예약자 비노출)의 좁은 같은 팀 예외예요.
// - 묻는 사람과 같은 부서 재직자만 봐요. 다른 팀(부서 이름)·다른 팀 사람(이름)을 물으면 아무것도 읽지 않고 거절해요.
// - 휴가: 근태 기록(어댑터)에 들어간(승인된) 날만, 하루/오전/오후만. 종류(연차·병가·공가)·사유·남은 연차는 만들지 않아요.
//   결재 중인 휴가 요청(문의하기 표)은 읽지 않아요.
// - 회의: rooms 서비스(ctx.services.rooms.team)로 그 사람이 예약했거나 "참석할게요"로 답한 회의의 시간·회의실 이름만. 참석자·부른 사람 없음.
// - 자리비움: navi 서비스(ctx.services.navi.away)로 그 사람이 스스로 알린 종류·시간만.
// - 요청마다 계산하고 저장하지 않아요. 결과는 AI로 보내지 않아요(AI는 질문 뜻만 봐요).
// - 보여 준 사람은 법정 접속기록(team.schedule)에 가명 ID로만 남겨요(ADR-20). 이름·날·시간·종류는 남기지 않아요.

/** 팀을 가리키는 말. 팀장·부서장은 사람 한 명이라 빼요. */
const TEAM_WORDS = /팀(?!장)|부서(?!장)|동료|팀원/;
/** 부재를 묻는 말 */
const ABSENT_WORDS =
  /휴가|연차|반차|월차|병가|공가|부재|결근|쉬(?!운)|쉰다|쉴|안\s?나[오와왔온]|안\s?(와|왔|오는|온)|빠[지졌진]|자리\s?비|(누가|누구|사람)\s?(없|안)|없는\s?사람|출근\s?안/;
/** 일정을 묻는 말 */
const SCHEDULE_WORDS = /일정|스케줄|캘린더|회의|미팅|자리|외근|출장|재택|어디|바빠|바쁘|뭐\s?해/;
/** 남(한 사람)을 가리키는 말 */
const OTHER_PERSON =
  /팀장|부장|과장|차장|대리|실장|본부장|이사님|대표님|사장님|선배|후배|부서장|매니저|리더|[가-힣]{2,4}\s?(님|씨)(?![가-힣])|그\s?사람|그분|걔|쟤|다른\s?사람/;
/** 남의 일정·자리를 묻는 말 */
const OTHER_ABOUT =
  /일정|스케줄|캘린더|회의|미팅|휴가|연차|반차|병가|부재|출근|퇴근|어디|뭐\s?해|바빠|바쁘|자리|외근|출장|재택|있어|있나|있니|계셔|계세요|왔어|나왔/;
const SELF = /(^|\s)(내|제|나의|저의|나|저)\s/;
/** 내 자리비움을 알리는 말("나 오후에 외근이야"). 홈은 정하지 않고, 답 아래에 미리 채운 양식을 펼쳐요(11/5). */
const AWAY_WORDS = /외근|출장|재택|자리\s?비/;
const SELF_STATEMENT = /(이야|이에요|예요|이라|라서|할게|갈게|가요|해요|합니다|입니다|예정|나가|나갈|알릴|알려)/;

/** 내 자리비움을 알리는 문장인지(규칙) */
export const tellsOwnAway = (text: string) => AWAY_WORDS.test(text) && SELF_STATEMENT.test(text) && !TEAM_WORDS.test(text) && !OTHER_PERSON.test(text);

const AWAY_KIND_WORDS: [AwayKind, RegExp][] = [
  ['trip', /출장/],
  ['remote', /재택/],
  ['outside', /외근/],
  ['away', /자리\s?비/],
];
const pad = (n: number) => String(n).padStart(2, '0');
const plusMinutes = (hhmm: string, m: number) => {
  const t = Math.min(Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + m, 23 * 60 + 45);
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
};

/**
 * 자리비움 알리기 미리 채움(11/5). "내일 오후 외근이에요" → 외근 · 내일 · 13:00~18:00.
 * 종류·날·시각만 규칙으로 뽑아요(글은 남기지 않고 응답에만 실어요). 말하지 않은 칸은 비워서 양식 기본값을 써요.
 * 날이 오늘부터 AWAY_MAX_DAYS 밖이면 날을 비워요(양식이 고를 수 있는 날만 채워요).
 */
export function awayDraft(text: string, now: number): AwayDraft {
  const draft: AwayDraft = {};
  const kind = AWAY_KIND_WORDS.find(([, re]) => re.test(text));
  if (kind) draft.kind = kind[0];
  const today = kstDate(now);
  const slots = parseSlots(text, now);
  if (slots.date && slots.date >= today && slots.date <= addDays(today, AWAY_MAX_DAYS - 1)) draft.date = slots.date;
  if (slots.start) {
    draft.start = slots.start;
    draft.end = slots.minutes ? plusMinutes(slots.start, slots.minutes) : slots.start < '18:00' ? '18:00' : plusMinutes(slots.start, 60);
  } else if (/종일|하루|온종일/.test(text)) {
    draft.start = '09:00';
    draft.end = '18:00';
  } else if (/오전/.test(text)) {
    draft.start = '09:00';
    draft.end = '12:00';
  } else if (/오후/.test(text)) {
    draft.start = '13:00';
    draft.end = '18:00';
  }
  return draft;
}

/**
 * 같은 팀 일정을 묻는지(규칙). 팀 + 부재·일정 말, 또는 남(호칭·이름) + 일정·자리 말이에요. 쓰기 동사·공지는 부르는 쪽이 먼저 걸러요.
 * names는 디렉터리 이름 낱말이에요(서버 안에서 대조만, 호칭 없이 "서준 오늘 자리에 있어?"도 받아요).
 */
export function asksTeamSchedule(text: string, names: string[] = []): boolean {
  if (TEAM_WORDS.test(text) && (ABSENT_WORDS.test(text) || SCHEDULE_WORDS.test(text))) return true;
  const someone = OTHER_PERSON.test(text) || names.some((n) => text.includes(n));
  return someone && OTHER_ABOUT.test(text) && !SELF.test(text);
}

const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * 질문에 내 부서가 아닌 부서 이름이 있는지. 서버 안에서 디렉터리 부서 이름과 대조만 해요(띄어 쓴 "개발 팀"도 같아요).
 * 긴 이름부터 지워서 "앱개발팀" 안의 "개발팀"을 따로 세지 않아요. 명단에 없는 이름은 다른 팀으로 보지 않아요(보여 주는 건 늘 내 부서뿐이에요).
 */
export function mentionsOtherTeam(text: string, own: string, departments: string[]): boolean {
  let rest = squash(text);
  const mine = squash(own);
  const names = [...new Set(departments.map(squash).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (!rest.includes(name)) continue;
    if (name !== mine) return true;
    rest = rest.split(name).join(' ');
  }
  return false;
}

const startOf = (date: string) => Date.parse(`${date}T00:00:00${KST_OFFSET}`);

/** 팀 일정으로 볼 날(한국 날짜). 때를 말하지 않으면 오늘이에요. 이번 주는 오늘부터 일요일까지예요. 하루는 0시부터 봐요. */
export function scheduleDates(period: HomePeriod, now: number, window: { from: number; to: number }): { from: string; to: string; period: HomePeriod } {
  if (period === 'recent') {
    const today = kstDate(now);
    return { from: today, to: today, period: 'today' };
  }
  return { from: kstDate(window.from), to: kstDate(window.to - 1), period };
}

/** 근태 조회를 한꺼번에 부르는 수 상한(사람이 많아도 근태 시스템을 몰아 부르지 않게) */
const LEAVE_CONCURRENCY = 6;
/** 한 번에 보는 같은 부서 사람 수 상한(접속기록 정보주체 표시 상한 100과 같아요) */
const TEAM_MAX = 100;

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 그 사람 하루의 휴가 칸. 하루가 있거나 오전·오후가 다 있으면 하루예요. */
function partOf(uses: LeaveRecord['uses']): AbsencePart {
  if (uses.some((u) => u.kind === 'full')) return 'full';
  const halves = new Set(uses.map((u) => u.half ?? 'half'));
  if (halves.has('am') && halves.has('pm')) return 'full';
  if (halves.has('am')) return 'am';
  if (halves.has('pm')) return 'pm';
  return 'half';
}

/** 한국 시간 "HH:MM". 그날 끝(다음 날 0시)은 "24:00"이에요. */
function hhmm(at: number, dayEnd: number): string {
  if (at >= dayEnd) return '24:00';
  return new Date(at + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 14; d = addDays(d, 1)) out.push(d);
  return out;
}

type TeamGather =
  { status: 'shown'; entries: TeamEntry[]; person: string | null; leaveConnected: boolean } | { status: 'other-person' } | { status: 'unavailable' };

/**
 * 같은 부서 재직자의 휴가·회의·자리비움에서 그 기간 것만 모아요. 본인은 빼요(본인 일은 "내 일정"으로 물어요).
 * 질문에 같은 팀 사람 이름이 있으면 그 사람만, 다른 팀 사람 이름이 있으면 아무것도 읽지 않고 거절해요.
 * 읽었으면 보여 준 사람의 가명 ID로 접속기록 한 줄을 남겨요(0명이어도 조회 한 줄).
 */
export async function gatherTeamSchedule(
  ctx: AppContext,
  user: DeskUser,
  text: string,
  dates: { from: string; to: string },
  from: Pick<AccessEntry, 'ip' | 'requestId'>,
): Promise<TeamGather> {
  let members: EmployeeProfile[];
  let allNames: string[];
  try {
    members = (await ctx.adapters.directory.departmentMembers(user.department, TEAM_MAX + 1))
      .filter((p) => p.idpSubject !== user.idpSubject)
      .slice(0, TEAM_MAX);
    allNames = await ctx.adapters.directory.personNameWords();
  } catch {
    return { status: 'unavailable' };
  }

  // 이름 대조는 서버 메모리에서만 해요. 같은 팀 사람 이름이면 그 사람만, 아니면 다른 팀 사람이라 거절해요.
  const flat = squash(text);
  const ownWords = new Set([...members.flatMap((m) => personNameWords(m.displayName)), ...personNameWords(user.displayName)]);
  const focus = members.filter((m) => personNameWords(m.displayName).some((w) => flat.includes(w)));
  if (!focus.length && allNames.some((w) => !ownWords.has(w) && flat.includes(w))) return { status: 'other-person' };
  const people = focus.length ? focus : members;

  const settings = ctx.ops.get();
  const fromMs = startOf(dates.from);
  const toMs = startOf(addDays(dates.to, 1));
  const ids = people.map((p) => pseudonymize(ctx.config.pseudonymSecret, p.idpSubject));
  const rooms = settings.modules.rooms === 'on' ? ctx.services.rooms?.team : undefined;
  const away = settings.modules.navi === 'on' ? ctx.services.navi?.away : undefined;
  const [records, meetings, aways] = await Promise.all([
    mapLimited(people, LEAVE_CONCURRENCY, (p) =>
      ctx.adapters.leave.leaveOf({ idpSubject: p.idpSubject, ...(p.email ? { email: p.email } : {}) }).catch(() => null),
    ),
    rooms ? rooms.meetingsOf(ids, fromMs, toMs).catch(() => [] as TeamMeeting[]) : Promise.resolve([] as TeamMeeting[]),
    away ? away.ofPeople(ids, fromMs, toMs).catch(() => [] as TeamAway[]) : Promise.resolve([] as TeamAway[]),
  ]);

  const entries: (TeamEntry & { order: number })[] = [];
  const shown = new Set<number>();
  const days = datesBetween(dates.from, dates.to);
  people.forEach((p, i) => {
    const name = p.displayName;
    const byDate = new Map<string, LeaveRecord['uses']>();
    for (const u of records[i]?.uses ?? []) {
      if (u.date < dates.from || u.date > dates.to) continue;
      byDate.set(u.date, [...(byDate.get(u.date) ?? []), u]);
    }
    // 칸을 하나씩 골라 담아요. 근태 기록의 종류·그 밖의 칸(사유 등)은 옮기지 않아요.
    for (const [date, uses] of byDate) {
      entries.push({ name, date, what: 'leave', part: partOf(uses), order: startOf(date) });
      shown.add(i);
    }
    for (const m of meetings.filter((x) => x.pseudonymId === ids[i])) {
      const date = kstDate(m.start);
      if (date < dates.from || date > dates.to) continue;
      const dayEnd = startOf(addDays(date, 1));
      entries.push({ name, date, what: 'meeting', start: hhmm(m.start, dayEnd), end: hhmm(m.end, dayEnd), room: m.roomName, order: m.start });
      shown.add(i);
    }
    for (const a of aways.filter((x) => x.pseudonymId === ids[i])) {
      for (const date of days) {
        const dayStart = startOf(date);
        const dayEnd = startOf(addDays(date, 1));
        const s = Math.max(a.start, dayStart);
        const e = Math.min(a.end, dayEnd);
        if (e <= s) continue;
        entries.push({
          name,
          date,
          what: 'away',
          start: hhmm(s, dayEnd),
          end: hhmm(e, dayEnd),
          allDay: s === dayStart && e === dayEnd,
          away: a.kind,
          order: s,
        });
        shown.add(i);
      }
    }
  });
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'ko') || a.order - b.order);

  const subjectRefs = [...shown].map((i) => `person:${ids[i]}`);
  await ctx.access.record({ pseudonymId: user.pseudonymId, action: 'team.schedule', subjectRefs, ...from });
  return {
    status: 'shown',
    entries: entries.map(({ order: _order, ...e }) => e as TeamEntry),
    person: focus.length === 1 ? focus[0]!.displayName : null,
    leaveConnected: people.length === 0 || records.some((r) => r !== null),
  };
}

/** 오전 반차는 13시 전, 오후 반차는 13시부터로 봐요(회의 시간과 겹치는지만 봐요). */
const NOON = '13:00';

export interface TeamPresence {
  /** 같은 부서 재직자(나 포함) */
  total: number;
  /** 그 시간에 올 사람(나 포함, 1명 이상) */
  present: number;
  /** 휴가로 빠진 수 */
  leave: number;
  /** 외근·출장·재택·자리비움으로 빠진 수 */
  away: number;
}

/**
 * 회의실 인원을 말하지 않았을 때(11/4 사용자 결정): 같은 부서 재직자에서 그 회의 시간에 휴가(승인된 근태 기록)·자리비움인 사람을 빼고 세요.
 * 수만 돌려주고 이름·종류·사유는 돌려주지 않아요. AI에는 보내지 않아요(ADR-18). 같은 팀 일정 스위치(teamSchedule)가 꺼져 있으면
 * 근태·자리비움을 읽지 않고 부서 인원만 세요. 회의 시간을 모를 때도 부서 인원만 세요. 읽었으면 빠진 사람의 가명 ID로 접속기록(team.headcount) 한 줄을 남겨요(0명이어도).
 * 반나절(오전·오후를 모르는 반차)은 올 수도 있어서 빼지 않아요(회의실이 모자라는 쪽보다 넉넉한 쪽이 나아요).
 */
export async function teamPresence(
  ctx: AppContext,
  user: DeskUser,
  meeting: { date: string; start: number; end: number } | null,
  from: Pick<AccessEntry, 'ip' | 'requestId'> = {},
): Promise<TeamPresence | null> {
  if (!user.department) return null;
  const all = await ctx.adapters.directory.departmentMembers(user.department, TEAM_MAX + 1).catch(() => [] as EmployeeProfile[]);
  if (!all.length) return null;
  const total = Math.max(1, all.length);
  const settings = ctx.ops.get();
  // 스위치가 꺼졌거나 회의 시간을 모르면(날짜·시각이 빠짐) 근태·자리비움을 읽지 않아요.
  if (!settings.teamSchedule || !meeting) return { total, present: total, leave: 0, away: 0 };

  const others = all.filter((p) => p.idpSubject !== user.idpSubject).slice(0, TEAM_MAX);
  const ids = others.map((p) => pseudonymize(ctx.config.pseudonymSecret, p.idpSubject));
  const away = settings.modules.navi === 'on' ? ctx.services.navi?.away : undefined;
  const [records, aways] = await Promise.all([
    mapLimited(others, LEAVE_CONCURRENCY, (p) =>
      ctx.adapters.leave.leaveOf({ idpSubject: p.idpSubject, ...(p.email ? { email: p.email } : {}) }).catch(() => null),
    ),
    away ? away.ofPeople(ids, meeting.start, meeting.end).catch(() => [] as TeamAway[]) : Promise.resolve([] as TeamAway[]),
  ]);
  const noon = Date.parse(`${meeting.date}T${NOON}:00${KST_OFFSET}`);
  const morning = meeting.start < noon;
  const afternoon = meeting.end > noon;
  const out = new Set<number>();
  let leave = 0;
  let awayCount = 0;
  others.forEach((_p, i) => {
    const uses = (records[i]?.uses ?? []).filter((u) => u.date === meeting.date);
    const part = uses.length ? partOf(uses) : null;
    const onLeave = part === 'full' || (part === 'am' && morning && !afternoon) || (part === 'pm' && afternoon && !morning);
    if (onLeave) {
      leave += 1;
      out.add(i);
      return;
    }
    if (aways.some((a) => a.pseudonymId === ids[i] && a.start < meeting.end && meeting.start < a.end)) {
      awayCount += 1;
      out.add(i);
    }
  });
  await ctx.access.record({ pseudonymId: user.pseudonymId, action: 'team.headcount', subjectRefs: [...out].map((i) => `person:${ids[i]}`), ...from });
  return { total, present: Math.max(1, total - leave - awayCount), leave, away: awayCount };
}

/** 질문에 나온 내 부서가 아닌 부서 이름들(명단에 있는 이름만, 긴 이름 먼저). 여러 팀 회의에서 어느 팀에 고르기를 보낼지 정해요(ADR-28). */
export function otherTeamsIn(text: string, own: string, departments: string[]): string[] {
  let rest = squash(text);
  const mine = squash(own);
  const out: string[] = [];
  for (const name of [...new Set(departments.filter(Boolean))].sort((a, b) => squash(b).length - squash(a).length)) {
    const key = squash(name);
    if (!key || !rest.includes(key)) continue;
    rest = rest.split(key).join(' ');
    if (key !== mine) out.push(name);
  }
  return out;
}

/** 여러 팀이 함께하는 회의를 가리키는 말(11/4). 이때는 팀 인원으로 짐작하지 않고 인원을 물어요. */
const JOINT_WORDS = /합동|연합|여러\s?팀|타\s?팀|다른\s?팀|팀\s?(끼리|간|들)|부서\s?간|유관\s?부서|전사|전체\s?회의|타\s?부서|다른\s?부서|협업\s?회의/;

/** 여러 팀이 함께하는 회의인지: 말("합동·다른 팀·부서 간")이나 내 부서가 아닌 부서 이름이 있으면요. 부서 이름 대조는 서버 안에서만 해요. */
export function isJointMeeting(text: string, own: string, departments: string[]): boolean {
  return JOINT_WORDS.test(text) || mentionsOtherTeam(text, own, departments);
}

const PART_TEXT: Record<AbsencePart, string> = { full: '하루 부재', am: '오전 부재', pm: '오후 부재', half: '반나절 부재' };

/** 한 칸 글: "10:00–11:00 회의(회의실 4A)" · "14:00–18:00 외근" · "오후 부재" */
export function entryText(e: TeamEntry): string {
  if (e.what === 'leave') return PART_TEXT[e.part];
  if (e.what === 'meeting') return `${e.start}–${e.end} 회의(${e.room})`;
  return e.allDay ? `종일 ${AWAY_KIND_LABEL[e.away]}` : `${e.start}–${e.end} ${AWAY_KIND_LABEL[e.away]}`;
}

/**
 * "오늘 개발팀 일정: 가상 직원 서준 10:00–11:00 회의(회의실 4A) · 14:00–18:00 외근 / 가상 직원 하은 오후 부재"
 * 비면 "오늘 개발팀에 등록된 일정이 없어요". 여러 날이면 "이번 주 개발팀 일정 N건이에요"와 목록이에요.
 */
export function scheduleHeadline(period: HomePeriod, team: string, person: string | null, entries: TeamEntry[], oneDay: boolean): string {
  const label = HOME_PERIOD_LABEL[period];
  if (!entries.length) return person ? `${label} ${person}님에게 등록된 일정이 없어요` : `${label} ${team}에 등록된 일정이 없어요`;
  const who = person ? `${person}님` : team;
  if (!oneDay) return `${label} ${who} 일정 ${entries.length}건이에요`;
  const byName = new Map<string, string[]>();
  for (const e of entries) byName.set(e.name, [...(byName.get(e.name) ?? []), entryText(e)]);
  const lines = [...byName].map(([name, parts]) => (person ? parts.join(' · ') : `${name} ${parts.join(' · ')}`));
  return `${label} ${who} 일정: ${lines.join(' / ')}`;
}
