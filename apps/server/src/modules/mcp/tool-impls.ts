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

/** 이름은 레지스트리의 MCP 도구 이름과 하나씩 맞아야 해요(시험이 봐요). */
export const MCP_TOOL_IMPLS: Record<string, McpToolImpl> = {
  rooms_find_free: { input: ROOMS_INPUT, output: ROOMS_OUTPUT, run: findFreeRooms, errorMessage: '지금 빈 회의실을 찾지 못했어요' },
  notices_search: { input: NOTICES_INPUT, output: NOTICES_OUTPUT, run: searchNotices, errorMessage: '지금 공지를 찾지 못했어요' },
};
