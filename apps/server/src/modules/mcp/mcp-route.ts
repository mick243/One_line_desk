import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_SCOPES, type McpScope, type RoomQuery } from '@one-line-desk/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context';
import type { LimitedAction } from '../../core/rate-limit';
import { listMcpTools, TOOLS, type ToolDef } from '../../core/tool-registry';
import type { McpAuth, McpPrincipal } from './auth-service';
import { scopeOf } from './policy';
import * as repo from './repo';
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

// 자원 서버 /mcp(ADR-14·15). Streamable HTTP, 상태 없음(요청마다 서버를 새로 만들어요).
// 요청마다 토큰(aud·만료·범위·폐기)을 검사하고, MCP 스위치·모듈 스위치로 도구 목록을 정해요. 쓰기 도구는 없어요.
// 이 경로는 LLM(ctx.gateway)을 부르지 않고, DB에는 감사 로그 말고 쓰지 않아요.

/** 서버 안내문. 이 MCP가 못 하는 질문(담당 부서·내 예약)은 짐작하지 말고 앱으로 보내게 해요(10/26 MCP 베타 시험 U5). */
function instructions(appUrl: string): string {
  return (
    '한 줄 데스크 읽기 전용 MCP예요. 빈 회의실 후보(정원·장비·설비 포함)와 공지 제목·게시일·원문 링크만 돌려줘요. ' +
    '예약·취소·게시는 할 수 없어요. 회의실 예약은 후보의 링크를 사람이 열어 한 줄 데스크 앱의 확인 시트에서 해요. ' +
    '결과가 없으면 emptyReason.message에 까닭이 있어요. ' +
    `담당 부서·할 일 질문(예: "법인카드를 잃어버렸어요", "재직증명서 어디서 떼요?")은 이 MCP로 답할 수 없어요. 짐작해서 답하지 말고, 한 줄 데스크 앱(${appUrl})의 담당 찾기에서 물어보라고 안내해 주세요. ` +
    `내 예약 보기·취소도 앱(${appUrl})의 회의실이나 내 것에서 해요. ` +
    APP_IS_FOR_PEOPLE
  );
}

/** 앱 주소를 보고 클라이언트가 앱 화면을 직접 받아 오려 하지 않게 해요(꺼짐 시험에서 curl을 시도했어요). */
const APP_IS_FOR_PEOPLE = '앱은 사람이 회사 계정으로 로그인해서 쓰는 화면이라 대신 열거나 읽을 수 없어요. 주소를 사람에게 알려 주기만 해요.';

