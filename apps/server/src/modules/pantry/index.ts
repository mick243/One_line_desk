import { recordCutoff } from '@one-line-desk/shared';
import type { AppContext } from '../../context';
import type { DeskModule, PlanHandler } from '../../core/module';
import { boardLinkHandler, createPantryMcpRead } from './mcp-read';
import { registerOrderRoutes } from './order';
import * as repo from './repo';
import { registerBoardRoutes } from './routes';
import { createBoardService } from './service';

// F3 같이 채워요(ADR-04·07·08). 판·게시·표·합치기는 board 쪽(service·routes), 주문안·주기는 order/ 쪽이 맡아요.
export function createPantryModule(ctx: AppContext): DeskModule {
  const board = createBoardService(ctx);
  // MCP 탕비실 요청 찾기(11/3 확인 링크 넓히기)는 mcp로만 불러요.
  // 홈 "나에게 해당하는 일"(ADR-27)은 home으로 내 요청 상태만 읽어요.
  ctx.services.pantry = { mcp: createPantryMcpRead(ctx, board), home: { myRequests: (user) => board.myRequests(user) } };
  return {
    kind: 'pantry',
    ask: (input) => board.ask(input),
    // MCP 판 앱 링크 토큰(열어 보기만, 실행 없음)
    planHandlers: [board.postHandler, boardLinkHandler as PlanHandler<unknown>],
    register(app) {
      registerBoardRoutes(app, ctx, board);
      registerOrderRoutes(app, ctx);
    },
    seed: () => board.seed(),
    adapters: () => [{ name: 'mock-catalog', label: '탕비실 구매 카탈로그(가상 품목·가격)', mock: true }],
    // 보관 기간(7일, 10/28): 요청 카드·표·합치기·주문안
    retention: () => ctx.db.tx((q) => repo.purgeRecords(q, recordCutoff(ctx.now()))),
  };
}
