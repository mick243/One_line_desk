import {
  addDays,
  checkInput,
  dayLabel,
  INQUIRY_STATE_LABEL,
  isWeekend,
  kstDate,
  LEAVE_REQUEST_MAX_DAYS,
  type LeaveKind,
  LEAVE_TYPES,
  type LeaveDay,
  mergeLeaveHalves,
  offDayName,
  NAVI_ROW_ID_PATTERN,
  recordCutoff,
  SICK_LEAVE_PAST_DAYS,
} from '@one-line-desk/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import type { PlanHandler } from '../../core/module';
import type { LeaveLink, NaviMcpRead, NaviTeamRow } from '../../core/services';
import { GENERAL_TASK } from './cards';
import { GENERAL_DESK } from './fixtures';
import type { ItHelpService } from './it-help';
import { findLeaveRequestRow, leaveCheckForLink, leaveLinkAction } from './leave';
import * as repo from './repo';
import { type NaviService, rankRows, topTied } from './service';

// MCP 읽기 도구가 쓰는 navi 읽기 함수(11/3, MCP 통합 회의 2단계 · ADR-14 개정).
// MCP 모듈은 ctx.services.navi.mcp로만 불러요(모듈 경계). 여기서는 LLM을 부르지 않고 분장표 규칙 순위·IT FAQ 규칙만 써요.
// - 질문 글·오류 글은 이 함수 안 메모리에서만 쓰고 저장·로그·감사에 넣지 않아요(ADR-10, R13).
// - 행 ID는 앱 확인 링크(봉인 제안 토큰) 안에만 들어가요. MCP 출력 모양(modules/mcp/tools-navi.ts)이 빼요.
// - 문의 링크 토큰은 'navi:inquire' 처리기로 봉인해요. 이 처리기는 실행하지 않아요: 링크는 문의 양식을 열 뿐이고,
//   보내기는 양식의 확인 시트 [보내기](고정 버튼)예요. plan을 만들거나 바로 실행하려 하면 막혀요.

const MAX_TEAMS = 3;

const InquireLinkSchema = z.object({ rowId: z.string().regex(new RegExp(NAVI_ROW_ID_PATTERN)).nullable() }).strict();
type InquireLink = z.infer<typeof InquireLinkSchema>;

const LINK_ONLY = () => new DeskError('bad-request', 400, '이 링크는 문의 양식을 여는 링크예요. 양식에서 [보내기]를 눌러 주세요');

/** 문의 양식 앱 링크 토큰 처리기. 열어 보기(peek)만 되고, plan 만들기·바로 실행·자동 실행은 모두 막혀요. */
export const inquireLinkHandler: PlanHandler<InquireLink> = {
  module: 'navi',
  action: 'inquire',
  schema: InquireLinkSchema,
  enabled: () => false,
  async sheet() {
    throw LINK_ONLY();
  },
  async execute() {
    throw LINK_ONLY();
  },
};

// 휴가 준비 링크(11/3 확인 링크 넓히기). 토큰에는 날짜·하루/오전 반차/오후 반차·종류만 넣어요. 사유·남은 연차는 없어요.
// 이 처리기도 실행하지 않아요: 링크는 휴가 신청 양식을 채워 열 뿐이고, 보내기는 양식의 확인 시트 [보내기]예요.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LeaveLinkSchema = z
  .object({
    days: z
      .array(z.object({ date: z.string().regex(DATE), kind: z.enum(['full', 'half']), half: z.enum(['am', 'pm']).optional() }).strict())
      .min(1)
      .max(LEAVE_REQUEST_MAX_DAYS),
    type: z.enum(LEAVE_TYPES),
  })
  .strict();

const LEAVE_LINK_ONLY = () => new DeskError('bad-request', 400, '이 링크는 휴가 신청 양식을 여는 링크예요. 양식에서 [보내기]를 눌러 주세요');

/** 휴가 준비 앱 링크 토큰 처리기. 열어 보기(peek)만 되고, plan 만들기·바로 실행·자동 실행은 모두 막혀요. */
export const leaveLinkHandler: PlanHandler<LeaveLink> = {
  module: 'navi',
  action: 'leave-link',
  schema: LeaveLinkSchema,
  enabled: () => false,
  async sheet() {
    throw LEAVE_LINK_ONLY();
  },
  async execute() {
    throw LEAVE_LINK_ONLY();
  },
};

