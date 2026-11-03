import {
  addDays,
  type Card,
  type CardAction,
  checkInput,
  INQUIRY_KEEP_DAYS,
  INQUIRY_QUESTION_MAX,
  INQUIRY_REASON_MAX,
  INQUIRY_REPLY_MAX,
  INQUIRY_STATE_LABEL,
  type InquiryDecisionRequest,
  type InquiryItem,
  type InquiryListResponse,
  type InquiryReplyRequest,
  type InquiryRequest,
  kstDate,
  type LeaveDay,
  LEAVE_REJECT_REASON_MAX,
  LEAVE_REQUEST_MAX_DAYS,
  LEAVE_TYPE_LABEL,
  type LeaveRequestBalance,
  type LeaveType,
  OFFICIAL_LEAVE_REASON_LABEL,
  type OfficialLeaveReason,
  recordCutoff,
} from '@one-line-desk/shared';
import type { LeaveRecord } from '../../adapters/types';
import type { AppContext } from '../../context';
import { makeCard } from '../../core/cards';
import { DeskError } from '../../core/errors';
import { WEEKDAYS, weekdayOf } from '../../core/slots';
import type { DeskUser } from '../../core/user';
import { GENERAL_TASK } from './cards';
import { GENERAL_DESK } from './fixtures';
import { HALF_DAY, leaveRequestBalance } from './leave';
import * as repo from './repo';
import { feedbackDay } from './service';

// 담당 팀에 문의 보내기(10/26, ADR-16).
// - 받는 곳은 분장표 행의 주인 부서예요. 담당자 이름은 분장표에 없어요(D9).
// - 사람이 확인 시트에서 [보내기]를 누른 글만 저장해요(고정 버튼 + 멱등 키). 묻기 문장과 달리 받는 팀이 읽어야 하는 글이에요.
// - 보낸 사람의 이름·부서는 받는 팀이 답하려고 봐요. 확인 시트에서 미리 알려요.
// - 알림에는 글을 넣지 않고 "새 문의가 왔어요 · 업무 이름"만 넣어요. 글은 받은 문의함에서 부서를 확인한 뒤 보여 줘요.
// - LLM은 부르지 않아요.
// 10/30 휴가 요청·답장(ADR-24): 휴가 요청은 쓸 날을 같이 보내고, 받은 팀이 [승인]·[반려](사유 필수)해요. 승인하면 근태 기록에 들어가요.
//   받은 팀은 그 요청을 보낸 사람의 남은 연차를 그 요청 안에서만 봐요(서버 규칙 계산, 저장 안 함). 답장은 받은 팀이 보내고 7일 보관해요.
// 11/1 공가: 휴가 요청에 종류(연차·공가)가 붙어요. 공가는 정해진 사유 코드가 꼭 있고, 연차에서 빠지지 않아서 남은 연차를 보여 주지 않아요.

const KST_MS = 9 * 60 * 60 * 1000;
const kstIso = (at: number) => `${new Date(at + KST_MS).toISOString().slice(0, 19)}+09:00`;

/** "인사팀" → "인사팀이", "IT지원" → "IT지원이"처럼 받침에 맞는 조사 */
function subject(word: string): string {
  const last = word.charCodeAt(word.length - 1);
  const hasBatchim = last >= 0xac00 && last <= 0xd7a3 ? (last - 0xac00) % 28 !== 0 : false;
  return `${word}${hasBatchim ? '이' : '가'}`;
}

const SENT_TAIL = `보낸 글은 ${INQUIRY_KEEP_DAYS}일 동안 보관돼요`;
const OPEN: readonly repo.InquiryRow['state'][] = ['new', 'seen'];
const LEAVE_WORD = { full: '하루', half: '반차' } as const;

