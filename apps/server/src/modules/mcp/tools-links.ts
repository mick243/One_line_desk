import {
  dayLabel,
  LEAVE_REQUEST_MAX_DAYS,
  LEAVE_TYPE_LABEL,
  LEAVE_TYPES,
  type LeaveDay,
  leaveDayChoice,
  type LeaveDayChoice,
  leaveDayOf,
  leaveDayWord,
  type LeaveType,
  LOAN_KINDS,
} from '@one-line-desk/shared';
import { z } from 'zod';
import { TOOLS, type ToolDef } from '../../core/tool-registry';
import { cleanText } from './tools';

// 확인 링크 도구 셋의 입력·출력(11/3 확인 링크 넓히기 · ADR-14 개정): 휴가 신청 준비·탕비실 요청 찾기·장비 대여 확인.
// 나가는 값은 정해진 칸만 하나씩 골라 담아요. 남은 연차·병가 쓴 날·표를 준 사람·빌린 사람 칸은 스키마에 없어요.
// 링크(봉인 제안 토큰)에는 구조 값(날짜·종류·카드 ID·장비 종류·시각)만 들어가고, 사람이 쓴 글(사유·품목 이름)은 없어요.

const MAX_ITEMS = 3;

const def = (name: string): ToolDef => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`도구 레지스트리에 없어요: ${name}`);
  return tool;
};
const LEAVE_DEF = def('leave_prepare');
const PANTRY_DEF = def('pantry_find_similar');
const EQUIPMENT_DEF = def('rooms_find_equipment');
const describe = (tool: ToolDef, key: string) => tool.input[key]?.description ?? key;

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const ms = Date.parse(`${v}T00:00:00Z`);
    return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(v);
  });

/** MCP 휴가 준비의 날 종류: 하루 · 오전 반차 · 오후 반차(11/3). 앱 안의 LeaveDay(kind + half)로 바꿔 검사해요. */
const DAY_KINDS = ['full', 'am', 'pm'] as const satisfies readonly LeaveDayChoice[];

/** MCP 입력의 날 → 앱 휴가 하루 */
export const leaveDaysOfInput = (days: readonly { date: string; kind: LeaveDayChoice }[]): LeaveDay[] => days.map((d) => leaveDayOf(d.date, d.kind));

export const LEAVE_INPUT = z
  .object({
    days: z
      .array(
        z
          .object({
            date: DATE.describe('YYYY-MM-DD'),
            // 11/3: 구분 없는 반차는 받지 않아요. 오전·오후를 사람이 말하지 않았으면 링크를 만들기 전에 사람에게 물어요.
            kind: z.enum(DAY_KINDS).describe('full: 하루 · am: 오전 반차 · pm: 오후 반차. 반차인데 오전·오후를 모르면 사람에게 먼저 물어요'),
          })
          .strict(),
      )
      .min(1)
      .max(LEAVE_REQUEST_MAX_DAYS)
      .describe(describe(LEAVE_DEF, 'days')),
    type: z.enum(LEAVE_TYPES).describe(describe(LEAVE_DEF, 'type')),
  })
  .strict();
export type LeaveInput = z.infer<typeof LEAVE_INPUT>;

export const PANTRY_INPUT = z
  .object({
    itemName: z
      .string()
      .trim()
      .min(1)
      .max(PANTRY_DEF.input.itemName?.maxLength ?? 60)
      .describe(describe(PANTRY_DEF, 'itemName')),
  })
  .strict();
export type PantryInput = z.infer<typeof PANTRY_INPUT>;

export const EQUIPMENT_INPUT = z
  .object({
    kind: z.enum(LOAN_KINDS).describe(`${describe(EQUIPMENT_DEF, 'kind')}: ${LOAN_KINDS.join(', ')}`),
    date: DATE.describe(describe(EQUIPMENT_DEF, 'date')),
    start: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .describe(describe(EQUIPMENT_DEF, 'start')),
    minutes: z.number().int().min(15).max(480).optional().describe(describe(EQUIPMENT_DEF, 'minutes')),
  })
  .strict();
export type EquipmentInput = z.infer<typeof EQUIPMENT_INPUT>;

const EMPTY_REASON = z.object({ code: z.string(), message: z.string() }).strict().describe('결과가 없을 때만: 왜 없는지(message를 그대로 전해요)');
const LINK = { link: z.string().describe('앱 확인 링크. 본인만 열 수 있고 짧은 시간만 유효해요'), linkText: z.string() };
const CONFIRM = z.string().describe('사람에게 같이 전할 안내');

export const LEAVE_OUTPUT = z
  .object({
    type: z.enum(LEAVE_TYPES),
    typeLabel: z.string().describe('연차 · 공가 · 병가'),
    days: z
      .array(
        z
          .object({
            date: z.string().describe('YYYY-MM-DD'),
            kind: z.enum(DAY_KINDS),
            label: z.string().describe('예: 11월 6일(금) 하루 · 11월 5일(목) 오전 반차'),
          })
          .strict(),
      )
      .max(LEAVE_REQUEST_MAX_DAYS)
      .describe('양식에 채울 날(날짜 순). 형식·주말·기간을 확인한 날만이에요'),
    link: LINK.link.optional(),
    linkText: LINK.linkText.optional(),
    emptyReason: EMPTY_REASON.optional(),
    confirm: CONFIRM,
  })
  .strict();

