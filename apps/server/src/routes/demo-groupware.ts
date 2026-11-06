import { createHmac, randomBytes } from 'node:crypto';
import {
  addDays,
  checkInput,
  dayLabel,
  DEMO_GROUPWARE_REASON_MAX,
  formatKstDateTime,
  type GroupwareApprover,
  type GroupwareDecisionRequest,
  type GroupwareDoc,
  type GroupwareDraftRequest,
  type GroupwareFormResponse,
  type GroupwareInboxResponse,
  isWeekend,
  kstDate,
  LEAVE_REQUEST_MAX_DAYS,
  LEAVE_KIND_LABEL,
  LEAVE_KINDS,
  offDayName,
  type LeaveDay,
  leaveDayHalves,
  leaveDayWord,
  type LeaveKind,
  reasonRequired,
  recordCutoff,
  SICK_LEAVE_PAST_DAYS,
} from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import { MockLeave } from '../adapters/mock/leave';
import type { LeaveUse } from '../adapters/types';
import type { AppContext } from '../context';
import { DeskError } from '../core/errors';
import type { DeskUser } from '../core/user';

// 시연 전용 가상 그룹웨어 전자결재(11/6 사용자 결정, 휴가 A안). 한 줄 데스크가 아니라 "회사 그룹웨어" 자리에 서는 흉내예요.
// 시연에서 한 바퀴(신청 → 팀장 결재 → 인사 결재 → 근태 반영 → 앱 반영)를 보여 주려고 둬요. 시연 받은편지함(ADR-17)과 같은 시연 전용 장치예요.
// - 시연 설정(config.demo)이고 근태 기록이 가상(MockLeave)일 때만 경로를 붙여요. 운영에는 경로가 없어요(404, 시험으로 지켜요).
// - 문서는 서버 메모리에만 둬요. 새 마이그레이션을 만들지 않으려는 것(다른 PR이 마이그레이션을 합치는 중)과, 시연 전용이라 서버가 다시 뜨면
//   비워져도 되기 때문이에요. 200건까지 두고, 만든 지 7일이 지나면 지워요(ADR-21과 같은 7일).
// - 결재선: 기안자 부서 팀장(IdP 역할 team-lead) → 인사팀. 기안자가 팀장이거나 부서에 팀장이 없으면 인사팀만이에요.
//   팀장 칸은 그 팀장만, 인사팀 칸은 인사팀 사람 누구나 결재해요. 자기 신청서는 결재하지 못해요.
// - 최종 승인되면 가상 근태 기록(MockLeave.recordUses)에 휴가를 넣어요. 한 줄 데스크(navi·홈·회의실 인원)는 이 문서를 읽지 않고
//   근태 기록만 봐요(실제 회사와 같은 경계). 그래서 승인 전에는 남은 연차·같은 팀 일정·회의실 인원 짐작에 들어가지 않아요.
// - 11/6 사용자 결정: 신청서 종류는 연차·반차(오전/오후)·병가·공가·경조예요. 사유는 병가·공가·경조면 꼭, 연차는 골라서 적어요.
//   사유는 공통 입력 검사(등급 3·키 차단, 이메일·IP 가림)를 지나고 이 메모리에만 있어요(7일, 다시 뜨면 비워짐).
//   그 문서의 지금 결재자(팀장·인사)와 기안자 본인에게만 보여요. 한 줄 데스크 앱·근태 기록·로그·감사·DB로는 가지 않고,
//   근태 반영은 날·하루/반차·종류 코드까지만이에요. 반려 사유도 같은 검사를 지나요.
// - "결재자로 보기"는 발표자가 한 화면에서 결재를 돌려 보려는 장치예요. 실제 그룹웨어는 결재자가 자기 계정으로 봐요.
// - 감사 로그·접속기록·알림·AI 호출은 없어요(한 줄 데스크의 일이 아니라서요).

/** 메모리에 둘 문서 수 상한(넘으면 오래된 것부터 지워요) */
export const DEMO_GROUPWARE_MAX_DOCS = 200;
/** 인사 결재를 하는 부서(가상 직원 명단의 부서 이름) */
const HR_DEPARTMENT = '인사팀';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REF = '^[0-9a-f]{16}$';
const MAX_DAY_TEXT = 5;

interface Step {
  kind: 'lead' | 'hr';
  /** 팀장 칸은 그 팀장(IdP 주체, 서버 메모리에만), 인사팀 칸은 null(인사팀 누구나) */
  subject: string | null;
  label: string;
  decided?: { by: string; at: number; decision: 'approved' | 'rejected' };
}