const leaveTotal = (days: readonly LeaveDay[]) => days.reduce((n, d) => n + (d.kind === 'full' ? 1 : HALF_DAY), 0);
const dayText = (d: string) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일(${WEEKDAYS[weekdayOf(d)]})`;
const fmtDays = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}일`;
/** "11월 3일(월) 하루 · 11월 4일(화) 반차" */
export const leaveSummary = (days: readonly LeaveDay[]) => days.map((d) => `${dayText(d.date)} ${LEAVE_WORD[d.kind]}`).join(' · ');
/** 알림·카드에 쓰는 요청 이름: "휴가 요청"(연차), "공가 요청", "문의" */
const requestWord = (i: Pick<repo.InquiryRow, 'kind' | 'leaveType'>) => (i.kind !== 'leave' ? '문의' : i.leaveType === 'official' ? '공가 요청' : '휴가 요청');

function sentCard(i: repo.InquiryRow): Card {
  const leave = i.kind === 'leave' && i.leaveDays;
  const official = i.leaveType === 'official';
  return makeCard({
    id: `navi-inquiry-${i.id}`,
    kind: 'navi',
    label: '확정',
    headline: leave ? `${i.team}에 ${requestWord(i)}을 보냈어요` : `${i.team}에 보냈어요`,
    fields: [
      { name: '업무', value: i.task },
      { name: '받는 곳', value: i.team },
      ...(leave
        ? [
            {
              name: '쓸 날',
              value: `${leaveSummary(i.leaveDays!)} · ${LEAVE_TYPE_LABEL[official ? 'official' : 'annual']} ${fmtDays(leaveTotal(i.leaveDays!))}`,
            },
          ]
        : []),
      ...(official && i.leaveReasonCode ? [{ name: '공가 사유', value: OFFICIAL_LEAVE_REASON_LABEL[i.leaveReasonCode] }] : []),
      { name: '상태', value: INQUIRY_STATE_LABEL[i.state] },
    ],
    evidence: {
      text: !leave
        ? '처리 상태가 바뀌거나 답장이 오면 알려 드려요. 문의하기 "내 문의"에서 볼 수 있어요'
        : official
          ? '승인·반려되면 알려 드려요. 승인되면 근태 기록에 공가로 들어가고 연차에서는 빠지지 않아요. 증빙은 인사팀에 따로 내 주세요'
          : '승인·반려되면 알려 드려요. 승인되면 근태 기록에 들어가 남은 연차에서 빠져요. 문의하기 "내 문의"에서도 볼 수 있어요',
      aiSummarized: false,
    },
    tail: SENT_TAIL,
  });
}

function stateAction(i: repo.InquiryRow, to: 'seen' | 'done'): CardAction {
  return { type: 'fixed', text: INQUIRY_STATE_LABEL[to], method: 'POST', path: `/api/navi/inquiries/${i.id}/state`, body: { state: to } };
}

/** 받은 문의함 버튼. 휴가 요청은 [처리했어요] 대신 화면의 [승인]·[반려](decision)예요. */
function inboxActions(i: repo.InquiryRow): CardAction[] {
  if (i.state === 'new') return i.kind === 'leave' ? [stateAction(i, 'seen')] : [stateAction(i, 'seen'), stateAction(i, 'done')];
  if (i.state === 'seen' && i.kind === 'general') return [stateAction(i, 'done')];
  return [];
}

function toItem(i: repo.InquiryRow, view: 'inbox' | 'mine', replies: repo.ReplyRow[], balance?: LeaveRequestBalance | null): InquiryItem {
  const open = OPEN.includes(i.state);
  return {
    id: i.id,
    task: i.task,
    team: i.team,
    question: i.question,
    reason: i.reason,
    state: i.state,
    createdAt: kstIso(i.created),
    updatedAt: kstIso(i.updated),
    ...(view === 'inbox' ? { sender: { name: i.senderName, department: i.senderDepartment } } : {}),
    actions: view === 'inbox' ? inboxActions(i) : [],
    kind: i.kind,
    ...(i.kind === 'leave' && i.leaveDays
      ? {
          leave: {
            type: i.leaveType ?? 'annual',
            ...(i.leaveReasonCode ? { officialReason: i.leaveReasonCode } : {}),
            days: i.leaveDays,
            total: leaveTotal(i.leaveDays),
            ...(view === 'inbox' && open && i.leaveType !== 'official' ? { balance: balance ?? null } : {}),
          },
        }
      : {}),
    ...(i.decisionReason ? { decisionReason: i.decisionReason } : {}),
    ...(i.state === 'approved' ? { recorded: i.leaveRecorded === true } : {}),
    replies: replies.filter((r) => r.inquiryId === i.id).map((r) => ({ from: 'team' as const, name: r.authorName, text: r.body, at: kstIso(r.at) })),
    ...(view === 'inbox' ? { canReply: true, canDecide: i.kind === 'leave' && open } : {}),
  };
}

