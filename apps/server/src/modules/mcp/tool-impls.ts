import { kstDate, kstTime, kstToEpoch, type RoomQuery } from '@one-line-desk/shared';
import type { z } from 'zod';
import type { AppContext } from '../../context';
import type { McpPrincipal } from './auth-service';
import {
  NOTICES_INPUT,
  NOTICES_MAX_HITS,
  NOTICES_OUTPUT,
  type NoticesInput,
  ROOMS_INPUT,
  ROOMS_OUTPUT,
  type RoomsInput,
  shapeNotices,
  shapeRooms,
} from './tools';
import {
  EMPTY_INPUT,
  FAQ_INPUT,
  FAQ_OUTPUT,
  type FaqInput,
  MINE_OUTPUT,
  ONBOARDING_OUTPUT,
  shapeFaq,
  shapeMine,
  shapeOnboarding,
  shapeTeams,
  TEAM_INPUT,
  TEAM_OUTPUT,
  type TeamInput,
} from './tools-navi';
import {
  EQUIPMENT_INPUT,
  EQUIPMENT_OUTPUT,
  type EquipmentInput,
  LEAVE_INPUT,
  LEAVE_OUTPUT,
  type LeaveInput,
  PANTRY_INPUT,
  PANTRY_OUTPUT,
  type PantryInput,
  shapeEquipment,
  shapeLeave,
  shapePantry,
} from './tools-links';

// MCP 도구 구현(11/2 정리). 도구 선언(이름·범위·제목·뺀 칸)은 core/tool-registry.ts, 여기는 입력·출력·실행만이에요.
// /mcp 경로(mcp-route.ts)가 이 표 하나로 범위 검사·입력 검사·횟수 제한·감사·접속기록을 똑같이 해요.
// 실행은 읽기만 해요. DB에 쓰지 않고 LLM을 부르지 않아요.

export interface ToolEnv {
  ctx: AppContext;
  principal: McpPrincipal;
  /** 앱 확인 링크의 주소 앞부분(우리 발급자) */
  issuer: string;
  /** 실제(모의가 아닌) 자료를 이 클라이언트에 보내도 되는지(보안팀 승인, ADR-15 계약 전 잠금) */
  realDataAllowed: () => Promise<boolean>;
  /** 모의 자료로만 도는 시연인지(내 요청 상태처럼 우리 DB 자료의 모의 판정에 써요) */
  allMockData: () => boolean;
}

export type ToolOutcome = { result: 'found' | 'none'; out: Record<string, unknown> } | { result: 'refused' | 'error'; message: string };

export interface McpToolImpl {
  input: z.ZodObject;
  output: z.ZodObject;
  /** 입력은 이미 input으로 검사한 값이에요. 던지면 'error'로 남고 errorMessage를 돌려줘요. */
  run: (env: ToolEnv, args: unknown) => Promise<ToolOutcome>;
  errorMessage: string;
}

async function findFreeRooms(env: ToolEnv, raw: unknown): Promise<ToolOutcome> {
  const input = raw as RoomsInput;
  const { ctx, principal } = env;
  const rooms = ctx.services.rooms;
  if (!rooms) throw new Error('rooms service missing');
  const settings = ctx.ops.get();
  const query: RoomQuery = {
    date: input.date,
    start: input.start,
    minutes: input.minutes ?? settings.values.defaultMeetingMinutes,
    people: input.people,
    equipment: input.equipment ?? [],
    ...(input.floor ? { floor: input.floor } : {}),
  };
  const result = await rooms.findFree(query);
  if (result.mock !== true && !(await env.realDataAllowed())) {
    return { result: 'refused', message: '회사가 허락하지 않은 앱이라 실제 회의실 현황은 보낼 수 없어요' };
  }
  // 앱 확인 링크(M3): 봉인한 짧은 수명의 제안 토큰만 넣어요(B11). 회의실 쓰기가 꺼져 있으면 그룹웨어 링크예요.
  const out = shapeRooms(result, ctx.now(), (c) =>
    settings.roomsWrite
      ? {
          link: `${env.issuer}/r/${rooms.proposeReservation({ pseudonymId: principal.pseudonymId }, { roomId: c.roomId, start: c.start, end: c.end, query })}`,
          linkText: '한 줄 데스크에서 예약하기',
        }
      : { link: settings.links.rooms, linkText: '그룹웨어에서 예약하기' },
  );
  return { result: out.candidates.length > 0 ? 'found' : 'none', out };
}