const isRealDate = (d: string) => DATE.test(d) && addDays(d, 0) === d;

/**
 * 휴가 준비 링크의 날 검사(앱 신청 검사와 같은 규칙): 오늘부터 1년 안의 일하는 날, 겹치지 않게. 병가는 지난 3일까지 받아요.
 * 11/6 휴가 정확도: 주말과 함께 법정 공휴일·회사 휴일(운영 설정 companyHolidays)도 받지 않아요(쉬는 날은 연차로 세지 않아요).
 * 연차 자료(등급 2)는 읽지 않아요. 남은 연차가 모자라는지는 앱 양식이 본인 화면에서 보여 줘요.
 * 11/6: 신청 전 카드 [이 날로 보기](경조 포함 LeaveKind)도 같은 검사를 써요.
 */
export function checkLeaveLink(
  link: { days: readonly LeaveDay[]; type: LeaveKind },
  today: string,
  companyHolidays: readonly string[] = [],
): { ok: true; days: LeaveDay[] } | { ok: false; code: string; message: string } {
  if (!link.days.length) return { ok: false, code: 'no-days', message: '쓸 날을 하나 이상 골라 주세요' };
  if (link.days.length > LEAVE_REQUEST_MAX_DAYS) return { ok: false, code: 'too-many', message: `한 번에 ${LEAVE_REQUEST_MAX_DAYS}일까지 신청할 수 있어요` };
  // 11/3: 반차는 오전·오후 중 하나가 꼭 있어야 해요. AI가 짐작하지 않게 사람에게 물어보라고 돌려줘요.
  if (link.days.some((d) => d.kind === 'half' && d.half !== 'am' && d.half !== 'pm'))
    return { ok: false, code: 'half-part', message: '반차는 오전·오후 중 하나여야 해요. 어느 쪽인지 사람에게 물어 주세요' };
  // 같은 날 오전 반차와 오후 반차를 같이 고르면 하루로 합쳐요(앱 신청 검사와 같아요).
  const days = mergeLeaveHalves(link.days);
  const earliest = link.type === 'sick' ? addDays(today, -SICK_LEAVE_PAST_DAYS) : today;
  const last = addDays(today, 365);
  const seen = new Set<string>();
  for (const d of days) {
    if (!isRealDate(d.date)) return { ok: false, code: 'bad-date', message: '날짜는 YYYY-MM-DD로 적어 주세요' };
    if (d.date < earliest) {
      const more = link.type === 'sick' ? `. 병가는 ${SICK_LEAVE_PAST_DAYS}일 전까지만 신청할 수 있어요` : '';
      return { ok: false, code: 'past', message: `${dayLabel(d.date)}은 지난 날이에요${more}` };
    }
    if (d.date > last) return { ok: false, code: 'too-far', message: '1년 안의 날만 신청할 수 있어요' };
    if (isWeekend(d.date)) return { ok: false, code: 'weekend', message: `${dayLabel(d.date)}은 주말이에요` };
    const off = offDayName(d.date, companyHolidays);
    if (off) return { ok: false, code: 'holiday', message: `${dayLabel(d.date)}은 쉬는 날이에요(${off})` };
    if (seen.has(d.date)) return { ok: false, code: 'duplicate', message: `${dayLabel(d.date)}을 두 번 골랐어요` };
    seen.add(d.date);
  }
  return { ok: true, days: days.sort((a, b) => a.date.localeCompare(b.date)) };
}

const GENERAL_ROW = (revisedOn: string): NaviTeamRow => ({
  rowId: null,
  task: GENERAL_TASK,
  team: GENERAL_DESK.team,
  desk: GENERAL_DESK.desk,
  nextStep: '분장표에 없는 일은 대표 창구가 받아서 맞는 팀에 넘겨요',
  processingPeriod: null,
  revisedOn,
});

const teamRow = (r: repo.StoredRow): NaviTeamRow => ({
  rowId: r.id,
  task: r.task,
  team: r.team,
  desk: r.desk,
  nextStep: r.nextStep,
  processingPeriod: r.processingPeriod,
  revisedOn: r.revisedOn,
});

