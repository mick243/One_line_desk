import {
  addDays,
  type Card,
  type CardAction,
  dayLabel,
  fillLeaveLink,
  KST_OFFSET,
  kstDate,
  kstTime,
  LEAVE_APPLY_IN_GROUPWARE,
  LEAVE_APPROVALS_TEXT,
  LEAVE_FREE_DAY_MAX,
  LEAVE_FREE_DAY_RANGE,
  LEAVE_HANDOFF_TEXT,
  LEAVE_KIND_LABEL,
  LEAVE_REASON_IN_GROUPWARE,
  type LeaveDay,
  leaveDayHalves,
  leaveDayPickable,
  leaveDayWord,
  type LeaveKind,
  type LeaveLinkValues,
  SICK_NOTE_TEXT,
} from '@one-line-desk/shared';
import type { LeaveUse } from '../../adapters/types';
import type { AppContext } from '../../context';
import { makeCard } from '../../core/cards';
import { weekdayOf } from '../../core/slots';
import type { DeskUser } from '../../core/user';

// 휴가 A안: 그룹웨어로 넘기기(11/6 사용자 결정, ADR-24 개정·ADR-18 보강).
// 휴가 신청·결재(팀장 → 인사)는 회사 그룹웨어 전자결재가 해요. 앱은 결재 권한이 없어요(승인·반려·근태 쓰기 0).
// 앱이 하는 일은 둘이에요.
// 1) 신청 전 판단: "다음 주 금요일 연차 쓰고 싶어" → 신청 전 카드(그날 쓰면 남은 연차 ○일 → ○일, 그날 내 일정, 규정 한 줄,
//    [그룹웨어에서 신청하기]·[신청 내용 복사]). 숫자는 서버 규칙(leave.ts)이고, 내 일정은 회의실 서비스 인터페이스로 본인 것만 읽어요.
//    AI에는 질문 글만 가요(leave.ts readLeaveQuestion). 남은 연차·일정·규정 문장은 모델에 보내지 않아요.
//    11/6 사용자 결정 "걸린 일이 없는 날 고르기": 이미 잡힌 일이 있는 날에 휴가를 쓰도록 돕지 않아요. 그래서
//    - [예약 옮기기]·[못 가요]처럼 남에게 영향을 주는 정리 버튼은 카드에 두지 않아요.
//    - 연차·반차(미리 고를 수 있는 휴가): 그날 잡힌 내 일을 사실로만 보여 주고, 걸린 일이 없는 가까운 평일(앞뒤 7평일)을
//      2개쯤 제안해요. [이 날로 보기]는 그 날로 카드를 다시 계산해요(읽기만). 회사 휴일은 몰라서 평일만 봐요. 훈계 문구는 쓰지 않아요.
//    - 병가·공가·경조(날을 고를 수 없는 휴가): 다른 날은 제안하지 않고, 그날 잡혀 있던 내 일만 알려요.
// 2) 승인 뒤 반영: "내 휴가 신청 어떻게 됐어?" → 근태 기록에 들어간(승인된) 본인 휴가만 읽어요. 결재 중인 것은 앱이 몰라서
//    "결재 진행 상황은 그룹웨어 결재함에서 봐요" + [결재함 열기]예요. 그룹웨어 결재 문서는 읽지 않아요.
// 링크·복사 글에는 날짜·종류 코드만 넣어요(질문 글·사유 없음, R13). 앱은 사유를 받지 않아요. 사유는 그룹웨어 신청서에만 적어요.

const CHECK_ID = 'navi-leave-check';
const STATUS_ID = 'navi-leave-status';
const DAY_MS = 24 * 60 * 60 * 1000;
/** 오전 반차는 13시 전, 오후 반차는 13시부터로 봐요(같은 팀 일정·회의실 인원 짐작과 같아요, ADR-06 11/4). */
const NOON = '13:00';
/** 규정 한 줄을 찾는 말(서버가 정한 말이에요. 사람이 쓴 질문은 넣지 않아요). */
const RULE_QUERY = '연차 휴가 신청';
const RULE_WORDS = /연차|휴가|반차/;
/** 카드에 보여 줄 날·일 수 상한 */
const MAX_LINES = 4;