interface Doc {
  id: string;
  createdAt: number;
  /** 같은 기안을 두 번 올리지 않게(기안자 + 화면이 만든 요청 번호) */
  requestKey: string;
  drafter: { subject: string; email?: string; name: string; department: string };
  type: LeaveKind;
  /** 기안자가 적은 사유(가린 글). 이 메모리에만 있어요. */
  reason?: string;
  days: LeaveDay[];
  steps: Step[];
  current: number;
  state: 'pending' | 'approved' | 'rejected';
  rejectReason?: string;
  recorded?: boolean;
  busy?: boolean;
}

type Approver = GroupwareApprover & { subject: string };

const STATE_LABEL: Record<Doc['state'], string> = { pending: '결재 중', approved: '최종 승인', rejected: '반려' };

/** 문서 보관함(서버 메모리). 시연 전용이라 서버가 다시 뜨면 비워져요. */
export class DemoGroupwareStore {
  private readonly docs = new Map<string, Doc>();
  private seq = 0;

  constructor(private readonly now: () => number) {}

  /** 만든 지 7일 지난 문서를 지워요. 열 때마다, 그리고 한 시간 보관 회차마다 불러요. */
  purge(): void {
    const cutoff = recordCutoff(this.now());
    for (const [id, d] of this.docs) if (d.createdAt < cutoff) this.docs.delete(id);
  }

  all(): Doc[] {
    this.purge();
    return [...this.docs.values()];
  }

  get(id: string): Doc | undefined {
    this.purge();
    return this.docs.get(id);
  }

  byRequest(key: string): Doc | undefined {
    return this.all().find((d) => d.requestKey === key);
  }

  add(doc: Omit<Doc, 'id' | 'createdAt'>): Doc {
    this.purge();
    // 상한이면 가장 오래된 문서부터 지워요(Map은 넣은 순서를 지켜요).
    while (this.docs.size >= DEMO_GROUPWARE_MAX_DOCS) this.docs.delete(this.docs.keys().next().value!);
    this.seq += 1;
    const saved: Doc = { ...doc, id: `GW-${String(this.seq).padStart(4, '0')}`, createdAt: this.now() };
    this.docs.set(saved.id, saved);
    return saved;
  }

  get size(): number {
    return this.docs.size;
  }
}

