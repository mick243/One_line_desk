import type { AppContext } from '../../context';
import type { DeskModule, PlanHandler } from '../../core/module';
import { MockRoomLedger } from './ledger-adapter';
import { registerRoomRoutes } from './routes';
import { RoomDesk, slotsToQuery } from './service';

// F2 회의실 찾고 확인 예약(ADR-03·05·06·14).
// - 찾기(/ask, 조건 칩 다시 찾기, 앱 확인 링크)는 읽기만 하고 제안 토큰만 붙여요.
// - 예약은 'rooms:reserve' plan(확인 시트 한 번), 취소는 고정 버튼(확인 시트 뒤)뿐이에요.
// - MCP는 ctx.services.rooms로 빈 방 후보와 제안 토큰만 받아요.
export function createRoomsModule(ctx: AppContext): DeskModule {
  const ledger = new MockRoomLedger();
  const desk = new RoomDesk(ctx, ledger);

  ctx.services.rooms = {
    findFree: (query) => desk.findFree(query),
    proposeReservation: (user, candidate) => desk.proposeReservation(user, candidate),
  };

  return {
    kind: 'rooms',
    async ask({ slots, aiParsed, user }) {
      const query = slotsToQuery(slots, ctx.ops.get().values.defaultMeetingMinutes);
      const { cards, found } = await desk.cards(query, user, {
        headline: '이 조건으로 찾았어요',
        evidence: '내가 쓴 문장에서 뽑은 조건 · 칩을 고치면 다시 찾아요',
        aiSummarized: aiParsed,
        wrong: true,
      });
      return { cards, found };
    },
    planHandlers: [desk.reserveHandler() as PlanHandler<unknown>],
    register(app) {
      registerRoomRoutes(app, ctx, desk);
    },
    seed: () => desk.seed(),
    adapters: () => [ledger.capabilities],
  };
}