async function searchNotices(env: ToolEnv, raw: unknown): Promise<ToolOutcome> {
  const input = raw as NoticesInput;
  const notices = env.ctx.services.notices;
  if (!notices) throw new Error('notices service missing');
  const result = await notices.search(input.query, NOTICES_MAX_HITS);
  if (result.mock !== true && !(await env.realDataAllowed())) {
    return { result: 'refused', message: '회사가 허락하지 않은 앱이라 실제 공지는 보낼 수 없어요' };
  }
  const out = shapeNotices(result, notices.boards());
  return { result: out.hits.length > 0 ? 'found' : 'none', out };
}

// ── 2단계 읽기 도구(11/3, ADR-14 개정). navi 읽기는 ctx.services.navi.mcp로만 불러요(모듈 경계). ──

function naviRead(env: ToolEnv) {
  const read = env.ctx.services.navi?.mcp;
  if (!read) throw new Error('navi service missing');
  return read;
}

const REAL_DATA_REFUSED = '회사가 허락하지 않은 앱이라 실제 사내 자료는 보낼 수 없어요';

/** 문의 양식 앱 링크: 봉인한 짧은 수명의 제안 토큰에 받을 행만 담아요. 질문 글은 담지 않아요. */
const inquiryLink = (env: ToolEnv, rowId: string | null) =>
  `${env.issuer}/r/${naviRead(env).proposeInquiry({ pseudonymId: env.principal.pseudonymId }, rowId)}`;

async function findTeam(env: ToolEnv, raw: unknown): Promise<ToolOutcome> {
  const found = await naviRead(env).findTeam((raw as TeamInput).query);
  if (found.locked) return { result: 'refused', message: `보낼 수 없는 글자가 있어요: ${found.locked}. 그 부분을 빼고 다시 물어봐 주세요` };
  if (!found.mock && !(await env.realDataAllowed())) return { result: 'refused', message: REAL_DATA_REFUSED };
  const out = shapeTeams(found, (rowId) => inquiryLink(env, rowId));
  return { result: out.candidates.length > 0 ? 'found' : 'none', out };
}

async function itFaq(env: ToolEnv, raw: unknown): Promise<ToolOutcome> {
  const found = await naviRead(env).itFaq((raw as FaqInput).text);
  if (found.locked) return { result: 'refused', message: `보낼 수 없는 글자가 있어요: ${found.locked}. 그 부분을 빼고 다시 붙여 넣어 주세요` };
  if (!found.mock && !(await env.realDataAllowed())) return { result: 'refused', message: REAL_DATA_REFUSED };
  const out = shapeFaq(found, inquiryLink(env, found.inquiry.rowId));
  return { result: out.faq ? 'found' : 'none', out };
}

async function onboarding(env: ToolEnv): Promise<ToolOutcome> {
  const found = await naviRead(env).onboarding();
  if (!found.mock && !(await env.realDataAllowed())) return { result: 'refused', message: REAL_DATA_REFUSED };
  const out = shapeOnboarding(found, `${env.issuer}/`);
  return { result: out.weeks.length > 0 ? 'found' : 'none', out };
}

