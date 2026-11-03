import { checkInput } from '@one-line-desk/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import type { PlanHandler } from '../../core/module';
import type { PantryMcpRead } from '../../core/services';
import { findBundleRoot } from './bundles';
import { linkedItemCard } from './cards';
import * as repo from './repo';
import type { BoardService } from './service';
import { similarByRule } from './similarity';

// MCP 탕비실 요청 찾기가 쓰는 pantry 읽기 함수(11/3 확인 링크 넓히기 · ADR-14 개정).
// MCP 모듈은 ctx.services.pantry.mcp로만 불러요(모듈 경계). 여기서는 LLM을 부르지 않고 이름 규칙만 써요.
// - 찾는 품목 이름은 이 함수 메모리에서만 쓰고 저장·로그·감사·링크에 넣지 않아요(ADR-10, R13).
// - 읽기 전용 트랜잭션(ADR-04)이라 판 표에 쓰지 못해요.
// - 판 링크 토큰은 'pantry:board-link' 처리기로 봉인하고 카드 ID만 담아요(새 요청은 null). 이 처리기는 실행하지 않아요:
//   링크는 판 품목을 보여 주거나 요청 쓰기 칸을 빈 채로 열 뿐이고, +1은 품목 카드의 [여기에 +1](고정 버튼)이에요.

const MAX_ITEMS = 3;

const BoardLinkSchema = z.object({ cardId: z.number().int().min(1).nullable() }).strict();
type BoardLink = z.infer<typeof BoardLinkSchema>;

const LINK_ONLY = () => new DeskError('bad-request', 400, '이 링크는 같이 채워요 판을 여는 링크예요. 판에서 직접 눌러 주세요');

/** 판 앱 링크 토큰 처리기. 열어 보기(peek)만 되고, plan 만들기·바로 실행·자동 실행은 모두 막혀요. */
export const boardLinkHandler: PlanHandler<BoardLink> = {
  module: 'pantry',
  action: 'board-link',
  schema: BoardLinkSchema,
  enabled: () => false,
  async sheet() {
    throw LINK_ONLY();
  },
  async execute() {
    throw LINK_ONLY();
  },
};

export function createPantryMcpRead(ctx: AppContext, board: Pick<BoardService, 'readOnly' | 'openBundlesOn'>): PantryMcpRead {
  return {
    async findSimilar(floor, itemName) {
      const checked = checkInput(itemName.trim());
      if (checked.locks.length) return { locked: checked.locks[0]!.message, items: [] };
      const snap = await board.readOnly(async (q) => ({ open: await board.openBundlesOn(q, floor), catalog: await repo.catalog(q) }));
      const same = new Set(similarByRule(checked.text, snap.open.candidates, snap.catalog));
      const items = snap.open.bundles
        .filter((b) => same.has(b.bundleId))
        .sort((x, y) => y.votes - x.votes || x.bundleId - y.bundleId)
        .slice(0, MAX_ITEMS)
        .map((b) => ({ cardId: b.bundleId, name: b.name, votes: b.votes }));
      return { items };
    },

    proposeBoardLink(user, cardId) {
      return ctx.plans.propose(user, 'pantry', 'board-link', { cardId });
    },

    /** 내 층 열린 묶음만 보여 줘요. 합쳐졌으면 지금 대표로 따라가요. 닫혔거나 다른 층이면 null이에요. */
    async linkCards(user, cardId) {
      const found = await board.readOnly(async (q) => {
        const root = await findBundleRoot(q, cardId);
        if (root === null) return null;
        const open = await board.openBundlesOn(q, user.floor);
        const bundle = open.bundles.find((b) => b.bundleId === root);
        if (!bundle) return null;
        const mine = await repo.myVotedCardIds(q, user.pseudonymId, bundle.cardIds);
        return { bundleId: bundle.bundleId, name: bundle.name, votes: bundle.votes, myVote: mine.length > 0 };
      });
      return found ? [linkedItemCard(found)] : null;
    },
  };
}
