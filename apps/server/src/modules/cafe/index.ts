import type { AppContext } from '../../context';
import type { DeskModule, PlanHandler } from '../../core/module';
import { registerCafeRoutes } from './routes';
import { CafeDesk } from './service';

// F4 사내 카페 주문(11/6 사용자 결정, ADR-29, 출시 기본 끔). 모듈 종류는 cafeteria예요.
// 1묶음: 직원 주문(확인 시트 'cafeteria:order') → 카페 판(바리스타, 고정 버튼) → 건네기. 앞문 라우터·홈 채팅·MCP에는 아직 나오지 않아요.
// 청구·입금 확인·한도·미납·총무 정산·판 전용 세션·AI 채팅 주문은 다음 묶음이에요.
export function createCafeModule(ctx: AppContext): DeskModule {
  const desk = new CafeDesk(ctx);
  return {
    kind: 'cafeteria',
    planHandlers: [desk.orderHandler() as PlanHandler<unknown>],
    register(app) {
      registerCafeRoutes(app, ctx, desk);
    },
    seed: () => desk.seed(),
    // 보관: 취소한 주문만 7일 뒤 지워요. 다른 주문은 청구·입금 확인 뒤 지우기(다음 묶음, ADR-29 사용자 승인 예외)까지 남아요.
    retention: () => desk.purge(),
  };
}