/** 본인 것만: 토큰의 가명 ID로만 찾아요. 입력으로 사람을 고를 수 없어요. */
async function myStatus(env: ToolEnv): Promise<ToolOutcome> {
  const { ctx, principal } = env;
  const mock = env.allMockData();
  if (!mock && !(await env.realDataAllowed())) return { result: 'refused', message: REAL_DATA_REFUSED };
  const requests = await naviRead(env).myRequests(principal.pseudonymId);
  const rooms = ctx.services.rooms;
  const mine = ctx.ops.get().modules.rooms === 'on' && rooms?.myReservations ? await rooms.myReservations({ pseudonymId: principal.pseudonymId }) : null;
  const reservations = (mine?.items ?? []).map((r) => ({ roomName: r.roomName, floor: r.floor, when: r.when }));
  const out = shapeMine({ mock, requests, reservations }, `${env.issuer}/`);
  return { result: out.requests.length + out.reservations.length > 0 ? 'found' : 'none', out };
}

// ── 확인 링크 도구(11/3 확인 링크 넓히기, ADR-14 개정). 쓰기는 하지 않고 앱 확인 링크만 줘요. ──
// 링크에는 구조 값만 봉인해요. 사람이 쓴 글(사유·품목 이름)은 토큰·출력·감사 어디에도 넣지 않아요(R13).

const linkTo = (env: ToolEnv, token: string) => `${env.issuer}/r/${token}`;

/** 휴가 신청 준비: 날짜 형식·주말·기간만 보고 링크를 줘요. 연차 자료(등급 2)는 읽지 않아서 숫자가 나갈 길이 없어요. */
async function prepareLeave(env: ToolEnv, raw: unknown): Promise<ToolOutcome> {
  const input = raw as LeaveInput;
  const prepared = naviRead(env).prepareLeave({ pseudonymId: env.principal.pseudonymId }, { days: input.days, type: input.type });
  const out = shapeLeave(input.type, prepared.ok ? { ok: true, days: prepared.days, link: linkTo(env, prepared.token) } : prepared);
  return { result: out.link ? 'found' : 'none', out };
}

