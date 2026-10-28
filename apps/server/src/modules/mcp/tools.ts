import { EQUIPMENT, kstDate, kstTime, type NoticeHit, type RoomCandidate, type RoomSearchResult } from '@one-line-desk/shared';
import { z } from 'zod';
import { TOOLS, type ToolDef } from '../../core/tool-registry';

// MCP 도구 둘의 입력·출력(ADR-14). 들어오는 값은 남의 입력으로 보고 길이·정해진 목록으로 검증해요.
// 나가는 값은 정해진 칸만 하나씩 골라 담아요. 서비스가 다른 칸(예약자·회의 제목·본문)을 실어 보내도 여기서 버려요.

export const NOTICES_MAX_HITS = 5;
const MAX_CANDIDATES = 3;
const MAX_ALTERNATIVES = 2;

const def = (name: string): ToolDef => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`도구 레지스트리에 없어요: ${name}`);
  return tool;
};
const ROOMS_DEF = def('rooms_find_free');
const NOTICES_DEF = def('notices_search');
const describe = (tool: ToolDef, key: string) => tool.input[key]?.description ?? key;

const isRealDate = (v: string) => {
  const ms = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(v);
};

export const ROOMS_INPUT = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isRealDate)
      .describe(describe(ROOMS_DEF, 'date')),
    start: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .describe(describe(ROOMS_DEF, 'start')),
    minutes: z.number().int().min(15).max(480).optional().describe(describe(ROOMS_DEF, 'minutes')),
    people: z.number().int().min(1).max(100).describe(describe(ROOMS_DEF, 'people')),
    equipment: z
      .array(z.enum(EQUIPMENT))
      .max(EQUIPMENT.length)
      .optional()
      .describe(`${describe(ROOMS_DEF, 'equipment')}: ${EQUIPMENT.join(', ')}`),
    floor: z
      .string()
      .regex(/^B?\d{1,2}층$/)
      .optional()
      .describe(`${describe(ROOMS_DEF, 'floor')}(예: 3층)`),
  })
  .strict();
export type RoomsInput = z.infer<typeof ROOMS_INPUT>;

export const NOTICES_INPUT = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(NOTICES_DEF.input.query?.maxLength ?? 100)
      .describe(describe(NOTICES_DEF, 'query')),
  })
  .strict();
export type NoticesInput = z.infer<typeof NOTICES_INPUT>;

// 회의실 후보 한 칸. 정원·장비·설비는 회의실을 고를 근거라 넣어요. 예약자·회의 제목·방별 일정 칸은 없어요(ADR-06·14).
const ROOM_SLOT = z
  .object({
    roomId: z.string(),
    roomName: z.string(),
    floor: z.string(),
    date: z.string(),
    start: z.string(),
    end: z.string(),
    matched: z.array(z.string()),
    capacity: z.number().int().min(1).optional().describe('정원(명)'),
    equipment: z.array(z.enum(EQUIPMENT)).describe('정해진 장비 목록 중 갖춘 것'),
    facilities: z.array(z.string()).describe('장부에 적힌 설비(예: TV 모니터 75인치)'),
    link: z.string(),
    linkText: z.string(),
  })
  .strict();

/** 결과가 없을 때 까닭. message를 사람에게 그대로 전하면 돼요. */
const EMPTY_REASON = z.object({ code: z.string(), message: z.string() }).strict().describe('결과가 없을 때만: 왜 없는지(message를 그대로 전해요)');

export const ROOMS_OUTPUT = z
  .object({
    checkedAt: z.string().describe('현황 조회 시각(ISO)'),
    checkedAtLabel: z.string().describe('현황 HH:MM 기준'),
    mock: z.boolean().describe('모의 장부(시연 데이터)인지'),
    candidates: z.array(ROOM_SLOT).max(MAX_CANDIDATES),
    alternatives: z.array(ROOM_SLOT).max(MAX_ALTERNATIVES),
    emptyReason: EMPTY_REASON.optional(),
  })
  .strict();
export type RoomsOutput = z.infer<typeof ROOMS_OUTPUT>;