const days = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}일`;

function daysText(list: readonly LeaveDay[]): string {
  const shown = list.slice(0, MAX_DAY_TEXT).map((d) => `${dayLabel(d.date)} ${leaveDayWord(d)}`);
  const total = list.reduce((n, d) => n + (d.kind === 'full' ? 1 : 0.5), 0);
  return `${shown.join(' · ')}${list.length > MAX_DAY_TEXT ? ` 외 ${list.length - MAX_DAY_TEXT}일` : ''} (${days(total)})`;
}

/** 문서 보기. withReason은 그 문서의 지금 결재자·기안자 본인에게 보일 때만 참이에요(사유는 그 사람들만 봐요). */
function view(d: Doc, withReason = false): GroupwareDoc {
  return {
    id: d.id,
    type: d.type,
    typeLabel: LEAVE_KIND_LABEL[d.type],
    ...(withReason && d.reason ? { reason: d.reason } : {}),
    daysText: daysText(d.days),
    drafter: { name: d.drafter.name, department: d.drafter.department },
    line: d.steps.map((s, i) => ({
      label: s.label,
      state: s.decided ? s.decided.decision : d.state === 'pending' && i === d.current ? 'current' : 'waiting',
      ...(s.decided ? { by: s.decided.by, at: formatKstDateTime(s.decided.at) } : {}),
    })),
    state: d.state,
    stateLabel: STATE_LABEL[d.state],
    ...(d.rejectReason ? { rejectReason: d.rejectReason } : {}),
    ...(d.state === 'approved' ? { recorded: d.recorded === true } : {}),
    createdAt: formatKstDateTime(d.createdAt),
  };
}

/**
 * 신청서의 날: 시작일~끝날의 일하는 날. 반차는 하루짜리만이에요. 연차·공가는 오늘부터, 병가는 지난 3일부터, 1년 안이에요.
 * 11/6 휴가 정확도: 주말과 함께 법정 공휴일·회사 휴일(운영 설정)도 빼요(쉬는 날은 휴가로 세지 않아요).
 */
export function draftDays(
  req: Pick<GroupwareDraftRequest, 'type' | 'from' | 'to' | 'half'>,
  today: string,
  companyHolidays: readonly string[] = [],
): LeaveDay[] {
  const real = (d: string) => DATE.test(d) && addDays(d, 0) === d;
  if (!real(req.from) || !real(req.to)) throw new DeskError('bad-request', 400, '날짜는 YYYY-MM-DD로 적어 주세요');
  if (req.to < req.from) throw new DeskError('bad-request', 400, '끝날이 시작일보다 앞이에요');
  if (req.half !== 'full' && req.from !== req.to) throw new DeskError('bad-request', 400, '반차는 하루만 고를 수 있어요');
  const earliest = req.type === 'sick' ? addDays(today, -SICK_LEAVE_PAST_DAYS) : today;
  if (req.from < earliest)
    throw new DeskError('bad-request', 400, req.type === 'sick' ? `병가는 ${SICK_LEAVE_PAST_DAYS}일 전까지만 신청할 수 있어요` : '지난 날은 신청할 수 없어요');
  if (req.to > addDays(today, 365)) throw new DeskError('bad-request', 400, '1년 안의 날만 신청할 수 있어요');
  const out: LeaveDay[] = [];
  let holidays = 0;
  for (let d = req.from; d <= req.to; d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    if (offDayName(d, companyHolidays)) {
      holidays += 1;
      continue;
    }
    out.push(req.half === 'full' ? { date: d, kind: 'full' } : { date: d, kind: 'half', half: req.half });
  }
  if (!out.length) throw new DeskError('bad-request', 400, holidays ? '고른 날이 모두 주말·쉬는 날(공휴일·회사 휴일)이에요' : '고른 날이 모두 주말이에요');
  if (out.length > LEAVE_REQUEST_MAX_DAYS) throw new DeskError('bad-request', 400, `한 번에 ${LEAVE_REQUEST_MAX_DAYS}일까지 신청할 수 있어요`);
  return out;
}

/**
 * 사유 글 검사: 공통 입력 검사(packages/shared/src/input-check)로 등급 3·키·건강 정보를 막고, 이메일·IP는 가린 글로 둬요.
 * required가 있으면 빈 글을 그 문구로 거절해요. 없으면 빈 글은 null이에요.
 */
function checkedReason(raw: string, required: string | null): string | null {
  const text = raw.trim();
  if (!text) {
    if (required) throw new DeskError('bad-request', 400, required);
    return null;
  }
  if (text.length > DEMO_GROUPWARE_REASON_MAX) throw new DeskError('bad-request', 400, `사유는 ${DEMO_GROUPWARE_REASON_MAX}자까지 적을 수 있어요`);
  const checked = checkInput(text);
  if (checked.locks.length) throw new DeskError('locked', 400, `보낼 수 없는 글자가 있어요: ${[...new Set(checked.locks.map((l) => l.message))].join(' · ')}`);
  return checked.text;
}

/** 이미 근태 기록에 있는 날과 반나절 단위로 겹치는 날 */
const clashOf = (taken: readonly Pick<LeaveUse, 'date' | 'kind' | 'half'>[], list: readonly LeaveDay[]) =>
  list.filter((d) => taken.some((u) => u.date === d.date && leaveDayHalves(u).some((h) => leaveDayHalves(d).includes(h))));

/**
 * 가상 그룹웨어 경로를 붙여요. 시연이 아니거나 근태 기록이 가상이 아니면 아무것도 붙이지 않고 null이에요(운영은 404).
 * 돌려준 보관함은 서버의 한 시간 보관 회차가 purge()로 지워요.
 */
export function registerDemoGroupwareRoutes(app: FastifyInstance, ctx: AppContext): DemoGroupwareStore | null {
  if (!ctx.config.demo || !(ctx.adapters.leave instanceof MockLeave)) return null;
  const store = new DemoGroupwareStore(ctx.now);
  // 결재자 ref: 이 서버가 뜬 동안만 쓰는 값이에요. IdP 주체를 화면에 내보내지 않아요.
  const refKey = randomBytes(16);
  const refOf = (subject: string) => createHmac('sha256', refKey).update(subject).digest('hex').slice(0, 16);
  const person = (d: Doc['drafter']) => ({ idpSubject: d.subject, ...(d.email ? { email: d.email } : {}) });

  /** 결재자로 보기 목록: 가상 직원 중 팀장(IdP 역할 team-lead)과 인사팀 사람 */
  async function approvers(): Promise<Approver[]> {
    const out: Approver[] = [];
    for (const department of await ctx.adapters.directory.departments()) {
      for (const m of await ctx.adapters.directory.departmentMembers(department, 200)) {
        const lead = m.groups.includes('team-lead');
        if (!lead && m.department !== HR_DEPARTMENT) continue;
        out.push({ ref: refOf(m.idpSubject), name: m.displayName, department: m.department, role: lead ? '팀장' : '인사팀', subject: m.idpSubject });
      }
    }
    return out.sort((a, b) => (a.role === b.role ? a.department.localeCompare(b.department) || a.name.localeCompare(b.name) : a.role === '팀장' ? -1 : 1));
  }

  /** 결재선: 기안자 부서 팀장 → 인사팀. 기안자가 팀장이거나 부서에 팀장이 없으면 인사팀만이에요. */
  async function lineFor(user: DeskUser): Promise<Step[]> {
    const lead = user.roles.includes('team-lead')
      ? undefined
      : (await ctx.adapters.directory.departmentMembers(user.department, 200)).find((m) => m.groups.includes('team-lead') && m.idpSubject !== user.idpSubject);
    return [
      ...(lead ? [{ kind: 'lead' as const, subject: lead.idpSubject, label: `${user.department} 팀장 ${lead.displayName}` }] : []),
      { kind: 'hr' as const, subject: null, label: HR_DEPARTMENT },
    ];
  }

  /** 그 결재자가 이 문서의 지금 칸을 결재할 수 있는지. 자기 신청서는 못 해요. */
  const canDecide = (d: Doc, a: Approver) => {
    const step = d.steps[d.current];
    if (d.state !== 'pending' || !step || a.subject === d.drafter.subject) return false;
    return step.kind === 'lead' ? a.subject === step.subject : a.department === HR_DEPARTMENT;
  };

  const limited = (user: DeskUser) => {
    if (!ctx.rateLimiter.hit(user.pseudonymId, 'demo-groupware')) throw new DeskError('rate-limited', 429, '요청이 많아요. 잠시 뒤에 다시 해 주세요');
  };

  app.get('/api/demo/groupware/form', { preHandler: ctx.guards.user }, async (req): Promise<GroupwareFormResponse> => {
    const user = req.deskUser!;
    return { drafter: { name: user.displayName, department: user.department }, line: (await lineFor(user)).map((s) => s.label), today: kstDate(ctx.now()) };
  });

  // 기안: 기안자는 지금 앱에 로그인한 사람이에요. 날짜·종류·하루/반차와 사유(병가·공가·경조는 꼭)를 받아요. 사유는 이 메모리에만 둬요.
  app.post<{ Body: GroupwareDraftRequest }>(
    '/api/demo/groupware/drafts',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['type', 'from', 'to', 'half', 'requestId'],
          additionalProperties: false,
          properties: {
            type: { enum: [...LEAVE_KINDS] },
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            half: { enum: ['full', 'am', 'pm'] },
            reason: { type: 'string', maxLength: DEMO_GROUPWARE_REASON_MAX },
            requestId: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' },
          },
        },
      },
    },
    async (req): Promise<{ doc: GroupwareDoc }> => {
      const user = req.deskUser!;
      limited(user);
      const requestKey = `${user.idpSubject}|${req.body.requestId}`;
      const again = store.byRequest(requestKey);
      if (again) return { doc: view(again, true) };
      const list = draftDays(req.body, kstDate(ctx.now()), ctx.ops.get().companyHolidays);
      const reason = checkedReason(req.body.reason ?? '', reasonRequired(req.body.type) ? `${LEAVE_KIND_LABEL[req.body.type]} 사유를 적어 주세요` : null);
      const drafter = { subject: user.idpSubject, ...(user.email ? { email: user.email } : {}), name: user.displayName, department: user.department };
      const record = await ctx.adapters.leave.leaveOf(person(drafter)).catch(() => null);
      const taken = clashOf(record?.uses ?? [], list);
      if (taken.length) throw new DeskError('conflict', 409, `이미 근태 기록에 휴가가 있는 날이에요: ${daysText(taken)}`);
      const pending = store.all().filter((d) => d.drafter.subject === user.idpSubject && d.state === 'pending');
      if (pending.some((d) => clashOf(d.days, list).length)) throw new DeskError('conflict', 409, '결재 중인 내 신청서와 날이 겹쳐요');
      const doc = store.add({
        requestKey,
        drafter,
        type: req.body.type,
        ...(reason ? { reason } : {}),
        days: list,
        steps: await lineFor(user),
        current: 0,
        state: 'pending',
      });
      return { doc: view(doc, true) };
    },
  );

  // 결재함: 고른 결재자 차례인 문서와, 내가 올린 문서. ref만 주소에 실려요(글 없음).
  app.get<{ Querystring: { as?: string } }>(
    '/api/demo/groupware/inbox',
    {
      preHandler: ctx.guards.user,
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { as: { type: 'string', pattern: REF } } } },
    },
    async (req): Promise<GroupwareInboxResponse> => {
      const user = req.deskUser!;
      const list = await approvers();
      const found = req.query.as ? list.find((a) => a.ref === req.query.as) : undefined;
      const docs = store.all();
      const shown = (a: Approver): GroupwareApprover => ({ ref: a.ref, name: a.name, department: a.department, role: a.role });
      return {
        approvers: list.map(shown),
        as: found ? shown(found) : null,
        // 사유는 그 문서의 지금 결재자에게만 보여요.
        waiting: found ? docs.filter((d) => canDecide(d, found)).map((d) => view(d, true)) : [],
        mine: docs
          .filter((d) => d.drafter.subject === user.idpSubject)
          .reverse()
          .map((d) => view(d, true)),
      };
    },
  );

  // 결재: 고른 결재자가 지금 칸의 결재자일 때만 돼요. 반려는 사유가 꼭 있어야 해요. 최종 승인이면 가상 근태 기록에 넣어요.
  app.post<{ Params: { id: string }; Body: GroupwareDecisionRequest }>(
    '/api/demo/groupware/docs/:id/decision',
    {
      preHandler: ctx.guards.user,
      schema: {
        params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^GW-[0-9]{4,6}$' } } },
        body: {
          type: 'object',
          required: ['as', 'decision'],
          additionalProperties: false,
          properties: {
            as: { type: 'string', pattern: REF },
            decision: { enum: ['approved', 'rejected'] },
            reason: { type: 'string', maxLength: DEMO_GROUPWARE_REASON_MAX },
          },
        },
      },
    },
    async (req): Promise<{ doc: GroupwareDoc }> => {
      limited(req.deskUser!);
      const doc = store.get(req.params.id);
      if (!doc) throw new DeskError('not-found', 404, '그 문서를 찾지 못했어요');
      if (doc.state !== 'pending') throw new DeskError('conflict', 409, '이미 결재가 끝난 문서예요');
      if (doc.busy) throw new DeskError('conflict', 409, '다른 결재를 처리하는 중이에요. 잠시 뒤에 다시 해 주세요');
      doc.busy = true;
      try {
        const approver = (await approvers()).find((a) => a.ref === req.body.as);
        if (!approver) throw new DeskError('forbidden', 403, '결재자로 고를 수 있는 사람이 아니에요');
        if (!canDecide(doc, approver)) throw new DeskError('forbidden', 403, '이 문서의 결재 차례가 아니에요');
        const step = doc.steps[doc.current]!;
        const at = ctx.now();
        if (req.body.decision === 'rejected') {
          const reason = checkedReason(req.body.reason ?? '', '반려 사유를 적어 주세요')!;
          step.decided = { by: approver.name, at, decision: 'rejected' };
          doc.state = 'rejected';
          doc.rejectReason = reason;
          return { doc: view(doc) };
        }
        if (doc.current < doc.steps.length - 1) {
          step.decided = { by: approver.name, at, decision: 'approved' };
          doc.current += 1;
          return { doc: view(doc) };
        }
        // 최종 승인: 그 순간 근태 기록을 다시 보고 겹치면 막아요. 근태 기록에 넣어야 앱(남은 연차·팀 일정·회의실 인원)에 보여요.
        const record = await ctx.adapters.leave.leaveOf(person(doc.drafter)).catch(() => null);
        const taken = clashOf(record?.uses ?? [], doc.days);
        if (taken.length) throw new DeskError('conflict', 409, `그사이 근태 기록에 휴가가 들어간 날이 있어요: ${daysText(taken)}`);
        const result = await ctx.adapters.leave.recordUses(
          person(doc.drafter),
          // 종류는 늘 넣어요(11/6: 종류 없는 근태 기록은 연차로 세지 않아요).
          doc.days.map((d) => ({ date: d.date, kind: d.kind, ...(d.half ? { half: d.half } : {}), type: doc.type })),
        );
        step.decided = { by: approver.name, at, decision: 'approved' };
        doc.state = 'approved';
        doc.recorded = result === 'recorded';
        return { doc: view(doc) };
      } finally {
        doc.busy = false;
      }
    },
  );

  return store;
}