/** 탕비실 요청 찾기: 연결한 사람 층(접근 토큰에 봉인된 값)의 열린 품목만, 이름 규칙으로. 품목 이름은 메모리에서만 써요. */
async function findPantry(env: ToolEnv, raw: unknown): Promise<ToolOutcome> {
  const read = env.ctx.services.pantry?.mcp;
  if (!read) throw new Error('pantry service missing');
  const floor = env.principal.floor;
  if (!floor) return { result: 'refused', message: '내 층을 확인하지 못했어요. 한 줄 데스크에 다시 연결하거나 앱 판에서 찾아 주세요' };
  const mock = env.allMockData();
  if (!mock && !(await env.realDataAllowed())) return { result: 'refused', message: REAL_DATA_REFUSED };
  const found = await read.findSimilar(floor, (raw as PantryInput).itemName);
  if (found.locked) return { result: 'refused', message: `보낼 수 없는 글자가 있어요: ${found.locked}. 그 부분을 빼고 다시 물어봐 주세요` };
  const user = { pseudonymId: env.principal.pseudonymId };
  const out = shapePantry({
    mock,
    floor,
    items: found.items.map((i) => ({ name: i.name, votes: i.votes, link: linkTo(env, read.proposeBoardLink(user, i.cardId)) })),
    newLink: linkTo(env, read.proposeBoardLink(user, null)),
  });
  return { result: out.items.length > 0 ? 'found' : 'none', out };
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const whenLabel = (date: string, from: number, to: number) =>
  `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일(${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]}) ${kstTime(from)}~${kstTime(to)}`;

/** 장비 대여 확인: 남은 수와 링크. 링크 토큰에는 장비 종류와 구간만 있어요. 자동 실행 허용 목록은 MCP로 넓히지 않아요. */
async function findEquipment(env: ToolEnv, raw: unknown): Promise<ToolOutcome> {
  const input = raw as EquipmentInput;
  const { ctx } = env;
  const read = ctx.services.rooms?.equipment;
  if (!read) throw new Error('equipment service missing');
  const mock = env.allMockData();
  if (!mock && !(await env.realDataAllowed())) return { result: 'refused', message: REAL_DATA_REFUSED };
  const settings = ctx.ops.get();
  const from = kstToEpoch(input.date, input.start);
  const to = from + (input.minutes ?? settings.values.defaultMeetingMinutes) * 60_000;
  const base = { mock, kind: input.kind, when: whenLabel(input.date, from, to) };
  if (kstDate(to - 1) !== input.date) {
    return {
      result: 'none',
      out: shapeEquipment({ ...base, free: 0, total: 0, emptyReason: { code: 'bad-time', message: '하루 안의 한 구간만 빌릴 수 있어요' } }),
    };
  }
  const { free, total } = await read.stock(input.kind, from, to);
  const reason =
    to <= ctx.now()
      ? { code: 'past', message: '이미 지난 시간이에요' }
      : total === 0
        ? { code: 'no-equipment', message: `회사에 ${input.kind} 대여 장비가 없어요` }
        : free === 0
          ? { code: 'all-loaned', message: '그 시간에는 모두 대여 중이에요. 다른 시간으로 다시 찾아 주세요' }
          : !settings.roomsWrite
            ? { code: 'write-off', message: '지금은 한 줄 데스크에서 장비를 빌릴 수 없어요. 총무팀에 문의해 주세요' }
            : null;
  if (reason) return { result: 'none', out: shapeEquipment({ ...base, free, total, emptyReason: reason }) };
  const start = new Date(from + 9 * 3_600_000).toISOString().slice(0, 19) + '+09:00';
  const end = new Date(to + 9 * 3_600_000).toISOString().slice(0, 19) + '+09:00';
  const token = read.proposeRentLink({ pseudonymId: env.principal.pseudonymId }, { kind: input.kind, start, end });
  return { result: 'found', out: shapeEquipment({ ...base, free, total, link: linkTo(env, token) }) };
}

/** 이름은 레지스트리의 MCP 도구 이름과 하나씩 맞아야 해요(시험이 봐요). */
export const MCP_TOOL_IMPLS: Record<string, McpToolImpl> = {
  rooms_find_free: { input: ROOMS_INPUT, output: ROOMS_OUTPUT, run: findFreeRooms, errorMessage: '지금 빈 회의실을 찾지 못했어요' },
  notices_search: { input: NOTICES_INPUT, output: NOTICES_OUTPUT, run: searchNotices, errorMessage: '지금 공지를 찾지 못했어요' },
  navi_find_team: { input: TEAM_INPUT, output: TEAM_OUTPUT, run: findTeam, errorMessage: '지금 받을 팀을 찾지 못했어요' },
  navi_it_faq: { input: FAQ_INPUT, output: FAQ_OUTPUT, run: itFaq, errorMessage: '지금 IT FAQ를 찾지 못했어요' },
  navi_onboarding: { input: EMPTY_INPUT, output: ONBOARDING_OUTPUT, run: onboarding, errorMessage: '지금 첫 2주 할 일을 불러오지 못했어요' },
  my_requests_status: { input: EMPTY_INPUT, output: MINE_OUTPUT, run: myStatus, errorMessage: '지금 내 요청 상태를 불러오지 못했어요' },
  leave_prepare: { input: LEAVE_INPUT, output: LEAVE_OUTPUT, run: prepareLeave, errorMessage: '지금 휴가 신청을 준비하지 못했어요' },
  pantry_find_similar: { input: PANTRY_INPUT, output: PANTRY_OUTPUT, run: findPantry, errorMessage: '지금 탕비실 요청판을 찾지 못했어요' },
  rooms_find_equipment: { input: EQUIPMENT_INPUT, output: EQUIPMENT_OUTPUT, run: findEquipment, errorMessage: '지금 장비 대여를 확인하지 못했어요' },
};