const fmt = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}일`;
const total = (days: readonly LeaveDay[]) => days.reduce((n, d) => n + (d.kind === 'full' ? 1 : 0.5), 0);
/** 짧은 날짜 "11/14(금)" */
const shortDay = (date: string) => dayLabel(date).replace(/^(\d+)월 (\d+)일/, '$1/$2');
const isWeekday = (date: string) => weekdayOf(date) !== 0 && weekdayOf(date) !== 6;

/** 그룹웨어 휴가 신청·결재함 주소. 운영 설정이 비어 있으면 시연은 가상 그룹웨어 주소, 운영은 없음(null)이에요. */
export function groupwareLinks(ctx: Pick<AppContext, 'ops' | 'config'>): { leave: string | null; approvals: string | null } {
  const links = ctx.ops.get().links;
  const base = ctx.config.publicBaseUrl;
  return {
    leave: links.leave || (ctx.config.demo ? `${base}/demo/groupware/leave?type={type}&from={from}&to={to}&half={half}` : null),
    approvals: links.approvals || (ctx.config.demo ? `${base}/demo/groupware/inbox` : null),
  };
}

/** 링크 자리 표시 값: 첫날·끝날·종류·반차(하루짜리 반차일 때만). 여러 날에 반차가 섞이면 하루로 두고 복사 글로 고쳐요. */
export function leaveLinkValues(type: LeaveKind, days: readonly LeaveDay[]): LeaveLinkValues {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const only = sorted.length === 1 ? sorted[0]! : null;
  const half = only?.kind === 'half' ? (only.half ?? 'half') : '';
  return { from: sorted[0]?.date ?? '', to: sorted.at(-1)?.date ?? '', type, half };
}

/** [신청 내용 복사] 글: "연차 · 11/14(금) 하루". 종류·날짜만이고 사유는 넣지 않아요. */
export function leaveCopyText(type: LeaveKind, days: readonly LeaveDay[]): string {
  return [LEAVE_KIND_LABEL[type], ...days.map((d) => `${shortDay(d.date)} ${leaveDayWord(d)}`)].join(' · ');
}

const dayText = (days: readonly LeaveDay[]) => {
  const shown = days.slice(0, MAX_LINES).map((d) => `${dayLabel(d.date)} ${leaveDayWord(d)}`);
  return days.length > MAX_LINES ? `${shown.join(' · ')} 외 ${days.length - MAX_LINES}일` : shown.join(' · ');
};

/** 그 휴가 날이 차지하는 시간(한국 시간). 오전·오후를 모르는 반차는 하루로 봐요(넉넉하게 알려요). */
function spanOf(d: LeaveDay): [number, number] {
  const start = Date.parse(`${d.date}T00:00:00${KST_OFFSET}`);
  const noon = Date.parse(`${d.date}T${NOON}:00${KST_OFFSET}`);
  if (d.kind === 'half' && d.half === 'am') return [start, noon];
  if (d.kind === 'half' && d.half === 'pm') return [noon, start + DAY_MS];
  return [start, start + DAY_MS];
}

interface MySlot {
  start: number;
  end: number;
  room: string;
  /** 내 예약이면 참, 초대받아 가는 회의면 거짓 */
  own: boolean;
}

/**
 * 내 일정: 내 회의실 예약과 내가 가는 회의(못 간다고 한 초대는 빼요). 회의실 모듈의 서비스 인터페이스로 본인 것만 읽어요(표 직접 읽기 없음).
 * 회의실이 꺼져 있거나 회의실 쓰기가 꺼져 있으면(예약이 없으면) 비어 있어요. 회의 제목·참석자는 없어요(ADR-06·17).
 */
async function mySlots(ctx: AppContext, user: DeskUser): Promise<MySlot[]> {
  const rooms = ctx.ops.get().modules.rooms === 'on' ? ctx.services.rooms : undefined;
  if (!rooms) return [];
  const own: MySlot[] = rooms.myReservations
    ? (await rooms.myReservations(user)).items.map((r) => ({ start: Date.parse(r.start), end: Date.parse(r.end), room: r.roomName, own: true }))
    : [];
  const invited: MySlot[] = rooms.home
    ? (await rooms.home.invited(user)).items
        .filter((m) => m.response !== 'declined')
        .map((m) => ({ start: Date.parse(m.start), end: Date.parse(m.end), room: m.roomName, own: false }))
    : [];
  return [...own, ...invited].sort((a, b) => a.start - b.start);
}

/** 그 휴가 날(하루·반나절)과 겹치는 내 일 */
const slotsOn = (slots: readonly MySlot[], d: LeaveDay) => {
  const [a, b] = spanOf(d);
  return slots.filter((s) => s.start < b && s.end > a);
};

/** 이미 근태 기록에 들어간 날과 반나절 단위로 겹치는지 */
const takenOn = (taken: readonly LeaveUse[], d: LeaveDay) =>
  taken.some((u) => u.date === d.date && leaveDayHalves(u).some((h) => leaveDayHalves(d).includes(h)));

/** "15:00~16:00 회의(가상 회의실 A, 내 예약)" — 제목·참석자 없이 시간·회의실만이에요. */
const meetingText = (s: MySlot) => `${kstTime(s.start)}~${kstTime(s.end)} 회의(${s.room}, ${s.own ? '내 예약' : '참석'})`;

/**
 * 걸린 일이 없는 가까운 평일(11/6). 고른 날(같은 하루·반나절) 앞뒤로 LEAVE_FREE_DAY_RANGE 평일 안에서, 가까운 순(뒤·앞 번갈아)으로
 * 내 일이 없고 근태 기록에도 없는 날을 LEAVE_FREE_DAY_MAX개 찾아요. 오늘 전·1년 뒤·이미 고른 날은 빼요. 회사 휴일은 몰라요.
 */
export function freeDaysNear(day: LeaveDay, slots: readonly MySlot[], taken: readonly LeaveUse[], exclude: ReadonlySet<string>, today: string): string[] {
  const walk = (step: 1 | -1) => {
    const out: string[] = [];
    for (let d = day.date; out.length < LEAVE_FREE_DAY_RANGE;) {
      d = addDays(d, step);
      if (isWeekday(d)) out.push(d);
    }
    return out;
  };
  const after = walk(1);
  const before = walk(-1);
  const last = addDays(today, 365);
  const found: string[] = [];
  for (let i = 0; i < LEAVE_FREE_DAY_RANGE && found.length < LEAVE_FREE_DAY_MAX; i += 1) {
    for (const date of [after[i]!, before[i]!]) {
      if (found.length >= LEAVE_FREE_DAY_MAX || exclude.has(date) || date < today || date > last) continue;
      const probe: LeaveDay = { ...day, date };
      if (!slotsOn(slots, probe).length && !takenOn(taken, probe)) found.push(date);
    }
  }
  return found.sort();
}

/** 신청 전 카드에 넣을 숫자(서버 규칙으로 leave.ts가 계산). AI가 정하지 않아요. */
export interface LeaveCheckNumbers {
  /** 이번 연차 기간 남은 연차와 쓰면 남는 연차. 근태 기록이 없으면 null이에요. */
  annual: { remaining: number; after: number } | null;
  /** 고른 날이 다음 연차 기간에 들면 그 기간 계산 */
  next?: { periodStart: string; remaining: number; after: number } | null;
  /** 병가: 올해 병가 쓴 날 → 쓰면, 한도(0이면 없음 null), 진단서 안내 대상인지 */
  sick?: { used: number; after: number; limit: number | null; note: boolean } | null;
}

export interface LeaveCheckInput {
  type: LeaveKind;
  /** 쓸 날(날짜로 말했을 때) */
  days: LeaveDay[];
  /** 날 없이 양만 말했을 때(하루 연차 일수·반차 횟수) */
  amount?: { full: number; half: number };
  /** 주말이라 뺀 날 수 */
  weekendSkipped?: number;
  numbers: LeaveCheckNumbers;
  /** 본인 근태 기록에 이미 있는 날(겹침 알림·다른 날 고르기용) */
  taken: readonly LeaveUse[];
  /** 실제 모델이 질문(더 쓰려는 양)을 해석했는지("AI 정리") */
  viaAi: boolean;
}

function headlineOf(input: LeaveCheckInput, used: number): string {
  const { annual } = input.numbers;
  if (input.type !== 'annual') return `${LEAVE_KIND_LABEL[input.type]}는 연차에서 빠지지 않아요`;
  if (!annual) return '남은 연차를 불러오지 못했어요';
  if (used <= 0) return `남은 연차는 ${fmt(annual.remaining)}이에요`;
  const what = input.days.length === 1 ? `${dayLabel(input.days[0]!.date)} ${leaveDayWord(input.days[0]!)}` : `연차 ${fmt(used)}`;
  return annual.after >= 0 ? `${what} 쓰면 남은 연차는 ${fmt(annual.after)}이에요` : `${what} 쓰면 연차가 ${fmt(-annual.after)} 모자라요`;
}

/**
 * 그날 내 일정 칸과 [이 날로 보기](11/6). 남에게 영향을 주는 정리 버튼은 만들지 않아요.
 * - 연차·반차: 잡힌 일을 "11/14(금)에는 14:00~15:00 회의(…)가 잡혀 있어요"처럼 사실로만, 그리고 걸린 일이 없는 가까운 날 제안.
 * - 병가·공가·경조: "그날 잡혀 있던 일 N건이 있어요"만(다른 날 제안 없음).
 */
function scheduleParts(input: LeaveCheckInput, slots: readonly MySlot[], today: string): { fields: Card['fields']; actions: CardAction[] } {
  const { days, type } = input;
  if (!days.length) return { fields: [], actions: [] };
  const busy = days.map((d) => ({ day: d, on: slotsOn(slots, d) })).filter((x) => x.on.length > 0);
  if (!leaveDayPickable(type)) {
    const n = busy.reduce((k, x) => k + x.on.length, 0);
    if (!n) return { fields: [], actions: [] };
    const list = busy.flatMap((x) => x.on.map((s) => `${shortDay(x.day.date)} ${kstTime(s.start)}~${kstTime(s.end)} ${s.room}`));
    return { fields: [{ name: '그날 내 일정', value: `그날 잡혀 있던 일 ${n}건이 있어요 · ${list.slice(0, MAX_LINES).join(' · ')}` }], actions: [] };
  }
  if (!busy.length) return { fields: [{ name: '그날 내 일정', value: '그날 잡힌 내 일이 없어요' }], actions: [] };
  const facts = busy.map((x) => `${shortDay(x.day.date)}에는 ${x.on.slice(0, MAX_LINES).map(meetingText).join(' · ')}가 잡혀 있어요`).join(' ');
  // 걸린 날 하나(첫 날)를 가까운 날로 바꿔 보는 제안이에요. 여러 날이면 나머지 날은 그대로 둬요.
  const first = busy[0]!.day;
  const exclude = new Set(days.map((d) => d.date));
  const free = freeDaysNear(first, slots, input.taken, exclude, today);
  const actions: CardAction[] = free.map((date) => ({
    type: 'leave-day',
    text: `${shortDay(date)}로 보기`,
    leaveType: type,
    days: days
      .map((d) => (d.date === first.date ? { ...d, date } : d))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ date: d.date, kind: d.kind, ...(d.kind === 'half' && d.half ? { half: d.half } : {}) })),
  }));
  return {
    fields: [
      { name: '그날 내 일정', value: facts },
      {
        name: '걸린 일이 없는 가까운 날',
        value: free.length ? free.map(shortDay).join(' · ') : `앞뒤 ${LEAVE_FREE_DAY_RANGE}평일 안에서 찾지 못했어요`,
      },
    ],
    actions,
  };
}

/**
 * 신청 전 카드(11/6 A안). 홈 채팅·문의함·MCP 휴가 준비 링크·바로 하기·[이 날로 보기]가 같은 카드를 써요. 쓰기는 없어요.
 * [그룹웨어에서 신청하기]는 날짜·종류 코드만 채운 그룹웨어 주소예요. 주소가 없으면 "그룹웨어에서 신청해 주세요" 글만 보여요.
 */
export async function leaveCheckCard(ctx: AppContext, user: DeskUser, input: LeaveCheckInput): Promise<Card> {
  const today = kstDate(ctx.now());
  const { days, type, numbers } = input;
  const amountDays = input.amount ? input.amount.full + input.amount.half * 0.5 : 0;
  const used = days.length ? total(days) : amountDays;
  const [slots, rule] = await Promise.all([
    days.length ? mySlots(ctx, user).catch(() => [] as MySlot[]) : Promise.resolve([] as MySlot[]),
    ctx.services.notices?.ruleLine && ctx.ops.get().modules.notices === 'on'
      ? ctx.services.notices.ruleLine(RULE_QUERY, RULE_WORDS).catch(() => null)
      : Promise.resolve(null),
  ]);
  const taken = days.filter((d) => takenOn(input.taken, d));
  const schedule = scheduleParts(input, slots, today);
  const links = groupwareLinks(ctx);
  const href = links.leave ? fillLeaveLink(links.leave, leaveLinkValues(type, days)) : null;

  const amountText = input.amount
    ? [input.amount.full ? `연차 ${fmt(input.amount.full)}` : '', input.amount.half ? `반차 ${input.amount.half}번` : ''].filter(Boolean).join(' · ')
    : '';
  const plan = days.length ? `${dayText(days)}${input.weekendSkipped ? ' (주말은 뺐어요)' : ''}` : amountText;
  const annual = numbers.annual;
  const annualLine = !annual
    ? '불러오지 못했어요 · 그룹웨어 근태 메뉴에서 봐요'
    : type !== 'annual'
      ? `${fmt(annual.remaining)} 그대로예요(${LEAVE_KIND_LABEL[type]}는 연차에서 빠지지 않아요)`
      : annual.after >= 0
        ? `${fmt(annual.remaining)} → ${fmt(annual.after)}`
        : `${fmt(annual.remaining)} → ${fmt(-annual.after)} 모자라요`;
  const sick = numbers.sick;

  return makeCard({
    id: CHECK_ID,
    kind: 'navi',
    label: '안내',
    headline: headlineOf(input, used),
    fields: [
      ...(plan ? [{ name: '쓸 날', value: plan }] : []),
      { name: '남은 연차', value: annualLine },
      ...(type === 'annual' && numbers.next
        ? [{ name: '다음 연차 기간', value: `${numbers.next.periodStart}부터 ${fmt(numbers.next.remaining)} → ${fmt(numbers.next.after)}` }]
        : []),
      ...(sick ? [{ name: '올해 병가', value: `${fmt(sick.used)} → ${fmt(sick.after)}${sick.limit ? ` (한도 ${fmt(sick.limit)})` : ''}` }] : []),
      ...(sick?.note ? [{ name: '진단서', value: SICK_NOTE_TEXT }] : []),
      ...(taken.length ? [{ name: '이미 잡힌 휴가', value: `${dayText(taken)} · 이미 근태 기록에 있어요` }] : []),
      ...schedule.fields,
      // 병가·공가·경조는 사유가 있어야 하지만 앱은 사유를 받지 않아요. 그룹웨어 신청서에만 적어요(11/6).
      ...(type !== 'annual' ? [{ name: '사유', value: LEAVE_REASON_IN_GROUPWARE }] : []),
      ...(rule ? [{ name: '휴가 규정', value: `“${rule.sentence}” · ${rule.title}` }] : []),
      ...(href ? [] : [{ name: '신청하는 곳', value: LEAVE_APPLY_IN_GROUPWARE }]),
    ],
    evidence: {
      text: annual ? `인사 근태 기록으로 서버가 계산 · 나에게만 보여요 · ${today} 기준` : '인사 근태 기록',
      ...(rule ? { href: rule.url } : {}),
      aiSummarized: input.viaAi && used > 0,
    },
    ...(href ? { primary: { type: 'link' as const, text: '그룹웨어에서 신청하기', href } } : {}),
    // 버튼은 그룹웨어로 가기·복사·다른 날 보기뿐이에요. 남에게 영향을 주는 정리 버튼(예약 옮기기·못 가요)은 두지 않아요(11/6).
    secondary: [...(days.length ? [{ type: 'copy' as const, text: '신청 내용 복사', value: leaveCopyText(type, days) }] : []), ...schedule.actions],
    tail: LEAVE_HANDOFF_TEXT,
  });
}

/**
 * 상태 묻기(11/6 A안): "내 휴가 신청 어떻게 됐어?". 근태 기록에 들어간(승인된) 본인 휴가 중 [from, to] 날만 보여요.
 * 결재 중인 신청은 앱이 몰라서 그룹웨어 결재함으로 보내요. 앱은 그룹웨어 결재 문서를 읽지 않아요.
 */
export async function leaveStatusCard(ctx: AppContext, user: DeskUser, from: string, to: string): Promise<Card> {
  const record = await ctx.adapters.leave.leaveOf({ idpSubject: user.idpSubject, ...(user.email ? { email: user.email } : {}) }).catch(() => null);
  const approved = (record?.uses ?? [])
    .filter((u) => u.date >= from && u.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((u) => ({ date: u.date, kind: u.kind, ...(u.half ? { half: u.half } : {}), type: u.type ?? 'annual' }));
  const approvals = groupwareLinks(ctx).approvals;
  const first = approved[0];
  const headline = !record
    ? '근태 기록을 불러오지 못했어요'
    : !first
      ? '근태 기록에 승인된 휴가가 없어요'
      : approved.length === 1
        ? `${dayLabel(first.date)} ${LEAVE_KIND_LABEL[first.type]} ${leaveDayWord(first)}가 승인됐어요`
        : `승인된 휴가가 ${approved.length}개 있어요`;
  const shown = approved.slice(0, MAX_LINES).map((u) => `${dayLabel(u.date)} ${LEAVE_KIND_LABEL[u.type]} ${leaveDayWord(u)}`);
  return makeCard({
    id: STATUS_ID,
    kind: 'navi',
    label: '안내',
    headline,
    fields: [
      ...(approved.length
        ? [{ name: '승인됐어요', value: `${shown.join(' · ')}${approved.length > MAX_LINES ? ` 외 ${approved.length - MAX_LINES}개` : ''}` }]
        : []),
      { name: '결재 중인 신청', value: LEAVE_APPROVALS_TEXT },
    ],
    evidence: { text: record ? `인사 근태 기록(승인된 휴가만) · ${from} ~ ${to}` : '인사 근태 기록', aiSummarized: false },
    ...(approvals ? { primary: { type: 'link' as const, text: '결재함 열기', href: approvals } } : {}),
    tail: '나에게만 보여요. 앱은 그룹웨어 결재 문서를 읽지 않고, 승인돼 근태 기록에 들어간 휴가만 봐요',
  });
}
