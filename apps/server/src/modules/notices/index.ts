import type { AppContext } from '../../context';
import type { DeskModule } from '../../core/module';
import { createAudienceService } from './audience-service';
import { ALLOWED_BOARDS } from './fixtures';
import { registerNoticeRoutes } from './routes';
import { createNoticesService } from './service';

// F1 공지 찾기(ADR-09·14, M6). 허용 게시판 사본의 색인만 두고, 제목·게시일·원문 링크만 내보내요.
// 요약은 만들지 않아요. 11/5부터 공지 카드에 질문에 맞는 원문 한 줄을 그대로 붙여요(AI는 문장 번호만 골라요, quote.ts).
// MCP notices_search는 ctx.services.notices.search를 불러서 제목·게시일·원문 링크만이에요.
// 11/6 새 공지 알림 대상(ADR-09 개정): 사본 갱신(ingest)으로 새 공지가 들어오면 AI가 대상을 제안하고(audience.ts),
// 총무가 확인해야 대상자에게 내용 없는 알림이 가요(audience-service.ts). 제안·확인 줄은 7일 뒤 retention이 지워요.
export function createNoticesModule(ctx: AppContext): DeskModule {
  const notices = createNoticesService(ctx);
  const audience = createAudienceService(ctx);
  // 규정 한 줄(11/6 휴가 A안): 휴가 신청 전 카드가 허용 게시판 공지의 원문 문장 하나를 붙일 때 불러요(낱말 규칙만).
  ctx.services.notices = {
    search: (query, limit) => notices.search(query, limit),
    boards: () => [...ALLOWED_BOARDS],
    ruleLine: (query, mustHave) => notices.ruleLine(query, mustHave),
    // 게시판 사본 갱신(11/6): 새 공지면 색인에 넣고 알림 대상을 제안해요. 이미 있거나 허용 밖이면 아무것도 하지 않아요.
    async ingest(n) {
      if (!(await notices.ingest(n))) return { copied: false, audience: null };
      return { copied: true, audience: await audience.onNewNotice(n) };
    },
  };

  return {
    kind: 'notices',
    ask: (input) => notices.ask(input),
    register: (app) => registerNoticeRoutes(app, ctx, audience),
    seed: () => notices.seed(),
    adapters: () => [{ name: 'mock-notices', label: '공지 게시판 사본(가상 공지)', mock: true }],
    // 알림 대상 줄 7일 + 시연 가상 게시판에서 들어온 공지 사본 7일(11/7, 방문자 글이라 기록 7일 원칙)
    retention: async () => {
      await audience.purge();
      await notices.purgeDemoBoardCopies();
    },
  };
}
