import type { RoomQuery } from '@one-line-desk/shared';
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

/** 이름은 레지스트리의 MCP 도구 이름과 하나씩 맞아야 해요(시험이 봐요). */
export const MCP_TOOL_IMPLS: Record<string, McpToolImpl> = {
  rooms_find_free: { input: ROOMS_INPUT, output: ROOMS_OUTPUT, run: findFreeRooms, errorMessage: '지금 빈 회의실을 찾지 못했어요' },
  notices_search: { input: NOTICES_INPUT, output: NOTICES_OUTPUT, run: searchNotices, errorMessage: '지금 공지를 찾지 못했어요' },
  navi_find_team: { input: TEAM_INPUT, output: TEAM_OUTPUT, run: findTeam, errorMessage: '지금 받을 팀을 찾지 못했어요' },
  navi_it_faq: { input: FAQ_INPUT, output: FAQ_OUTPUT, run: itFaq, errorMessage: '지금 IT FAQ를 찾지 못했어요' },
  navi_onboarding: { input: EMPTY_INPUT, output: ONBOARDING_OUTPUT, run: onboarding, errorMessage: '지금 첫 2주 할 일을 불러오지 못했어요' },
  my_requests_status: { input: EMPTY_INPUT, output: MINE_OUTPUT, run: myStatus, errorMessage: '지금 내 요청 상태를 불러오지 못했어요' },
};
