import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_SCOPES, type McpScope } from '@one-line-desk/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context';
import { accessFrom } from '../../core/access-record';
import { listMcpTools, type McpToolDef, TOOLS } from '../../core/tool-registry';
import type { McpAuth, McpPrincipal } from './auth-service';
import * as counts from './counts';
import { scopeOf } from './policy';
import * as repo from './repo';
import { MCP_TOOL_IMPLS, type ToolEnv } from './tool-impls';

// 자원 서버 /mcp(ADR-14·15). Streamable HTTP, 상태 없음(요청마다 서버를 새로 만들어요).
// 요청마다 토큰(aud·만료·범위·폐기)을 검사하고, MCP 스위치·모듈 스위치·도구별 스위치로 도구 목록을 정해요. 쓰기 도구는 없어요.
// 도구는 이름으로 나누지 않고 레지스트리(core/tool-registry.ts)와 구현 표(tool-impls.ts)로 똑같이 다뤄요(11/2 정리).
// 이 경로는 LLM(ctx.gateway)을 부르지 않고, DB에는 감사 로그·접속기록 말고 쓰지 않아요.

/**
 * 서버 안내문. 이 MCP가 할 수 있는 것과 못 하는 것을 적고, 못 하는 질문은 짐작하지 말고 앱으로 보내게 해요(10/26 MCP 베타 시험 U5).
 * 11/3 2단계: 담당 팀 찾기·IT 오류 FAQ·첫 2주 할 일·내 요청 상태가 생겨서 "담당 부서 질문은 답할 수 없어요" 문장을 바꿨어요.
 */
function instructions(appUrl: string): string {
  return (
    '한 줄 데스크 읽기 전용 MCP예요. 빈 회의실 후보(정원·장비·설비 포함), 공지 제목·게시일·원문 링크, 업무 분장표의 받을 팀, IT 오류 FAQ 원문 단계, 첫 2주 할 일, 내가 보낸 요청의 상태를 돌려줘요. ' +
    '예약·취소·게시·문의 보내기는 할 수 없어요. 그런 일은 결과의 앱 확인 링크를 사람이 열어 한 줄 데스크 앱에서 한 번 눌러 확정해요. 링크를 여는 것만으로는 아무것도 바뀌지 않아요. ' +
    '결과가 없으면 emptyReason.message에 까닭이 있어요. ' +
    `담당 부서·할 일 질문(예: "법인카드를 잃어버렸어요")은 navi_find_team 결과의 팀·지금 할 일만 전하고, 분장표에 없는 내용은 짐작해서 답하지 말고 대표 창구나 한 줄 데스크 앱(${appUrl})의 문의함을 안내해 주세요. ` +
    `남은 연차 숫자·문의와 답장 글은 이 MCP로 보내지 않아요. 앱(${appUrl})에서 보라고 안내해 주세요. ` +
    APP_IS_FOR_PEOPLE
  );
}

/** 앱 주소를 보고 클라이언트가 앱 화면을 직접 받아 오려 하지 않게 해요(꺼짐 시험에서 curl을 시도했어요). */
const APP_IS_FOR_PEOPLE = '앱은 사람이 회사 계정으로 로그인해서 쓰는 화면이라 대신 열거나 읽을 수 없어요. 주소를 사람에게 알려 주기만 해요.';

/** 운영자가 MCP를 껐을 때 안내. 인증 문제가 아니라는 걸 분명히 해요(U4). */
function offMessage(appUrl: string): string {
  return `운영자가 한 줄 데스크 MCP를 잠시 껐어요. 인증이나 연결 문제는 아니에요. 그동안 회의실·공지·문의함은 사람이 한 줄 데스크 앱(${appUrl})을 직접 열어 찾도록 안내해 주세요. ${APP_IS_FOR_PEOPLE}`;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

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

  // 감사 로그(7일)와 같은 자리에서 월간 보고용 날마다 셈(call.<결과>, 앱 이름별)도 더해요(counts.ts).
  const auditTool = async (principal: McpPrincipal, tool: string, result: 'found' | 'none' | 'refused' | 'error') => {
    await ctx.audit.record({ pseudonymId: principal.pseudonymId, channel: 'mcp', tool, clientId: principal.clientId, result });
    await counts.count(ctx.db, ctx.now(), `call.${result}`, principal.clientId);
  };

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
    // 법정 접속기록(ADR-20): 도구를 부른 요청마다 한 줄. 가명 ID·접속지·요청 번호만 남고 도구 이름·입력은 남지 않아요(도구는 감사 로그 7일).
    for (const call of calls)
      if (KNOWN_TOOLS.has(call.name)) await ctx.access.record({ pseudonymId: principal.pseudonymId, action: 'mcp.call', ...accessFrom(req) });

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
      if (!MCP_TOOL_IMPLS[tool.name]?.input.safeParse(call.args).success) {
        // 입력이 맞지 않으면 SDK가 오류로 답해요. 감사 로그에는 거부만 남고 입력 값은 남지 않아요.
        await auditTool(principal, tool.name, 'refused');
        continue;
      }
      if (!ctx.rateLimiter.hit(principal.pseudonymId, `mcp.${tool.name}`)) {
        await auditTool(principal, tool.name, 'refused');
        return reply.code(429).send({ error: 'rate-limited', message: '요청이 많아요. 잠시 뒤에 다시 해 주세요' });
      }
    }

    const server =
      tools.length > 0
        ? buildServer(ctx, mcp, principal, tools, auditTool, appUrl)
        : // 도구가 모두 빠지면(모듈·도구 스위치, M5) 목록이 비어요. 예전 목록으로 부르면 꺼졌다고 알려 줘요.
          emptyServer(instructions(appUrl), `지금은 이 도구가 꺼져 있어요. 한 줄 데스크 앱(${appUrl})에서 확인해 주세요.`);
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

function buildServer(ctx: AppContext, mcp: McpAuth, principal: McpPrincipal, tools: McpToolDef[], auditTool: AuditTool, appUrl: string): McpServer {
  const server = new McpServer({ name: 'one-line-desk', version: '0.1.0' }, { instructions: instructions(appUrl) });
  const env: ToolEnv = {
    ctx,
    principal,
    issuer: mcp.urls.issuer,
    // 실제(모의가 아닌) 데이터는 보안팀 승인 클라이언트에만 보내요(ADR-15 계약 전 잠금).
    realDataAllowed: async () => (await repo.findClient(ctx.db, principal.clientId))?.securityApproved === true,
    allMockData: () => mcp.allMockData(),
  };
  for (const tool of tools) {
    const impl = MCP_TOOL_IMPLS[tool.name];
    if (!impl) continue;
    server.registerTool(
      tool.name,
      { title: tool.mcp.title, description: tool.description, inputSchema: impl.input, outputSchema: impl.output, annotations: READ_ONLY },
      async (args: unknown): Promise<CallToolResult> => {
        if (!principal.scopes.includes(tool.mcp.scope)) {
          await auditTool(principal, tool.name, 'refused');
          return toolError(`이 연결에는 ${tool.mcp.title} 허락이 없어요`);
        }
        try {
          const outcome = await impl.run(env, args);
          await auditTool(principal, tool.name, outcome.result);
          return 'out' in outcome ? toolResult(outcome.out) : toolError(outcome.message);
        } catch {
          await auditTool(principal, tool.name, 'error');
          return toolError(impl.errorMessage);
        }
      },
    );
  }
  return server;
}

const toolError = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });
const toolResult = (out: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
