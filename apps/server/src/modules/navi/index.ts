import { recordCutoff } from '@one-line-desk/shared';
import type { AppContext } from '../../context';
import type { DeskModule } from '../../core/module';
import { createInquiryService } from './inquiries';
import * as repo from './repo';
import { registerNaviRoutes } from './routes';
import { createNaviService } from './service';

// F1 담당 안내(ADR-09, R8·R9).
// - 묻기: 분장표 후보 검색 → LLM은 후보 번호 하나 또는 none → 그 행 원문으로 담당 카드(사람 이름 없음)
// - "틀렸어요" 기록: 묻기와 다른 피드백 경로, 여섯 칸만, 사용자 ID 없음
// - S5: 분장표 주인이 자기 부서 행의 기록 묶음을 보고, 파일을 다시 올려(확인 시트) 반영해요
// - 문의 보내기(ADR-16): 담당 카드 [○○에 문의하기] → 확인 시트 → 주인 부서 받은 문의함 + 앱 안 알림
export function createNaviModule(ctx: AppContext): DeskModule {
  const navi = createNaviService(ctx);
  const inquiries = createInquiryService(ctx);
  // 분장표 주인 역할 계산(core/guard.ts)이 이걸 써요.
  ctx.services.navi = { ownerDepartments: () => navi.ownerDepartments() };

  return {
    kind: 'navi',
    ask: (input) => navi.ask(input),
    register: (app) => registerNaviRoutes(app, ctx, navi, inquiries),
    seed: () => navi.seed(),
    adapters: () => [{ name: 'mock-chart', label: '업무 분장표(가상 분장표)', mock: true }],
    // 보관 기간(7일, 10/28): 문의와 "틀렸어요" 기록
    async retention() {
      await inquiries.purge();
      await repo.purgeFeedback(ctx.db, recordCutoff(ctx.now()));
    },
  };
}
