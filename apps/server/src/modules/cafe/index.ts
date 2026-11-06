import type { AppContext } from '../../context';
import type { DeskModule, PlanHandler } from '../../core/module';
import { registerCafeRoutes } from './routes';
import { CafeDesk } from './service';

// F4 사내 카페 주문(11/6 사용자 결정, ADR-29, 출시 기본 끔). 모듈 종류는 cafeteria예요.
// 1묶음: 직원 주문(확인 시트 'cafeteria:order') → 카페 판(바리스타, 고정 버튼) → 건네기. 앞문 라우터·홈 채팅·MCP에는 아직 나오지 않아요.
// 2묶음: 매달 1일 청구·[입금 확인]·한 달 한도·미납 막기·청구 알림·보관 지우기·총무 정산(S9)·매출 합계 내려받기(billing.ts).
// 3묶음(11/6): [못 받았어요]·홈 채팅 주문·"이번 달 커피값" 카드(ctx.services.cafe로 홈에 줘요). 판 전용 세션은 공통 바닥(core/board-session.ts)이에요.
export function createCafeModule(ctx: AppContext): DeskModule {
  const desk = new CafeDesk(ctx);
  // 홈 채팅이 쓰는 읽기 기능(core/services.ts). 모두 읽기만 하고, 주문은 사람이 확인 시트에서 눌러야 들어가요.
  ctx.services.cafe = {
    menuWords: () => desk.menuWords(),
    orderCards: (user, text) => desk.orderCards(user, text),
    spendCard: (user) => desk.billing.spend(user),
  };
  return {
    kind: 'cafeteria',
    planHandlers: [desk.orderHandler() as PlanHandler<unknown>],
    register(app) {
      registerCafeRoutes(app, ctx, desk);
    },
    seed: () => desk.seed(),
    // 서버의 한 시간 회차(app.ts runRetention)에서 청구서 발행·청구 알림·보관 지우기를 같이 해요(최대 한 시간 늦을 수 있어요).
    // 보관(ADR-21 예외, ADR-29 사용자 승인): 취소 주문 7일, [입금 확인] 7일 뒤 청구서·그 달 주문, 한도 요청 7일, 늘린 한도는 그 달까지.
    retention: () => desk.billing.run(),
  };
}
