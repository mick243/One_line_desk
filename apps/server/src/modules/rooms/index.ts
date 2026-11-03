import { recordCutoff } from '@one-line-desk/shared';
import type { AppContext } from '../../context';
import type { DeskModule, PlanHandler } from '../../core/module';
import { RoomChat } from './chat';
import { RoomEquipment, rentLinkHandler } from './equipment';
import { MockRoomLedger } from './ledger-adapter';
import * as repo from './repo';
import { registerRoomRoutes } from './routes';
import { RoomDesk, slotsToQuery } from './service';

// F2 회의실 찾고 확인 예약(ADR-03·05·06·14).
// - 찾기(/ask, 조건 칩 다시 찾기, 앱 확인 링크)는 읽기만 하고 제안 토큰만 붙여요.
// - 예약은 'rooms:reserve' plan(확인 시트 한 번), 취소는 고정 버튼(확인 시트 뒤)뿐이에요.
// - MCP는 ctx.services.rooms로 빈 회의실 후보와 제안 토큰만 받아요.
// - 회의실 채팅(ADR-19): 시킨 예약·장비 대여는 자동 실행 허용 목록(PlanService.auto), 대여 취소·반납은 고정 버튼이에요.
export function createRoomsModule(ctx: AppContext): DeskModule {
  const ledger = new MockRoomLedger();
  const desk = new RoomDesk(ctx, ledger);
  const equipment = new RoomEquipment(ctx);
  const chat = new RoomChat(ctx, desk, equipment);

  ctx.services.rooms = {
    findFree: (query) => desk.findFree(query),
    proposeReservation: (user, candidate) => desk.proposeReservation(user, candidate),
    myReservations: (user) => desk.myReservations(user),
    equipment: equipment.mcpRead(),
    // 홈 "나에게 해당하는 일"(ADR-27): 내 대여·초대받은 회의 읽기만
    home: { myLoans: (user) => equipment.myLoans(user), invited: (user) => desk.invites.invited(user) },
    // 홈 "같은 팀 일정"(11/3): 같은 부서 사람의 회의 시간·회의실 이름만. 제목·참석자·부른 사람은 없어요(ADR-06 같은 팀 예외).
    team: { meetingsOf: (pseudonymIds, from, to) => repo.teamMeetings(ctx.db, pseudonymIds, from, to) },
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
    // 'rooms:rent-link'은 MCP 장비 대여 링크 토큰이에요(열어 보기만, 실행 없음).
    planHandlers: [desk.reserveHandler() as PlanHandler<unknown>, equipment.rentHandler() as PlanHandler<unknown>, rentLinkHandler as PlanHandler<unknown>],
    register(app) {
      registerRoomRoutes(app, ctx, desk, equipment, chat);
    },
    async seed() {
      await desk.seed();
      await equipment.seed();
    },
    adapters: () => [ledger.capabilities],
    // 보관 기간(7일, 10/28): 끝난 예약·대여, 취소 이력
    retention: () => repo.purgeRecords(ctx.db, recordCutoff(ctx.now())),
  };
}