/** 운영자가 MCP를 껐을 때 안내. 인증 문제가 아니라는 걸 분명히 해요(U4). */
function offMessage(appUrl: string): string {
  return `운영자가 한 줄 데스크 MCP를 잠시 껐어요. 인증이나 연결 문제는 아니에요. 그동안 회의실·공지는 사람이 한 줄 데스크 앱(${appUrl})을 직접 열어 찾도록 안내해 주세요. ${APP_IS_FOR_PEOPLE}`;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const LIMIT_KEY: Record<string, LimitedAction> = { rooms_find_free: 'mcp.rooms_find_free', notices_search: 'mcp.notices_search' };
const INPUT_SCHEMA: Record<string, typeof ROOMS_INPUT | typeof NOTICES_INPUT> = { rooms_find_free: ROOMS_INPUT, notices_search: NOTICES_INPUT };
const KNOWN_TOOLS = new Set(TOOLS.map((t) => t.name));

interface ToolCall {
  id: unknown;
  name: string;
  args: unknown;
}

export function registerMcpRoute(app: FastifyInstance, ctx: AppContext, mcp: McpAuth) {
  const { urls } = mcp;
  const ownOrigin = new URL(urls.issuer).origin;
  const appUrl = `${ownOrigin}/`;

  const auditTool = (principal: McpPrincipal, tool: string, result: 'found' | 'none' | 'refused' | 'error') =>
    ctx.audit.record({ pseudonymId: principal.pseudonymId, channel: 'mcp', tool, clientId: principal.clientId, result });

  /** 토큰이 없거나 맞지 않으면 401 + 보호 자원 메타데이터 주소(RFC 9728 5.1). */
  const challenge = (reply: FastifyReply, error?: 'invalid_token') => {
    const params = [`resource_metadata="${urls.resourceMetadata}"`, `scope="${MCP_SCOPES.join(' ')}"`];
    if (error) params.unshift(`error="${error}"`);
    return reply
      .code(401)
      .header('www-authenticate', `Bearer ${params.join(', ')}`)
      .send({ error: error ?? 'unauthorized', message: '한 줄 데스크에 다시 연결해 주세요' });
  };

  app.post('/mcp', async (req, reply) => {
    // 브라우저에서 온 요청은 우리 출처만 받아요(DNS 리바인딩 막기). Claude는 서버에서 불러서 Origin이 없어요.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== ownOrigin) return reply.code(403).send({ error: 'origin', message: '허용하지 않은 출처예요' });

    const auth = await mcp.authenticate(req.headers.authorization);
    if (!auth.ok) return challenge(reply, auth.error);
    const principal = auth.principal;
    const calls = toolCalls(req.body);

    if (!(await mcp.runnable())) {
      // 꺼짐은 인증 오류(401·403)로 답하지 않아요. 클라이언트가 다시 로그인하라고 잘못 안내해요(U4).
      // 정상 응답에 도구 0개 + 꺼졌다는 안내문을 주고, 예전 목록으로 부른 도구에는 같은 안내를 오류 결과로 돌려줘요.
      for (const call of calls) if (KNOWN_TOOLS.has(call.name)) await auditTool(principal, call.name, 'refused');
      return serve(req, reply, emptyServer(offMessage(appUrl), offMessage(appUrl)));
    }
    const tools = listMcpTools(ctx.ops.get());

    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) {
        // 목록에 없는 도구(꺼진 모듈·없는 이름)는 SDK가 "없는 도구"로 답해요. 모르는 이름은 감사 로그에 넣지 않아요.
        if (KNOWN_TOOLS.has(call.name)) await auditTool(principal, call.name, 'refused');
        continue;
      }
      const needed = scopeOf(tool);
      if (!needed || !principal.scopes.includes(needed)) {
        await auditTool(principal, tool.name, 'refused');
        const scope = [...new Set<McpScope>([...principal.scopes, ...(needed ? [needed] : [])])].join(' ');
        return reply
          .code(403)
          .header('www-authenticate', `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${urls.resourceMetadata}"`)
          .send({ error: 'insufficient_scope', message: '이 도구를 쓰려면 한 줄 데스크에 다시 연결해서 허락해 주세요' });
      }
      if (!INPUT_SCHEMA[tool.name]?.safeParse(call.args).success) {
        // 입력이 맞지 않으면 SDK가 오류로 답해요. 감사 로그에는 거부만 남고 입력 값은 남지 않아요.
        await auditTool(principal, tool.name, 'refused');
        continue;
      }
      const limitKey = LIMIT_KEY[tool.name];
      if (!limitKey || !ctx.rateLimiter.hit(principal.pseudonymId, limitKey)) {
        await auditTool(principal, tool.name, 'refused');
        return reply.code(429).send({ error: 'rate-limited', message: '요청이 많아요. 잠시 뒤에 다시 해 주세요' });
      }
    }

    const server =
      tools.length > 0
        ? buildServer(ctx, mcp, principal, tools, auditTool, appUrl)
        : // 회의실·공지가 모두 빠지면 도구가 없어요(M5). 예전 목록으로 부르면 꺼졌다고 알려 줘요.
          emptyServer(instructions(appUrl), `지금은 회의실·공지 찾기가 꺼져 있어요. 한 줄 데스크 앱(${appUrl})에서 확인해 주세요.`);
    return serve(req, reply, server);
  });

  // 상태 없는 서버라 SSE 스트림(GET)과 세션 끝내기(DELETE)는 없어요.
  app.route({
    method: ['GET', 'DELETE'],
    url: '/mcp',
    handler: async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'method-not-allowed', message: 'POST로만 불러요' }),
  });
}

/** 요청마다 만든 서버를 Streamable HTTP로 한 번 답해요(상태 없음). */
async function serve(req: FastifyRequest, reply: FastifyReply, server: McpServer): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  reply.hijack();
  reply.raw.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await transport.handleRequest(req.raw, reply.raw, req.body);
  } catch {
    req.log.error({ msg: 'mcp transport failed' });
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'server-error', message: '지금 처리하지 못했어요' }));
    }
  }
}

/** 도구가 없는 서버. 목록은 비어 있고, 도구를 부르면 callMessage를 오류 결과로 돌려줘요. */
function emptyServer(serverInstructions: string, callMessage: string): McpServer {
  const server = new McpServer({ name: 'one-line-desk', version: '0.1.0' }, { instructions: serverInstructions });
  // SDK는 도구를 하나도 안 넣으면 tools/list·tools/call을 몰라서 직접 답해요.
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.server.setRequestHandler(CallToolRequestSchema, async () => toolError(callMessage));
  return server;
}

