import type { McpClientCreateRequest, McpClientCreateResponse, McpClientSummary, McpReport } from '@one-line-desk/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext, PreHandler } from '../../context';
import { accessFrom } from '../../core/access-record';
import * as admin from './admin';
import { APP_NAME_MAX, MAX_REDIRECTS } from './policy';

// 운영자 전용 MCP 관리 API(11/3, MCP 통합 회의 1단계). 운영자 웹 화면은 만들지 않아요(R7, 사용자 결정).
// 읽기는 로그인 + operator 역할, 쓰기는 거기에 넓게 연 시연 잠금까지(routes/config.ts opsWrite와 같은 보호).
// 응답에는 연결한 사람의 이름·가명 ID가 없고 셈만 있어요. 기밀 클라이언트 비밀은 등록 응답에서 한 번만 나가요.

const CLIENT_PARAMS = {
  type: 'object',
  required: ['clientId'],
  additionalProperties: false,
  properties: { clientId: { type: 'string', pattern: '^[A-Za-z0-9._-]{8,100}$' } },
} as const;

export function registerMcpOpsRoutes(app: FastifyInstance, ctx: AppContext) {
  const deps: admin.AdminDeps = { db: ctx.db, audit: ctx.audit, access: ctx.access, now: ctx.now };
  const actor = (req: FastifyRequest): admin.AdminActor => ({ pseudonymId: req.deskUser!.pseudonymId, ...accessFrom(req) });

  const demoWideLock: PreHandler = async (_req, reply) => {
    if (ctx.config.demoWide) return reply.code(403).send({ error: 'demo-locked', message: '넓게 연 시연에서는 운영 설정을 바꾸지 않아요' });
    return undefined;
  };
  const opsRead = [ctx.guards.user, ctx.guards.role('operator')];
  const opsWrite = [...opsRead, demoWideLock];

  app.get('/api/ops/mcp/clients', { preHandler: opsRead }, async (): Promise<McpClientSummary[]> => admin.listClients(ctx.db));

  app.post<{ Body: McpClientCreateRequest }>(
    '/api/ops/mcp/clients',
    {
      preHandler: opsWrite,
      schema: {
        body: {
          type: 'object',
          required: ['appName', 'kind', 'redirectUris'],
          additionalProperties: false,
          properties: {
            appName: { type: 'string', minLength: 1, maxLength: APP_NAME_MAX * 2 },
            kind: { enum: ['confidential', 'public'] },
            redirectUris: { type: 'array', minItems: 1, maxItems: MAX_REDIRECTS, items: { type: 'string', minLength: 1, maxLength: 500 } },
            demoOnly: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply): Promise<McpClientCreateResponse> => {
      // 비밀이 실린 응답이라 어디에도 캐시하지 않아요.
      reply.header('cache-control', 'no-store');
      return admin.addClient(deps, actor(req), req.body);
    },
  );

  app.put<{ Params: { clientId: string }; Body: { approved: boolean } }>(
    '/api/ops/mcp/clients/:clientId/approval',
    {
      preHandler: opsWrite,
      schema: {
        params: CLIENT_PARAMS,
        body: { type: 'object', required: ['approved'], additionalProperties: false, properties: { approved: { type: 'boolean' } } },
      },
    },
    async (req): Promise<McpClientSummary> => admin.setApproval(deps, actor(req), req.params.clientId, req.body.approved),
  );

  // 앱별 강제 끊기: 그 앱의 모든 연결. 사람별 끊기는 두지 않아요(admin.ts 머리 설명).
  app.post<{ Params: { clientId: string } }>(
    '/api/ops/mcp/clients/:clientId/disconnect',
    { preHandler: opsWrite, schema: { params: CLIENT_PARAMS } },
    async (req) => admin.disconnectClient(deps, actor(req), req.params.clientId),
  );

  // 회수: 클라이언트 삭제 → 승인 cascade로 모든 연결이 끊겨요.
  app.delete<{ Params: { clientId: string } }>('/api/ops/mcp/clients/:clientId', { preHandler: opsWrite, schema: { params: CLIENT_PARAMS } }, async (req) =>
    admin.revokeClient(deps, actor(req), req.params.clientId),
  );

  app.get('/api/ops/mcp/report', { preHandler: opsRead }, async (): Promise<McpReport> => admin.report(deps));
}