export function createNaviMcpRead(
  ctx: AppContext,
  navi: Pick<NaviService, 'onboarding' | 'hasRealChart'>,
  itHelp: Pick<ItHelpService, 'match' | 'hasRealFaqs'>,
): NaviMcpRead {
  return {
    async findTeam(text) {
      const mock = !navi.hasRealChart();
      const general = GENERAL_ROW(kstDate(ctx.now()));
      const checked = checkInput(text.trim());
      if (checked.locks.length) return { mock, locked: checked.locks[0]!.message, rows: [], general };
      const ranked = rankRows(checked.text, await repo.allRows(ctx.db)).slice(0, MAX_TEAMS);
      const tied = topTied(ranked);
      return { mock, rows: ranked.map((s) => ({ ...teamRow(s.row), strong: tied.length === 1 && tied[0] === s })), general };
    },

    async itFaq(text) {
      const mock = !itHelp.hasRealFaqs() && !navi.hasRealChart();
      try {
        const found = await itHelp.match(text);
        return {
          mock,
          ...(found.faq ? { faq: { title: found.faq.title, steps: found.faq.steps, revisedOn: found.faq.revisedOn } } : {}),
          others: found.others.map((o) => o.title),
          inquiry: { rowId: found.inquiryRowId, team: found.inquiryTeam, task: found.inquiryTask },
        };
      } catch (e) {
        if (e instanceof DeskError && e.code === 'locked') return { mock, locked: e.message, others: [], inquiry: { rowId: null, team: '', task: '' } };
        throw e;
      }
    },

    async onboarding() {
      const res = await navi.onboarding();
      return {
        mock: !navi.hasRealChart(),
        weeks: res.weeks.map((w) => ({
          week: w.week,
          items: w.items.map((i) => ({
            rowId: i.rowId,
            task: i.task,
            team: i.team,
            desk: i.desk,
            nextStep: i.nextStep,
            processingPeriod: i.processingPeriod ?? null,
            revisedOn: i.revisedOn,
          })),
        })),
      };
    },

    async myRequests(pseudonymId) {
      const cutoff = recordCutoff(ctx.now());
      const rows = await repo.inquiriesOfSender(ctx.db, pseudonymId, cutoff);
      const replied = new Set(
        (
          await repo.repliesOf(
            ctx.db,
            rows.map((r) => r.id),
          )
        ).map((r) => r.inquiryId),
      );
      // 글(question·reason·답장·반려 사유)·답한 사람·휴가 날짜는 여기서 버려요.
      return rows.map((r) => ({
        kind: r.kind !== 'leave' ? ('inquiry' as const) : r.leaveType === 'official' ? ('official-leave' as const) : ('leave' as const),
        task: r.task,
        team: r.team,
        state: INQUIRY_STATE_LABEL[r.state],
        sentOn: kstDate(r.created),
        hasReply: replied.has(r.id),
      }));
    },

    proposeInquiry(user, rowId) {
      return ctx.plans.propose(user, 'navi', 'inquire', { rowId });
    },

    async inquiryTarget(rowId) {
      if (rowId === null) return { rowId: null, team: GENERAL_DESK.team, task: GENERAL_TASK };
      const [row] = await repo.findRows(ctx.db, [rowId]);
      return row ? { rowId: row.id, team: row.team, task: row.task } : null;
    },

    prepareLeave(user, link) {
      const checked = checkLeaveLink(link, kstDate(ctx.now()), ctx.ops.get().companyHolidays);
      if (!checked.ok) return checked;
      return { ok: true, days: checked.days, token: ctx.plans.propose(user, 'navi', 'leave-link', { days: checked.days, type: link.type }) };
    },

    async leaveTarget(user, link) {
      const target = findLeaveRequestRow(await repo.allRows(ctx.db));
      if (!target) return null;
      return leaveLinkAction(ctx, user, target, link.days, link.type);
    },

    // 11/6 A안: 앱 안 휴가 결재가 꺼져 있으면 링크는 신청 전 카드를 열어요. 신청은 카드의 [그룹웨어에서 신청하기]예요.
    leaveCheck(user, link) {
      return leaveCheckForLink(ctx, user, link.days, link.type);
    },
  };
}
