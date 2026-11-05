import type { AppContext } from '../../context';
import type { DeskModule } from '../../core/module';
import { ALLOWED_BOARDS } from './fixtures';
import { createNoticesService } from './service';

// F1 공지 찾기(ADR-09·14, M6). 허용 게시판 사본의 색인만 두고, 제목·게시일·원문 링크만 내보내요.
// 요약은 만들지 않아요. 11/5부터 공지 카드에 질문에 맞는 원문 한 줄을 그대로 붙여요(AI는 문장 번호만 골라요, quote.ts).
// MCP notices_search는 ctx.services.notices.search를 불러서 제목·게시일·원문 링크만이에요.
export function createNoticesModule(ctx: AppContext): DeskModule {
  const notices = createNoticesService(ctx);
  ctx.services.notices = { search: (query, limit) => notices.search(query, limit), boards: () => [...ALLOWED_BOARDS] };

  return {
    kind: 'notices',
    ask: (input) => notices.ask(input),
    seed: () => notices.seed(),
    adapters: () => [{ name: 'mock-notices', label: '공지 게시판 사본(가상 공지)', mock: true }],
  };
}
