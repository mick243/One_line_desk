import type {
  ConnectionsResponse,
  ConsentDecisionRequest,
  ConsentDecisionResponse,
  ConsentInfo,
  LinkOpenRequest,
  LinkOpenResponse,
  McpScope,
} from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import { accessFrom } from '../../core/access-record';
import { DeskError } from '../../core/errors';
import type { LeaveLink, RentLink } from '../../core/services';
import type { ConsentRequest, McpAuth } from './auth-service';
import { withParams } from './oauth-routes';
import { redirectMatches, scopesOf } from './policy';
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
    return client && mcp.isClientAllowed(client) && redirectMatches(client, request.ru) ? client : null;
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
      await ctx.access.record({ pseudonymId: user.pseudonymId, action: 'mcp.connect', ...accessFrom(req) });
      return { result: 'allowed', redirectTo: back({ code }) };
    },
  );

  // S6 "연결된 AI 앱": 앱 이름·연결한 날·범위·기기 수. "마지막 사용"은 없어요(M4).
  // "연결하는 법": 회사가 허락한 CLI 앱과 MCP 주소(11/2, U1~U3).
  app.get('/api/mcp/connections', { preHandler: ctx.guards.user }, async (req): Promise<ConnectionsResponse> => {
    const tools = scopesOf(await mcp.tools());
    const cliApps = tools.length > 0 ? (await repo.listPublicClients(ctx.db)).filter((c) => mcp.isClientAllowed(c)) : [];
    return {
      available: tools.length > 0,
      tools,
      apps: await repo.listAppsFor(ctx.db, req.deskUser!.pseudonymId),
      mcpUrl: mcp.urls.resource,
      cliApps: cliApps.map((c) => ({ clientId: c.clientId, appName: c.appName })),
    };
  });

  // 앱 확인 링크(/r/<토큰>)가 무엇을 여는지(11/3). 토큰 주인만 열어요. 링크를 연 것만으로는 아무것도 쓰지 않아요(plan도 만들지 않아요).
  // 회의실 링크는 화면이 /api/rooms/recheck로 다시 확인하고, 문의 링크는 그 팀 문의 양식을 빈 칸으로 열어요(질문 글은 링크에 없어요, R13).
  // 11/3 확인 링크 넓히기: 휴가 준비(양식을 그 날짜·종류로 채워 열기)·판 품목(+1은 고정 버튼)·새 요청(쓰기 칸 빈 채)·장비 대여(다시 확인한 카드).
  // 링크 토큰에는 구조 값만 있고, 남은 연차 같은 본인 자료는 여기서 본인 로그인으로 다시 읽어 이 화면에만 보내요(ADR-18).
  app.post<{ Body: LinkOpenRequest }>(
    '/api/mcp/link',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['proposalToken'],
          additionalProperties: false,
          properties: { proposalToken: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
      },
    },
    async (req): Promise<LinkOpenResponse> => {
      const user = req.deskUser!;
      const opened = ctx.plans.peek(user, req.body.proposalToken);
      const settings = ctx.ops.get();
      const link = `${opened.module}:${opened.action}`;
      switch (link) {
        case 'rooms:reserve':
          return { kind: 'rooms' };
        case 'navi:inquire': {
          if (settings.modules.navi === 'off' || !ctx.services.navi?.mcp) return { kind: 'off' };
          if (opened.expired) return { kind: 'expired' };
          const target = await ctx.services.navi.mcp.inquiryTarget((opened.params as { rowId: string | null }).rowId);
          return target ? { kind: 'inquiry', ...target } : { kind: 'gone' };
        }
        case 'navi:leave-link': {
          if (settings.modules.navi === 'off' || !ctx.services.navi?.mcp) return { kind: 'off', about: 'leave' };
          if (opened.expired) return { kind: 'expired', about: 'leave' };
          const action = await ctx.services.navi.mcp.leaveTarget(user, opened.params as LeaveLink);
          return action ? { kind: 'leave', action } : { kind: 'gone', about: 'leave' };
        }
        case 'pantry:board-link': {
          if (settings.modules.pantry !== 'on' || !ctx.services.pantry?.mcp) return { kind: 'off', about: 'pantry' };
          if (opened.expired) return { kind: 'expired', about: 'pantry' };
          const cardId = (opened.params as { cardId: number | null }).cardId;
          if (cardId === null) return { kind: 'pantry-new' };
          const cards = await ctx.services.pantry.mcp.linkCards(user, cardId);
          return cards ? { kind: 'pantry', cards } : { kind: 'gone', about: 'pantry' };
        }
        case 'rooms:rent-link': {
          const equipment = ctx.services.rooms?.equipment;
          if (settings.modules.rooms !== 'on' || !settings.roomsWrite || !equipment) return { kind: 'off', about: 'equipment' };
          if (opened.expired) return { kind: 'expired', about: 'equipment' };
          return { kind: 'equipment', cards: await equipment.linkCards(user, opened.params as RentLink) };
        }
        default:
          throw new DeskError('bad-request', 400, '앱 확인 링크가 아니에요');
      }
    },
  );

  // [끊기]: 확인 시트를 거친 고정 버튼 쓰기예요. 그 앱의 모든 기기 승인(갱신 토큰)을 바로 지워요(ADR-03·15).
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
      if (removed > 0) await ctx.access.record({ pseudonymId: user.pseudonymId, action: 'mcp.disconnect', ...accessFrom(req) });
      return { ok: true, removed };
    },
  );
}