// 공지는 제목·게시일·원문 링크만이에요. 본문·발췌·요약 칸은 없어요(ADR-14).
export const NOTICES_OUTPUT = z
  .object({
    mock: z.boolean().describe('가상 공지(시연 데이터)인지'),
    hits: z.array(z.object({ title: z.string(), postedOn: z.string(), url: z.string() }).strict()).max(NOTICES_MAX_HITS),
    emptyReason: EMPTY_REASON.optional(),
  })
  .strict();
export type NoticesOutput = z.infer<typeof NOTICES_OUTPUT>;

/** 제어 문자·방향 바꾸기 같은 보이지 않는 문자를 지우고 길이를 잘라요. */
export function cleanText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : '';
  return text
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function epoch(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

type SlotLink = { link: string; linkText: string };

/** 회의실 결과에서 정해진 칸만 골라요. linkFor는 후보마다 앱 확인 링크(또는 그룹웨어 링크)를 만들어요. */
export function shapeRooms(result: RoomSearchResult, now: number, linkFor: (c: RoomCandidate) => SlotLink): RoomsOutput {
  const slot = (c: RoomCandidate) => {
    const start = epoch(c.start);
    const end = epoch(c.end);
    if (start === null || end === null || end <= start) return null;
    const { link, linkText } = linkFor(c);
    return {
      roomId: cleanText(c.roomId, 40),
      roomName: cleanText(c.roomName, 40),
      floor: cleanText(c.floor, 10),
      date: kstDate(start),
      start: kstTime(start),
      end: kstTime(end),
      matched: (Array.isArray(c.matched) ? c.matched : [])
        .slice(0, 6)
        .map((m) => cleanText(m, 30))
        .filter(Boolean),
      ...(Number.isInteger(c.capacity) && c.capacity > 0 && c.capacity <= 1000 ? { capacity: c.capacity } : {}),
      equipment: (Array.isArray(c.equipment) ? c.equipment : []).filter((e) => (EQUIPMENT as readonly string[]).includes(e)),
      facilities: (Array.isArray(c.facilities) ? c.facilities : [])
        .slice(0, 10)
        .map((f) => cleanText(f, 40))
        .filter(Boolean),
      link,
      linkText,
    };
  };
  const pick = (list: unknown, max: number) => (Array.isArray(list) ? (list as RoomCandidate[]) : []).slice(0, max).flatMap((c) => slot(c) ?? []);
  const checked = epoch(result.checkedAt) ?? now;
  const candidates = pick(result.candidates, MAX_CANDIDATES);
  const reason = result.emptyReason;
  const message = cleanText(reason?.message, 200);
  return {
    checkedAt: new Date(checked).toISOString(),
    checkedAtLabel: kstTime(checked),
    mock: result.mock === true,
    candidates,
    alternatives: pick(result.alternatives, MAX_ALTERNATIVES),
    ...(candidates.length === 0 && message ? { emptyReason: { code: cleanText(reason?.code, 30) || 'none', message } } : {}),
  };
}

/** 공지 결과에서 제목·게시일·원문 링크만 골라요. 링크가 http(s)가 아니면 그 줄을 버려요. 하나도 없으면 찾아본 게시판을 알려 줘요. */
export function shapeNotices(result: { mock: boolean; hits: NoticeHit[] }, boards: string[] = []): NoticesOutput {
  const hits = (Array.isArray(result.hits) ? result.hits : []).flatMap((h) => {
    const url = cleanUrl(h.url);
    const title = cleanText(h.title, 120);
    if (!url || !title) return [];
    const postedOn = typeof h.postedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.postedOn) ? h.postedOn : '';
    return [{ title, postedOn, url }];
  });
  const out = { mock: result.mock === true, hits: hits.slice(0, NOTICES_MAX_HITS) };
  if (out.hits.length) return out;
  const where = boards
    .map((b) => cleanText(b, 30))
    .filter(Boolean)
    .join(' · ');
  const message = where
    ? `허용 게시판(${where})에서 찾았지만 맞는 공지가 없어요. 다른 낱말로 다시 찾아 주세요`
    : '맞는 공지가 없어요. 다른 낱말로 다시 찾아 주세요';
  return { ...out, emptyReason: { code: 'no-match', message } };
}