export const PANTRY_OUTPUT = z
  .object({
    mock: z.boolean().describe('시연 데이터인지'),
    floor: z.string().describe('찾아본 판의 층(연결한 사람의 층)'),
    items: z
      .array(z.object({ name: z.string().describe('판에 올라간 품목 이름'), votes: z.number().int().min(0).describe('지금 표 수'), ...LINK }).strict())
      .max(MAX_ITEMS)
      .describe('같은 상품 같아 보이는 열린 품목(표 많은 순)'),
    newRequest: z.object(LINK).strict().describe('새 요청 쓰기: 판의 요청 쓰기 칸을 빈 채로 열어요(품목 이름은 링크에 없어요)'),
    emptyReason: EMPTY_REASON.optional(),
    confirm: CONFIRM,
  })
  .strict();

export const EQUIPMENT_OUTPUT = z
  .object({
    mock: z.boolean().describe('시연 데이터인지'),
    kind: z.enum(LOAN_KINDS),
    when: z.string().describe('예: 10월 27일(화) 15:00~16:00'),
    free: z.number().int().min(0).describe('그 시간에 남은 수'),
    total: z.number().int().min(0).describe('전체 수'),
    link: LINK.link.optional(),
    linkText: LINK.linkText.optional(),
    emptyReason: EMPTY_REASON.optional(),
    confirm: CONFIRM,
  })
  .strict();

const CONFIRM_LINE = '확정은 앱에서 한 번 · 링크는 본인만 · 짧은 시간만 유효해요';

export function shapeLeave(
  type: LeaveType,
  result: { ok: true; days: LeaveDay[]; link: string } | { ok: false; code: string; message: string },
): z.infer<typeof LEAVE_OUTPUT> {
  const typeLabel = LEAVE_TYPE_LABEL[type];
  if (!result.ok) return { type, typeLabel, days: [], emptyReason: { code: result.code, message: result.message }, confirm: CONFIRM_LINE };
  const reason = type === 'annual' ? '사유는 사람이 앱 양식에 직접 써요' : `${typeLabel} 사유는 사람이 앱 양식에서 직접 골라요`;
  return {
    type,
    typeLabel,
    // 검사를 지난 날이라 반차는 오전·오후가 있어요. 없으면(있을 수 없지만) 하루로 내보내지 않게 걸러요.
    days: result.days.flatMap((d) => {
      const kind = leaveDayChoice(d);
      return kind ? [{ date: d.date, kind, label: `${dayLabel(d.date)} ${leaveDayWord(d)}` }] : [];
    }),
    link: result.link,
    linkText: `한 줄 데스크에서 ${typeLabel} 신청 열기`,
    confirm: `${CONFIRM_LINE}. ${reason}. 남은 연차는 앱에서 봐요`,
  };
}

export function shapePantry(input: {
  mock: boolean;
  floor: string;
  items: { name: string; votes: number; link: string }[];
  newLink: string;
}): z.infer<typeof PANTRY_OUTPUT> {
  const items = input.items.slice(0, MAX_ITEMS).map((i) => ({
    name: cleanText(i.name, 60),
    votes: Math.max(0, Math.trunc(i.votes)),
    link: i.link,
    linkText: '한 줄 데스크에서 여기에 +1',
  }));
  return {
    mock: input.mock,
    floor: cleanText(input.floor, 10),
    items,
    newRequest: { link: input.newLink, linkText: '한 줄 데스크에서 새 요청 쓰기' },
    ...(items.length ? {} : { emptyReason: { code: 'no-match', message: '판에 같은 상품 같은 열린 품목이 없어요. 새 요청은 앱 판에서 직접 써요' } }),
    confirm: `${CONFIRM_LINE}. +1과 새 요청은 사람이 앱 판에서 직접 눌러요`,
  };
}

export function shapeEquipment(input: {
  mock: boolean;
  kind: (typeof LOAN_KINDS)[number];
  when: string;
  free: number;
  total: number;
  link?: string;
  emptyReason?: { code: string; message: string };
}): z.infer<typeof EQUIPMENT_OUTPUT> {
  return {
    mock: input.mock,
    kind: input.kind,
    when: cleanText(input.when, 60),
    free: Math.max(0, Math.trunc(input.free)),
    total: Math.max(0, Math.trunc(input.total)),
    ...(input.link ? { link: input.link, linkText: `한 줄 데스크에서 ${input.kind} 빌리기` } : {}),
    ...(input.emptyReason ? { emptyReason: input.emptyReason } : {}),
    confirm: `${CONFIRM_LINE}. 빌리기는 앱 확인 시트에서 한 번이에요`,
  };
}