/** 사람이 쓴 글을 공통 검사로 다시 봐요(ADR-11). 키·주민번호·건강 정보 같은 글은 보내지 않아요. 이메일·IP는 가린 글로 저장해요. */
function checked(text: string, max: number, what: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new DeskError('bad-request', 400, `${what}을 적어 주세요`);
  if (trimmed.length > max) throw new DeskError('bad-request', 400, `${what}은 ${max}자까지 적을 수 있어요`);
  const result = checkInput(trimmed);
  if (result.locks.length) throw new DeskError('locked', 400, `보낼 수 없는 글자가 있어요: ${[...new Set(result.locks.map((l) => l.message))].join(' · ')}`);
  return result.text;
}

/** 휴가 날 검사: 오늘부터 1년 안의 평일, 겹치지 않게, 날짜 순으로 정리해요. */
function checkedLeaveDays(days: readonly LeaveDay[], today: string): LeaveDay[] {
  if (!days.length) throw new DeskError('bad-request', 400, '쓸 날을 하나 이상 골라 주세요');
  if (days.length > LEAVE_REQUEST_MAX_DAYS) throw new DeskError('bad-request', 400, `한 번에 ${LEAVE_REQUEST_MAX_DAYS}일까지 신청할 수 있어요`);
  const last = addDays(today, 365);
  const seen = new Set<string>();
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || addDays(d.date, 0) !== d.date) throw new DeskError('bad-request', 400, '날짜를 다시 골라 주세요');
    if (d.date < today) throw new DeskError('bad-request', 400, `${dayText(d.date)}은 지난 날이에요`);
    if (d.date > last) throw new DeskError('bad-request', 400, '1년 안의 날만 신청할 수 있어요');
    if ([0, 6].includes(weekdayOf(d.date))) throw new DeskError('bad-request', 400, `${dayText(d.date)}은 주말이에요`);
    if (seen.has(d.date)) throw new DeskError('bad-request', 400, `${dayText(d.date)}을 두 번 골랐어요`);
    seen.add(d.date);
  }
  return [...days].map((d) => ({ date: d.date, kind: d.kind })).sort((a, b) => a.date.localeCompare(b.date));
}

/** 휴가 종류와 공가 사유 코드 검사. 공가는 사유 코드가 꼭 있고, 연차는 사유 코드를 받지 않아요. */
function checkedLeaveType(type: LeaveType | undefined, reason: OfficialLeaveReason | undefined): { type: LeaveType; reasonCode: OfficialLeaveReason | null } {
  const t = type ?? 'annual';
  if (t === 'official' && !reason) throw new DeskError('bad-request', 400, '공가 사유를 골라 주세요');
  if (t === 'annual' && reason) throw new DeskError('bad-request', 400, '공가 사유는 공가 요청에만 골라요');
  return { type: t, reasonCode: t === 'official' ? reason! : null };
}

/** 근태 기록에 이미 있는 날(쓴 날·예정·승인된 날)과 겹치면 막아요. */
function overlapping(record: LeaveRecord | null, days: readonly LeaveDay[]): string[] {
  const used = new Set((record?.uses ?? []).map((u) => u.date));
  return days.filter((d) => used.has(d.date)).map((d) => dayText(d.date));
}