function toolCalls(body: unknown): ToolCall[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((m) => {
    if (!m || typeof m !== 'object') return [];
    const msg = m as { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if (msg.method !== 'tools/call') return [];
    return [{ id: msg.id, name: typeof msg.params?.name === 'string' ? msg.params.name : '', args: msg.params?.arguments }];
  });
}

type AuditTool = (principal: McpPrincipal, tool: string, result: 'found' | 'none' | 'refused' | 'error') => Promise<void>;

function buildServer(ctx: AppContext, mcp: McpAuth, principal: McpPrincipal, tools: ToolDef[], auditTool: AuditTool, appUrl: string): McpServer {
  const server = new McpServer({ name: 'one-line-desk', version: '0.1.0' }, { instructions: instructions(appUrl) });
  for (const tool of tools) {
    if (tool.name === 'rooms_find_free') {
      server.registerTool(
        tool.name,
        { title: '빈 회의실 찾기', description: tool.description, inputSchema: ROOMS_INPUT, outputSchema: ROOMS_OUTPUT, annotations: READ_ONLY },
        async (args) => findFreeRooms(ctx, mcp, principal, args, auditTool),
      );
    } else if (tool.name === 'notices_search') {
      server.registerTool(
        tool.name,
        { title: '공지 찾기', description: tool.description, inputSchema: NOTICES_INPUT, outputSchema: NOTICES_OUTPUT, annotations: READ_ONLY },
        async (args) => searchNotices(ctx, principal, args, auditTool),
      );
    }
  }
  return server;
}

const toolError = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });
const toolResult = (out: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });

/** 실제(모의가 아닌) 데이터는 보안팀 승인 클라이언트에만 보내요(ADR-15 계약 전 잠금). */
async function approvedForRealData(ctx: AppContext, clientId: string): Promise<boolean> {
  return (await repo.findClient(ctx.db, clientId))?.securityApproved === true;
}

async function findFreeRooms(ctx: AppContext, mcp: McpAuth, principal: McpPrincipal, input: RoomsInput, auditTool: AuditTool): Promise<CallToolResult> {
  const name = 'rooms_find_free';
  if (!principal.scopes.includes('rooms.read')) {
    await auditTool(principal, name, 'refused');
    return toolError('이 연결에는 빈 회의실 찾기 허락이 없어요');
  }
  const rooms = ctx.services.rooms;
  const settings = ctx.ops.get();
  const query: RoomQuery = {
    date: input.date,
    start: input.start,
    minutes: input.minutes ?? settings.values.defaultMeetingMinutes,
    people: input.people,
    equipment: input.equipment ?? [],
    ...(input.floor ? { floor: input.floor } : {}),
  };
  try {
    if (!rooms) throw new Error('rooms service missing');
    const result = await rooms.findFree(query);
    if (result.mock !== true && !(await approvedForRealData(ctx, principal.clientId))) {
      await auditTool(principal, name, 'refused');
      return toolError('회사가 허락하지 않은 앱이라 실제 회의실 현황은 보낼 수 없어요');
    }
    // 앱 확인 링크(M3): 서명한 짧은 수명의 제안 토큰만 넣어요. 회의실 쓰기가 꺼져 있으면 그룹웨어 링크예요.
    const out = shapeRooms(result, ctx.now(), (c) =>
      settings.roomsWrite
        ? {
            link: `${mcp.urls.issuer}/r/${rooms.proposeReservation({ pseudonymId: principal.pseudonymId }, { roomId: c.roomId, start: c.start, end: c.end, query })}`,
            linkText: '한 줄 데스크에서 예약하기',
          }
        : { link: settings.links.rooms, linkText: '그룹웨어에서 예약하기' },
    );
    await auditTool(principal, name, out.candidates.length > 0 ? 'found' : 'none');
    return toolResult(out);
  } catch {
    await auditTool(principal, name, 'error');
    return toolError('지금 빈 회의실을 찾지 못했어요');
  }
}

async function searchNotices(ctx: AppContext, principal: McpPrincipal, input: NoticesInput, auditTool: AuditTool): Promise<CallToolResult> {
  const name = 'notices_search';
  if (!principal.scopes.includes('notices.read')) {
    await auditTool(principal, name, 'refused');
    return toolError('이 연결에는 공지 찾기 허락이 없어요');
  }
  try {
    const notices = ctx.services.notices;
    if (!notices) throw new Error('notices service missing');
    const result = await notices.search(input.query, NOTICES_MAX_HITS);
    if (result.mock !== true && !(await approvedForRealData(ctx, principal.clientId))) {
      await auditTool(principal, name, 'refused');
      return toolError('회사가 허락하지 않은 앱이라 실제 공지는 보낼 수 없어요');
    }
    const out = shapeNotices(result, notices.boards());
    await auditTool(principal, name, out.hits.length > 0 ? 'found' : 'none');
    return toolResult(out);
  } catch {
    await auditTool(principal, name, 'error');
    return toolError('지금 공지를 찾지 못했어요');
  }
}
