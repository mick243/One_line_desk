import type { ConnectionsResponse, ConsentDecisionRequest, ConsentDecisionResponse, ConsentInfo, McpScope } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import type { ConsentRequest, McpAuth } from './auth-service';
import { withParams } from './oauth-routes';
import { scopesOf } from './policy';
import * as repo from './repo';

// 앱 화면이 부르는 MCP 경로(M4): 동의 시트, S6 "연결된 AI 앱", [끊기].
// 모두 로그인 가드(세션·재직 재확인·CSRF)를 거쳐요.

const REQ_SCHEMA = { type: 'string', minLength: 1, maxLength: 2048 } as const;

export function registerMcpApiRoutes(app: FastifyInstance, ctx: AppContext, mcp: McpAuth) {
  /** 동의 시트에 보여 줄 도구 범위: 지금 켜진 도구 중 앱이 청한 것(청한 게 없으면 켜진 것 모두) */
  const consentScopes = async (request: ConsentRequest): Promise<McpScope[]> => {
    const available = scopesOf(await mcp.tools());
    return request.sc ? available.filter((s) => request.sc!.includes(s)) : available;
  };

  const allowedClient = async (request: ConsentRequest) => {
    const client = await repo.findClient(ctx.db, request.cid);
    return client && mcp.isClientAllowed(client) && client.redirectUris.includes(request.ru) ? client : null;
  };

  app.get<{ Querystring: { req: string } }>(
    '/api/mcp/consent',
    {
      preHandler: ctx.guards.user,
      schema: { querystring: { type: 'object', required: ['req'], additionalProperties: false, properties: { req: REQ_SCHEMA } } },
    },
    async (req): Promise<ConsentInfo> => {
      const opened = mcp.openConsentRequest(req.query.req);
      if (!opened.ok) return { status: opened.reason };
      const client = await allowedClient(opened.request);
      if (!client) return { status: 'not-allowed' };
      const tools = await consentScopes(opened.request);
      if (tools.length === 0) return { status: 'no-tools' };
      return { status: 'ready', appName: client.appName, redirectHost: new URL(opened.request.ru).host, tools, roomsWrite: ctx.ops.get().roomsWrite };
    },
  );

  // 동의 시트 [연결 허락]·[허락하지 않기]. 시트 자체가 확인이에요(R2). 허락하면 짧은 인가 코드만 만들고 DB에는 쓰지 않아요.
  app.post<{ Body: ConsentDecisionRequest }>(
    '/api/mcp/consent',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['req', 'decision'],
          additionalProperties: false,
          properties: { req: REQ_SCHEMA, decision: { enum: ['allow', 'deny'] } },
        },
      },
    },
    async (req): Promise<ConsentDecisionResponse> => {
      const user = req.deskUser!;
      const opened = mcp.openConsentRequest(req.body.req);
      if (!opened.ok) throw new DeskError('consent-expired', 409, '연결 요청 시간이 지났어요. AI 앱에서 다시 연결해 주세요');
      const request = opened.request;
      const client = await allowedClient(request);
      if (!client) throw new DeskError('not-allowed', 403, '회사가 허락하지 않은 앱이라 연결할 수 없어요');
      const back = (params: Record<string, string>) => withParams(request.ru, { ...params, state: request.st, iss: mcp.urls.issuer });

      if (req.body.decision === 'deny') {
        await ctx.audit.record({ pseudonymId: user.pseudonymId, channel: 'mcp', action: 'consent', clientId: client.clientId, result: 'denied' });
        return { result: 'denied', redirectTo: back({ error: 'access_denied' }) };
      }
      const scopes = await consentScopes(request);
      if (scopes.length === 0) throw new DeskError('no-tools', 409, '지금 연결할 수 있는 도구가 없어요');
      const code = mcp.issueCode(request, user, scopes);
      await ctx.audit.record({ pseudonymId: user.pseudonymId, channel: 'mcp', action: 'consent', clientId: client.clientId, result: 'allowed' });
      return { result: 'allowed', redirectTo: back({ code }) };
    },
  );

  // S6 "연결된 AI 앱": 앱 이름·연결한 날·범위. "마지막 사용"은 없어요(M4).
  app.get('/api/mcp/connections', { preHandler: ctx.guards.user }, async (req): Promise<ConnectionsResponse> => {
    const tools = scopesOf(await mcp.tools());
    const grants = await repo.listGrantsWithApp(ctx.db, req.deskUser!.pseudonymId);
    return {
      available: tools.length > 0,
      tools,
      apps: grants.map((g) => ({ clientId: g.clientId, appName: g.appName, connectedOn: g.connectedOn, scopes: g.scopes })),
    };
  });

  // [끊기]: 확인 시트를 거친 고정 버튼 쓰기예요. 그 앱의 승인(갱신 토큰)을 바로 지워요(ADR-03·15).
  app.delete<{ Params: { clientId: string } }>(
    '/api/mcp/connections/:clientId',
    {
      preHandler: ctx.guards.user,
      schema: {
        params: {
          type: 'object',
          required: ['clientId'],
          additionalProperties: false,
          properties: { clientId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,100}$' } },
        },
      },
    },
    async (req) => {
      const user = req.deskUser!;
      const removed = await ctx.fixed.run(user, {
        module: 'mcp',
        action: 'disconnect',
        resultCode: (n: number) => (n > 0 ? 'done' : 'none'),
        run: (q) => repo.deleteGrant(q, user.pseudonymId, req.params.clientId),
      });
      return { ok: true, removed };
    },
  );
}