export function createInquiryService(ctx: AppContext) {
  const purge = () => ctx.db.tx((q) => repo.purgeInquiries(q, recordCutoff(ctx.now()), ctx.now()));
  /** 보관 기간 시작(지금 - 7일). 읽고 바꾸는 쿼리는 이 뒤에 보낸 문의만 봐요(11/3). */
  const since = () => recordCutoff(ctx.now());
  const personOf = async (subject: string) => {
    const profile = await ctx.adapters.directory.getProfile(subject).catch(() => null);
    return { idpSubject: subject, ...(profile?.email ? { email: profile.email } : {}) };
  };
  /** 그 요청을 보낸 사람의 남은 연차(서버 규칙, ADR-18·24). 저장하지 않고 열 때마다 계산해요. 기록이 없으면 null이에요. */
  const balanceOf = async (i: repo.InquiryRow): Promise<LeaveRequestBalance | null> => {
    if (!i.senderSubject || !i.leaveDays || i.leaveType === 'official') return null;
    const record = await ctx.adapters.leave.leaveOf(await personOf(i.senderSubject)).catch(() => null);
    if (!record) return null;
    return leaveRequestBalance(record, kstDate(ctx.now()), i.leaveDays);
  };
  const withReplies = async (rows: repo.InquiryRow[], view: 'inbox' | 'mine'): Promise<InquiryItem[]> => {
    const replies = await repo.repliesOf(
      ctx.db,
      rows.map((r) => r.id),
    );
    return Promise.all(
      rows.map(async (i) =>
        toItem(
          i,
          view,
          replies,
          view === 'inbox' && i.kind === 'leave' && i.leaveType !== 'official' && OPEN.includes(i.state) ? await balanceOf(i) : undefined,
        ),
      ),
    );
  };

  return {
    /**
     * 7일(INQUIRY_KEEP_DAYS) 지난 문의·답장을 지우고 주간 셈에 더해요. 한 시간 보관 회차(모듈 retention)만 불러요.
     * 11/3(ADR-21 개정): 목록을 열 때 지우던 것을 뺐어요. 읽기는 created_at으로 걸러서 7일 지난 문의가 보이지 않아요.
     */
    purge,

    /**
     * 문의 보내기. 화면은 확인 시트를 먼저 띄우고, 같은 requestId로 두 번 와도 한 번만 들어가요.
     * 휴가 요청(leave)은 분장표 행의 주인 부서(인사팀)로 가고, 받은 팀이 보낸 사람 남은 연차를 그 요청 안에서만 봐요(ADR-24).
     */
    async send(user: DeskUser, req: InquiryRequest): Promise<{ status: 'done'; card: Card }> {
      if (ctx.ops.get().modules.navi === 'off') throw new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
      if (!ctx.rateLimiter.hit(user.pseudonymId, 'inquiry')) throw new DeskError('rate-limited', 429, '요청이 많아요. 잠시 뒤에 다시 보내 주세요');
      const leaveDays = req.leave ? checkedLeaveDays(req.leave.days, kstDate(ctx.now())) : null;
      if (leaveDays && !req.rowId) throw new DeskError('bad-request', 400, '휴가 요청은 분장표의 휴가 신청 업무로만 보내요');
      const leaveType = req.leave ? checkedLeaveType(req.leave.type, req.leave.officialReason) : null;
      if (leaveDays) {
        const mine = await ctx.adapters.leave.leaveOf({ idpSubject: user.idpSubject, ...(user.email ? { email: user.email } : {}) }).catch(() => null);
        const clash = overlapping(mine, leaveDays);
        if (clash.length) throw new DeskError('conflict', 409, `이미 근태 기록에 있는 날이에요: ${clash.join(' · ')}`);
      }
      const question = leaveDays
        ? leaveType?.reasonCode
          ? `공가 신청 · ${OFFICIAL_LEAVE_REASON_LABEL[leaveType.reasonCode]} · ${leaveSummary(leaveDays)}`
          : `휴가 신청 · ${leaveSummary(leaveDays)}`
        : checked(req.question, INQUIRY_QUESTION_MAX, '문의 내용');
      const reason = checked(req.reason, INQUIRY_REASON_MAX, '사유');

      let target: { rowId: string | null; task: string; team: string; department: string };
      if (req.rowId) {
        const [row] = await repo.findRows(ctx.db, [req.rowId]);
        if (!row) throw new DeskError('not-found', 404, '분장표에서 그 업무를 찾지 못했어요');
        target = { rowId: row.id, task: row.task, team: row.team, department: row.ownerDepartment };
      } else {
        target = { rowId: null, task: GENERAL_TASK, team: GENERAL_DESK.team, department: GENERAL_DESK.team };
      }

      return ctx.fixed.run(user, {
        module: 'navi',
        action: leaveDays ? 'leave.request' : 'inquiry.send',
        idempotencyKey: req.requestId,
        enabled: (s) => s.modules.navi !== 'off',
        run: async (q, now) => {
          const saved = await repo.insertInquiry(q, {
            ...target,
            senderPseudonym: user.pseudonymId,
            senderName: user.displayName,
            senderDepartment: user.department,
            question: question.slice(0, INQUIRY_QUESTION_MAX),
            reason,
            kind: leaveDays ? 'leave' : 'general',
            leaveDays,
            leaveType: leaveType?.type ?? null,
            leaveReasonCode: leaveType?.reasonCode ?? null,
            senderSubject: leaveDays ? user.idpSubject : null,
            at: now,
          });
          // 문의하기가 고른 행과 다른 곳으로 보냈으면 그 행에 "바꿔 보냄" 기록을 남겨요(ADR-26). 글·보낸 사람은 넣지 않아요.
          if (!leaveDays && req.suggestedRowId && req.suggestedRowId !== target.rowId) {
            const [suggested] = await repo.findRows(q, [req.suggestedRowId]);
            if (suggested) {
              await repo.insertFeedback(q, {
                predictedKind: 'navi',
                correctedKind: null,
                predictedRow: suggested.id,
                chosenRow: target.rowId,
                reason: target.rowId ? 'other-owner' : 'not-listed',
                at: feedbackDay(now),
              });
            }
          }
          const what = saved.kind === 'leave' ? `${requestWord(saved)}이` : '새 문의가';
          await ctx.notify.toDepartment(
            q,
            target.department,
            { module: 'navi', title: `${target.team}에 ${what} 왔어요 · ${target.task}`, page: 'navi' },
            user.pseudonymId,
          );
          return { status: 'done' as const, card: sentCard(saved) };
        },
      });
    },

    /** 받은 문의함: 내 부서로 온 문의. 분장표에 행이 있는 부서만 열려요. 휴가 요청은 결정 전이면 보낸 사람 남은 연차가 같이 와요. */
    async inbox(user: DeskUser): Promise<InquiryListResponse> {
      const owners = ctx.services.navi ? await ctx.services.navi.ownerDepartments() : new Set<string>();
      if (!owners.has(user.department) && user.department !== GENERAL_DESK.team) return { enabled: false, items: [] };
      return { enabled: true, items: await withReplies(await repo.inquiriesOfDepartment(ctx.db, user.department, since()), 'inbox') };
    },

    /** 내 문의: 내가 보낸 문의와 처리 상태·답장·반려 사유 */
    async mine(user: DeskUser): Promise<InquiryListResponse> {
      return { enabled: true, items: await withReplies(await repo.inquiriesOfSender(ctx.db, user.pseudonymId, since()), 'mine') };
    },

    /** [확인했어요]·[처리했어요]: 받은 부서 사람만. 바뀌면 보낸 사람에게 알림이 가요. 휴가 요청은 [확인했어요]만이에요. */
    async setState(user: DeskUser, id: string, to: 'seen' | 'done'): Promise<InquiryItem> {
      return ctx.fixed.run(user, {
        module: 'navi',
        action: `inquiry.${to}`,
        enabled: (s) => s.modules.navi !== 'off',
        run: async (q, now) => {
          const moved = await repo.moveInquiryState(q, id, user.department, to, now, recordCutoff(now));
          if (!moved) throw new DeskError('not-found', 404, '바꿀 수 있는 문의가 없어요. 새로 불러와 주세요');
          const verb = to === 'seen' ? '확인했어요' : '처리했어요';
          await ctx.notify.toUser(q, moved.senderPseudonym, {
            module: 'navi',
            title: `${subject(moved.team)} ${moved.kind === 'leave' ? `${requestWord(moved)}을` : '문의를'} ${verb} · ${moved.task}`,
            page: 'navi',
          });
          return toItem(moved, 'inbox', []);
        },
      });
    },

    /**
     * 휴가 요청 승인·반려(ADR-24): 받은 부서 사람이 화면에서 누른 고정 버튼이에요(AI는 결정하지 않아요).
     * 반려는 사유가 꼭 있어야 해요. 승인하면 근태 기록에 쓴 날로 넣어 남은 연차에서 바로 빠져요. 근태가 연결 안 됐으면 승인만 하고 알려요.
     */
    async decide(user: DeskUser, id: string, d: InquiryDecisionRequest): Promise<InquiryItem> {
      const reason = d.decision === 'rejected' ? checked(d.reason ?? '', LEAVE_REJECT_REASON_MAX, '반려 사유') : null;
      return ctx.fixed.run(user, {
        module: 'navi',
        action: d.decision === 'approved' ? 'leave.approve' : 'leave.reject',
        enabled: (s) => s.modules.navi !== 'off',
        run: async (q, now) => {
          const i = await repo.lockOpenLeaveRequest(q, id, user.department, recordCutoff(now));
          if (!i || !i.leaveDays || !i.senderSubject) throw new DeskError('not-found', 404, '결정할 수 있는 휴가 요청이 없어요. 새로 불러와 주세요');
          let recorded: boolean | null = null;
          if (d.decision === 'approved') {
            const person = await personOf(i.senderSubject);
            const record = await ctx.adapters.leave.leaveOf(person).catch(() => null);
            const clash = overlapping(record, i.leaveDays);
            if (clash.length)
              throw new DeskError('conflict', 409, `이미 근태 기록에 있는 날이 있어요: ${clash.join(' · ')}. 반려하고 다시 신청해 달라고 해 주세요`);
            const type = i.leaveType ?? 'annual';
            recorded =
              (await ctx.adapters.leave.recordUses(
                person,
                i.leaveDays.map((day) => ({ ...day, type })),
              )) === 'recorded';
          }
          const done = await repo.decideLeaveRequest(q, id, { state: d.decision, reason, recorded, at: now });
          await ctx.notify.toUser(q, done.senderPseudonym, {
            module: 'navi',
            title: `${subject(done.team)} ${requestWord(done)}을 ${d.decision === 'approved' ? '승인했어요' : '반려했어요'} · ${done.task}`,
            page: 'navi',
          });
          return toItem(done, 'inbox', []);
        },
      });
    },

    /** 받은 부서 사람의 답장. 같은 requestId는 한 번만 들어가요. 알림에는 글을 넣지 않아요. */
    async reply(user: DeskUser, id: string, req: InquiryReplyRequest): Promise<{ status: 'done' }> {
      const text = checked(req.text, INQUIRY_REPLY_MAX, '답장');
      return ctx.fixed.run(user, {
        module: 'navi',
        action: 'inquiry.reply',
        enabled: (s) => s.modules.navi !== 'off',
        run: async (q, now) => {
          const i = await repo.inquiryOfDepartment(q, id, user.department, recordCutoff(now));
          if (!i) throw new DeskError('not-found', 404, '답장할 수 있는 문의가 없어요. 새로 불러와 주세요');
          const added = await repo.insertReply(q, {
            inquiryId: id,
            authorPseudonym: user.pseudonymId,
            authorName: user.displayName,
            body: text,
            requestId: req.requestId,
            at: now,
          });
          if (added) {
            await ctx.notify.toUser(q, i.senderPseudonym, {
              module: 'navi',
              title: `${subject(i.team)} ${requestWord(i)}에 답장했어요 · ${i.task}`,
              page: 'navi',
            });
          }
          return { status: 'done' as const };
        },
      });
    },
  };
}

export type InquiryService = ReturnType<typeof createInquiryService>;
