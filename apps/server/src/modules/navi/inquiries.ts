import {
  type Card,
  type CardAction,
  checkInput,
  INQUIRY_KEEP_DAYS,
  INQUIRY_QUESTION_MAX,
  INQUIRY_REASON_MAX,
  INQUIRY_STATE_LABEL,
  type InquiryItem,
  type InquiryListResponse,
  type InquiryRequest,
} from '@one-line-desk/shared';
import type { AppContext } from '../../context';
import { makeCard } from '../../core/cards';
import { DeskError } from '../../core/errors';
import type { DeskUser } from '../../core/user';
import { GENERAL_TASK } from './cards';
import { GENERAL_DESK } from './fixtures';
import * as repo from './repo';

// 담당 팀에 문의 보내기(10/26, ADR-16).
// - 받는 곳은 분장표 행의 주인 부서예요. 담당자 이름은 분장표에 없어요(D9).
// - 사람이 확인 시트에서 [보내기]를 누른 글만 저장해요(고정 버튼 + 멱등 키). 묻기 문장과 달리 받는 팀이 읽어야 하는 글이에요.
// - 보낸 사람의 이름·부서는 받는 팀이 답하려고 봐요. 확인 시트에서 미리 알려요.
// - 알림에는 글을 넣지 않고 "새 문의가 왔어요 · 업무 이름"만 넣어요. 글은 받은 문의함에서 부서를 확인한 뒤 보여 줘요.
// - LLM은 부르지 않아요.

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const kstIso = (at: number) => `${new Date(at + KST_MS).toISOString().slice(0, 19)}+09:00`;

/** "인사팀" → "인사팀이", "IT지원" → "IT지원이"처럼 받침에 맞는 조사 */
function subject(word: string): string {
  const last = word.charCodeAt(word.length - 1);
  const hasBatchim = last >= 0xac00 && last <= 0xd7a3 ? (last - 0xac00) % 28 !== 0 : false;
  return `${word}${hasBatchim ? '이' : '가'}`;
}

const SENT_TAIL = `보낸 글은 ${INQUIRY_KEEP_DAYS}일 동안 보관돼요`;

function sentCard(i: repo.InquiryRow): Card {
  return makeCard({
    id: `navi-inquiry-${i.id}`,
    kind: 'navi',
    label: '확정',
    headline: `${i.team}에 보냈어요`,
    fields: [
      { name: '업무', value: i.task },
      { name: '받는 곳', value: i.team },
      { name: '상태', value: INQUIRY_STATE_LABEL[i.state] },
    ],
    evidence: { text: '답이 오면 알림으로 알려 드려요. 담당 찾기 "내 문의"에서도 볼 수 있어요', aiSummarized: false },
    tail: SENT_TAIL,
  });
}

function stateAction(i: repo.InquiryRow, to: 'seen' | 'done'): CardAction {
  return { type: 'fixed', text: INQUIRY_STATE_LABEL[to], method: 'POST', path: `/api/navi/inquiries/${i.id}/state`, body: { state: to } };
}

function toItem(i: repo.InquiryRow, view: 'inbox' | 'mine'): InquiryItem {
  const actions =
    view === 'inbox' ? (i.state === 'new' ? [stateAction(i, 'seen'), stateAction(i, 'done')] : i.state === 'seen' ? [stateAction(i, 'done')] : []) : [];
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
    actions,
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

export function createInquiryService(ctx: AppContext) {
  const purge = () => repo.purgeInquiries(ctx.db, ctx.now() - INQUIRY_KEEP_DAYS * DAY_MS);

  return {
    /** 90일 지난 문의를 지워요. 서버가 한 시간마다, 목록을 열 때도 불러요(L-33). */
    purge,

    /** 문의 보내기. 화면은 확인 시트를 먼저 띄우고, 같은 requestId로 두 번 와도 한 번만 들어가요. */
    async send(user: DeskUser, req: InquiryRequest): Promise<{ status: 'done'; card: Card }> {
      if (ctx.ops.get().modules.navi === 'off') throw new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
      if (!ctx.rateLimiter.hit(user.pseudonymId, 'inquiry')) throw new DeskError('rate-limited', 429, '요청이 많아요. 잠시 뒤에 다시 보내 주세요');
      const question = checked(req.question, INQUIRY_QUESTION_MAX, '문의 내용');
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
        action: 'inquiry.send',
        idempotencyKey: req.requestId,
        enabled: (s) => s.modules.navi !== 'off',
        run: async (q, now) => {
          const saved = await repo.insertInquiry(q, {
            ...target,
            senderPseudonym: user.pseudonymId,
            senderName: user.displayName,
            senderDepartment: user.department,
            question,
            reason,
            at: now,
          });
          await ctx.notify.toDepartment(
            q,
            target.department,
            { module: 'navi', title: `${target.team}에 새 문의가 왔어요 · ${target.task}`, page: 'navi' },
            user.pseudonymId,
          );
          return { status: 'done' as const, card: sentCard(saved) };
        },
      });
    },

    /** 받은 문의함: 내 부서로 온 문의. 분장표에 행이 있는 부서만 열려요. */
    async inbox(user: DeskUser): Promise<InquiryListResponse> {
      const owners = ctx.services.navi ? await ctx.services.navi.ownerDepartments() : new Set<string>();
      if (!owners.has(user.department) && user.department !== GENERAL_DESK.team) return { enabled: false, items: [] };
      await purge();
      return { enabled: true, items: (await repo.inquiriesOfDepartment(ctx.db, user.department)).map((i) => toItem(i, 'inbox')) };
    },

    /** 내 문의: 내가 보낸 문의와 처리 상태 */
    async mine(user: DeskUser): Promise<InquiryListResponse> {
      await purge();
      return { enabled: true, items: (await repo.inquiriesOfSender(ctx.db, user.pseudonymId)).map((i) => toItem(i, 'mine')) };
    },

    /** [확인했어요]·[처리했어요]: 받은 부서 사람만. 바뀌면 보낸 사람에게 알림이 가요. */
    async setState(user: DeskUser, id: string, to: 'seen' | 'done'): Promise<InquiryItem> {
      return ctx.fixed.run(user, {
        module: 'navi',
        action: `inquiry.${to}`,
        enabled: (s) => s.modules.navi !== 'off',
        run: async (q, now) => {
          const moved = await repo.moveInquiryState(q, id, user.department, to, now);
          if (!moved) throw new DeskError('not-found', 404, '바꿀 수 있는 문의가 없어요. 새로 불러와 주세요');
          const verb = to === 'seen' ? '확인했어요' : '처리했어요';
          await ctx.notify.toUser(q, moved.senderPseudonym, { module: 'navi', title: `${subject(moved.team)} 문의를 ${verb} · ${moved.task}`, page: 'navi' });
          return toItem(moved, 'inbox');
        },
      });
    },
  };
}

export type InquiryService = ReturnType<typeof createInquiryService>;
