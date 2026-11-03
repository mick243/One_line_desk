import { checkInput, INQUIRY_STATE_LABEL, kstDate, NAVI_ROW_ID_PATTERN, recordCutoff } from '@one-line-desk/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import type { PlanHandler } from '../../core/module';
import type { NaviMcpRead, NaviTeamRow } from '../../core/services';
import { GENERAL_TASK } from './cards';
import { GENERAL_DESK } from './fixtures';
import type { ItHelpService } from './it-help';
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
      const rows = (await repo.inquiriesOfSender(ctx.db, pseudonymId)).filter((r) => r.created >= cutoff);
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
  };
}
