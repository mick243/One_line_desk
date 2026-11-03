import type { NaviMcpRead, NaviTeamRow } from '../../core/services';
import { z } from 'zod';
import { TOOLS, type ToolDef } from '../../core/tool-registry';
import { cleanText } from './tools';

// 2단계 읽기 도구 넷의 입력·출력(11/3, ADR-14 개정): 받을 팀 찾기·IT 오류 FAQ·첫 2주 할 일·내 요청 상태.
// 나가는 값은 정해진 칸만 하나씩 골라 담아요. 행 ID·주인 부서·사람 이름·문의 글·휴가 날짜 칸은 스키마에 없어요.

const MAX_TEAMS = 3;
const MAX_STEPS = 20;
const MAX_ONBOARDING = 30;
const MAX_REQUESTS = 30;
const MAX_RESERVATIONS = 20;

const def = (name: string): ToolDef => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`도구 레지스트리에 없어요: ${name}`);
  return tool;
};
const TEAM_DEF = def('navi_find_team');
const FAQ_DEF = def('navi_it_faq');

const text = (tool: ToolDef, key: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(tool.input[key]?.maxLength ?? 300)
    .describe(tool.input[key]?.description ?? key);

export const TEAM_INPUT = z.object({ query: text(TEAM_DEF, 'query') }).strict();
export type TeamInput = z.infer<typeof TEAM_INPUT>;
export const FAQ_INPUT = z.object({ text: text(FAQ_DEF, 'text') }).strict();
export type FaqInput = z.infer<typeof FAQ_INPUT>;
export const EMPTY_INPUT = z.object({}).strict();

const EMPTY_REASON = z.object({ code: z.string(), message: z.string() }).strict().describe('결과가 없을 때만: 왜 없는지(message를 그대로 전해요)');
const LINK = { link: z.string().describe('앱 확인 링크. 본인만 열 수 있고 짧은 시간만 유효해요'), linkText: z.string() };

/** 분장표 한 줄의 공개 칸. 행 ID·주인 부서·사람 이름은 없어요. */
const TEAM_FIELDS = {
  task: z.string().describe('업무'),
  team: z.string().describe('담당 팀(사람 이름 없음)'),
  desk: z.string().describe('팀 창구(팀 메일·채널 같은 창구 글)'),
  nextStep: z.string().describe('지금 할 일'),
  processingPeriod: z.string().optional().describe('처리 기간'),
  revisedOn: z.string().describe('분장표 개정일 YYYY-MM-DD'),
};

export const TEAM_OUTPUT = z
  .object({
    mock: z.boolean().describe('가상 분장표(시연 데이터)인지'),
    candidates: z
      .array(
        z.object({ ...TEAM_FIELDS, match: z.enum(['strong', 'weak']).describe('strong: 분장표 근거가 뚜렷해요 · weak: 비슷한 후보예요'), ...LINK }).strict(),
      )
      .max(MAX_TEAMS),
    general: z
      .object({ team: z.string(), desk: z.string(), ...LINK })
      .strict()
      .optional()
      .describe('맞는 업무가 없을 때: 분장표에 없는 일을 받는 대표 창구'),
    emptyReason: EMPTY_REASON.optional(),
    confirm: z.string().describe('사람에게 같이 전할 안내'),
  })
  .strict();

export const FAQ_OUTPUT = z
  .object({
    mock: z.boolean().describe('가상 FAQ(시연 데이터)인지'),
    faq: z
      .object({ title: z.string(), steps: z.array(z.string()).max(MAX_STEPS).describe('FAQ 원문 단계(고치지 않고 그대로)'), revisedOn: z.string() })
      .strict()
      .optional(),
    others: z.array(z.string()).max(3).describe('비슷한 다른 FAQ 제목'),
    inquiry: z
      .object({ team: z.string(), task: z.string(), ...LINK })
      .strict()
      .describe('안 풀리면: IT 담당 팀 문의 양식 앱 링크(글은 사람이 앱에서 써요)'),
    emptyReason: EMPTY_REASON.optional(),
  })
  .strict();

export const ONBOARDING_OUTPUT = z
  .object({
    mock: z.boolean().describe('가상 분장표(시연 데이터)인지'),
    weeks: z.array(
      z
        .object({
          week: z.number().int().min(1).max(2).describe('첫 몇 주 차'),
          items: z.array(z.object(TEAM_FIELDS).strict()).max(MAX_ONBOARDING),
        })
        .strict(),
    ),
    appLink: z.string().describe('앱의 첫 2주 할 일 화면'),
    emptyReason: EMPTY_REASON.optional(),
  })
  .strict();

export const MINE_OUTPUT = z
  .object({
    mock: z.boolean().describe('시연 데이터인지'),
    requests: z
      .array(
        z
          .object({
            kind: z.enum(['문의', '휴가 요청', '공가 요청']),
            task: z.string().describe('업무 이름'),
            team: z.string().describe('받은 팀'),
            state: z.string().describe('처리 상태'),
            sentOn: z.string().describe('보낸 날 YYYY-MM-DD'),
            hasReply: z.boolean().describe('답장이 왔는지(글은 앱에서 봐요)'),
          })
          .strict(),
      )
      .max(MAX_REQUESTS)
      .describe('최근 7일 안에 보낸 것(그보다 오래된 것은 지워져요)'),
    reservations: z
      .array(z.object({ roomName: z.string(), floor: z.string(), when: z.string().describe('예: 10월 27일(화) 15:00~16:00') }).strict())
      .max(MAX_RESERVATIONS)
      .describe('다가오는 내 회의실 예약'),
    appLink: z.string().describe('내용 보기·취소·답장은 앱에서'),
  })
  .strict();

const CONFIRM_LINE = '확정은 앱에서 한 번 · 링크는 본인만 · 짧은 시간만 유효해요';

type Linked = { link: string; linkText: string };
const INQUIRY_TEXT = (team: string) => `한 줄 데스크에서 ${cleanText(team, 30)}에 문의하기`;

const publicRow = (r: Pick<NaviTeamRow, 'task' | 'team' | 'desk' | 'nextStep' | 'processingPeriod' | 'revisedOn'>) => {
  const period = cleanText(r.processingPeriod, 60);
  return {
    task: cleanText(r.task, 80),
    team: cleanText(r.team, 40),
    desk: cleanText(r.desk, 160),
    nextStep: cleanText(r.nextStep, 300),
    ...(period ? { processingPeriod: period } : {}),
    revisedOn: /^\d{4}-\d{2}-\d{2}$/.test(r.revisedOn) ? r.revisedOn : '',
  };
};

export function shapeTeams(found: Awaited<ReturnType<NaviMcpRead['findTeam']>>, linkFor: (rowId: string | null) => string): z.infer<typeof TEAM_OUTPUT> {
  const candidates = found.rows.slice(0, MAX_TEAMS).map((r) => ({
    ...publicRow(r),
    match: r.strong ? ('strong' as const) : ('weak' as const),
    link: linkFor(r.rowId),
    linkText: INQUIRY_TEXT(r.team),
  }));
  if (candidates.length) return { mock: found.mock, candidates, confirm: `${CONFIRM_LINE}. 문의 내용은 사람이 앱 양식에 직접 써요` };
  const general: Linked & { team: string; desk: string } = {
    team: cleanText(found.general.team, 40),
    desk: cleanText(found.general.desk, 160),
    link: linkFor(null),
    linkText: INQUIRY_TEXT(found.general.team),
  };
  return {
    mock: found.mock,
    candidates: [],
    general,
    emptyReason: { code: 'no-match', message: '업무 분장표에서 맞는 업무를 찾지 못했어요. 대표 창구에 문의하거나 다른 낱말로 다시 찾아 주세요' },
    confirm: CONFIRM_LINE,
  };
}

export function shapeFaq(found: Awaited<ReturnType<NaviMcpRead['itFaq']>>, inquiryLink: string): z.infer<typeof FAQ_OUTPUT> {
  const faq = found.faq
    ? {
        title: cleanText(found.faq.title, 120),
        steps: found.faq.steps
          .slice(0, MAX_STEPS)
          .map((s) => cleanText(s, 400))
          .filter(Boolean),
        revisedOn: /^\d{4}-\d{2}-\d{2}$/.test(found.faq.revisedOn) ? found.faq.revisedOn : '',
      }
    : undefined;
  return {
    mock: found.mock,
    ...(faq ? { faq } : {}),
    others: found.others
      .slice(0, 3)
      .map((o) => cleanText(o, 120))
      .filter(Boolean),
    inquiry: {
      team: cleanText(found.inquiry.team, 40),
      task: cleanText(found.inquiry.task, 80),
      link: inquiryLink,
      linkText: INQUIRY_TEXT(found.inquiry.team),
    },
    ...(faq ? {} : { emptyReason: { code: 'no-match', message: '맞는 IT FAQ를 찾지 못했어요. 다른 후보 제목을 보거나 IT 담당 팀에 문의해 주세요' } }),
  };
}

export function shapeOnboarding(found: Awaited<ReturnType<NaviMcpRead['onboarding']>>, appLink: string): z.infer<typeof ONBOARDING_OUTPUT> {
  const weeks = found.weeks.map((w) => ({ week: w.week, items: w.items.slice(0, MAX_ONBOARDING).map(publicRow) })).filter((w) => w.items.length > 0);
  return {
    mock: found.mock,
    weeks,
    appLink,
    ...(weeks.length ? {} : { emptyReason: { code: 'none', message: '회사가 아직 첫 2주 할 일을 정하지 않았어요' } }),
  };
}

const KIND_LABEL = { inquiry: '문의', leave: '휴가 요청', 'official-leave': '공가 요청' } as const;

export function shapeMine(
  input: { mock: boolean; requests: Awaited<ReturnType<NaviMcpRead['myRequests']>>; reservations: { roomName: string; floor: string; when: string }[] },
  appLink: string,
): z.infer<typeof MINE_OUTPUT> {
  return {
    mock: input.mock,
    requests: input.requests.slice(0, MAX_REQUESTS).map((r) => ({
      kind: KIND_LABEL[r.kind],
      task: cleanText(r.task, 80),
      team: cleanText(r.team, 40),
      state: cleanText(r.state, 20),
      sentOn: /^\d{4}-\d{2}-\d{2}$/.test(r.sentOn) ? r.sentOn : '',
      hasReply: r.hasReply === true,
    })),
    reservations: input.reservations
      .slice(0, MAX_RESERVATIONS)
      .map((r) => ({ roomName: cleanText(r.roomName, 40), floor: cleanText(r.floor, 10), when: cleanText(r.when, 60) })),
    appLink,
  };
}
