import type { AppContext } from '../../context';
import type { DeskModule } from '../../core/module';
import { McpAuth } from './auth-service';
import { registerMcpRoute } from './mcp-route';
import { registerOauthRoutes } from './oauth-routes';
import * as repo from './repo';
import { registerMcpApiRoutes } from './routes';
import { hashClientSecret } from './tokens';

// 읽기 전용 MCP(ADR-14·15): 인가 서버, /mcp, 도구 둘, 동의 시트·연결된 AI 앱 경로.
// 다른 모듈은 ctx.services.rooms·notices로만 불러요. 쓰기 도구는 없고, MCP 경로는 LLM을 부르지 않아요.

/**
 * 시연용 가상 클라이언트(claude.ai 조직 커넥터 흉내). 보안팀 승인은 없고 demo_only라서
 * 데이터가 모두 모의(등급 0)일 때만 허용 목록 안이에요. 비밀은 개발용 값이에요.
 */
export const DEMO_CLIENT = {
  clientId: 'desk-demo-claude-org',
  clientSecret: 'dev-only-mcp-demo-client-secret-change-me',
  appName: 'Claude',
  redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
} as const;

export function createMcpModule(ctx: AppContext): DeskModule {
  const mcp = new McpAuth(ctx);
  // 모든 기기 로그아웃·퇴사 확인(core/guard.ts endEverything)이 그 사람의 MCP 승인을 모두 지워요.
  ctx.services.mcp = { revokeAll: (pseudonymId) => mcp.revokeAll(pseudonymId), canEnable: () => mcp.canEnable() };

  return {
    kind: 'mcp',
    register(app) {
      registerOauthRoutes(app, ctx, mcp);
      registerMcpRoute(app, ctx, mcp);
      registerMcpApiRoutes(app, ctx, mcp);
    },
    async seed() {
      // 운영 환경에는 개발용 비밀을 가진 클라이언트를 넣지 않아요(모의 로그인을 연 시연 배포만 빼고). 운영자가 보안팀 승인 목록에서 등록해요.
      if (ctx.config.production && !ctx.config.mockLogin) return;
      await repo.insertClient(ctx.db, {
        clientId: DEMO_CLIENT.clientId,
        secretHash: hashClientSecret(DEMO_CLIENT.clientSecret),
        appName: DEMO_CLIENT.appName,
        redirectUris: [...DEMO_CLIENT.redirectUris],
        securityApproved: false,
        demoOnly: true,
      });
    },
  };
}
