import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type BoardItem,
  type BoardResponse,
  type Card,
  checkItemName,
  type FloorSetting,
  type MergeRequest,
  type MergeResponse,
  type MergesResponse,
  type MergeSuggestion,
  type MyRequestItem,
  type MyRequestsResponse,
  PANTRY_ITEM_NAME_MAX,
  PANTRY_TEXT,
  type PantrySettingsResponse,
  type PantrySettingsUpdate,
  type SuggestionsResponse,
  type VoteResponse,
} from '@one-line-desk/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import type { Queryable } from '../../core/db';
import { DeskError, notFound } from '../../core/errors';
import type { AskInput, AskOutcome, ExecContext, ExecOutcome, PlanHandler } from '../../core/module';
import { extractItemName } from '../../core/slots';
import type { DeskUser } from '../../core/user';
import { type Bundle, bundleMemberIds, cardRoots, countVotedOpenBundles, findBundleRoot, listOpenBundles } from './bundles';
import * as cards from './cards';
import { CATALOG_FIXTURES, DEFAULT_FLOOR_SETTING, DEMO_FLOORS } from './fixtures/catalog';
import * as repo from './repo';
import { type Candidate, collectPairs, extractDraft, judgeName, matchCatalogByRule, orderPair, similarByRule } from './similarity';

// F3 같이 채워요 판(ADR-04·07, R2·R3·R14·R15). 주문안(order/)은 listOpenBundles를 읽기만 해요.
// 쓰기 길: 게시 = 공개 미리보기 바로 실행 plan('pantry:post'), +1·거두기·따로 두기·합치기·되돌리기·설정 = ctx.fixed.run().
// 초안(/ask·/pantry/draft)은 읽기 전용 트랜잭션에서만 DB를 읽어요. 판 표에 쓸 길이 없어요(ADR-04).

/**
 * 게시 plan 매개변수. 제안 토큰 안에는 서버가 서명한 ID·참거짓·HMAC만 넣고, 글자는 넣지 않아요(H2, R13).
 * itemName은 사용자가 미리보기에서 확정한 이름이에요. 토큰에는 없고 [올리기] 요청의 edits로만 와요.
 */
export const PostParams = z.object({
  itemName: z.string().min(1).max(PANTRY_ITEM_NAME_MAX),
  floor: z.string().max(10),
  /** 카드 하나 = 이 값 하나(멱등) */
  postKey: z.uuid(),
  /** 초안에서 보여 준 이름의 HMAC. 이름을 고쳤는지만 알아봐요. 막힌 뒤 다시 쓰는 토큰은 null이에요. 실행 뒤 plan 행에는 남기지 않아요. */
  nameMac: z.string().max(64).nullable(),
  catalogItemId: z.string().max(60).nullable(),
  /** 초안에서 사용자에게 보여 준 "같아 보이는" 묶음(대표 카드 ID). 이건 다시 막지 않아요. */
  seen: z.array(z.number().int().positive()).max(20),
  /** 그중 AI만 고른 것. 이름을 안 고쳤으면 표시 행(출처 'ai')을 만들어요. */
  aiSeen: z.array(z.number().int().positive()).max(20),
});
export type PostParams = z.infer<typeof PostParams>;

type PostDraft = Omit<PostParams, 'postKey' | 'itemName'>;

/** 대표 카드를 잠그는 사이 합치기·되돌리기가 끝나 대표가 바뀌면 트랜잭션을 처음부터 다시 해요. 그 횟수 상한이에요. */
const MAX_BUNDLE_TRIES = 5;

/** +1·거두기가 대표 카드를 잠그는 사이 묶음 대표가 바뀌었어요(안에서만 쓰고 밖으로 나가지 않아요). */
class BundleMoved extends Error {}

async function retryWhenBundleMoved<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof BundleMoved)) throw e;
      if (attempt >= MAX_BUNDLE_TRIES) throw new DeskError('in-progress', 409, '품목이 바뀌는 중이에요. 판을 새로 불러와 주세요');
    }
  }
}

const conflict = () => new DeskError('conflict', 409, PANTRY_TEXT.conflict);
const featureOff = () => new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
const unique = <T>(xs: T[]) => [...new Set(xs)];
const iso = (at: number) => new Date(at).toISOString();

/** 대표 카드 고르기(ADR-07): 카탈로그에 맞춘 카드, 같으면 먼저 만든 카드예요. */
export function chooseRepresentative<T extends { id: number; catalogItemId: string | null; createdAt: string }>(a: T, b: T): T {
  if ((a.catalogItemId !== null) !== (b.catalogItemId !== null)) return a.catalogItemId !== null ? a : b;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? a : b;
  return a.id < b.id ? a : b;
}

export type BoardService = ReturnType<typeof createBoardService>;

export function createBoardService(ctx: AppContext) {
  const isFacilities = (u: DeskUser) => u.roles.includes('facilities');
  const requireFacilities = (u: DeskUser) => {
    if (!isFacilities(u)) throw new DeskError('forbidden', 403, '이 일을 할 권한이 없어요');
  };
  const assertOn = () => {
    if (ctx.ops.get().modules.pantry !== 'on') throw featureOff();
  };

  /** 읽기 전용 트랜잭션(ADR-04). 이 안에서는 DB가 INSERT·UPDATE·DELETE를 거부해요. LLM은 이 밖에서만 불러요. */
  async function readOnly<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return ctx.db.tx(async (q) => {
      await q.query('set transaction read only');
      return fn(q);
    });
  }

  async function limitFor(q: Queryable, floor: string): Promise<number> {
    return (await repo.floorSetting(q, floor))?.perPersonLimit ?? DEFAULT_FLOOR_SETTING.perPersonLimit;
  }

  /** 층의 열린 묶음과 비교 후보(묶음 안 이름들·카탈로그) */
  async function openBundlesOn(q: Queryable, floor: string) {
    const bundles = await listOpenBundles(q, floor);
    const rows = await repo.cardsByIds(
      q,
      bundles.flatMap((b) => b.cardIds),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const bundleOf = new Map<number, number>();
    for (const b of bundles) for (const id of b.cardIds) bundleOf.set(id, b.bundleId);
    const candidates: Candidate[] = bundles.map((b) => {
      const members = b.cardIds.map((id) => byId.get(id)).filter((m): m is repo.CardRow => m !== undefined);
      return {
        id: b.bundleId,
        names: unique([b.name, ...members.map((m) => m.itemName)]),
        catalogItemIds: unique(members.map((m) => m.catalogItemId).filter((c): c is string => c !== null)),
      };
    });
    return { bundles, byId, bundleOf, candidates };
  }

  function propose(user: DeskUser, draft: PostDraft): string {
    const params: Omit<PostParams, 'itemName'> = { ...draft, postKey: randomUUID() };
    return ctx.plans.propose(user, 'pantry', 'post', params);
  }

  /** 이름 HMAC. 토큰에 이름 글자 대신 넣어 "이름을 안 고쳤는지"만 알아봐요(H2). 비밀 값이 없으면 되돌릴 수 없어요. */
  function nameMac(name: string): string {
    return createHmac('sha256', ctx.config.proposalSecret).update(`pantry-draft-name:${name}`).digest('base64url');
  }

  function sameMac(name: string, mac: string | null): boolean {
    if (mac === null) return false;
    const a = Buffer.from(nameMac(name));
    const b = Buffer.from(mac);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** 막힘 카드. 재시도 토큰에도 막힌 이름·그 HMAC을 넣지 않아요(H2). 이 카드는 plan 결과·영수증에 저장돼요. */
  function blockedOutcomeCard(user: DeskUser, message: string, seen: number[]): Card {
    const retry = propose(user, { floor: user.floor, nameMac: null, catalogItemId: null, seen, aiSeen: [] });
    return cards.blockedNameCard({ message, proposalToken: retry });
  }

  // ── 게시 초안(읽기만) ─────────────────────────────────────────────────────

  /**
   * 품목 이름 → 같은 품목 카드(먼저) 또는 공개 미리보기 카드. 아무것도 저장하지 않아요.
   * nameByAi는 이름을 실제 모델이 뽑았는지예요(미리보기 "AI 정리").
   */
  async function draftForName(user: DeskUser, name: string, nameByAi = false): Promise<Card[]> {
    const snap = await readOnly(async (q) => {
      const open = await openBundlesOn(q, user.floor);
      const mine = new Set(
        await repo.myVotedCardIds(
          q,
          user.pseudonymId,
          open.bundles.flatMap((b) => b.cardIds),
        ),
      );
      return {
        ...open,
        mine,
        catalog: await repo.catalog(q),
        myCount: await countVotedOpenBundles(q, user.pseudonymId),
        limit: await limitFor(q, user.floor),
      };
    });
    const judged = await judgeName(ctx.gateway, name, snap.candidates, snap.catalog);
    // 토큰에는 이름 글자 대신 HMAC만 넣어요(H2). 이름은 카드 행동(응답)에만 있고 [올리기] 때 edits로 돌아와요.
    const draft: PostDraft = {
      floor: user.floor,
      nameMac: nameMac(name),
      catalogItemId: judged.catalogItemId,
      seen: judged.same.slice(0, 20),
      aiSeen: judged.aiOnly.slice(0, 20),
    };
    const top = topBundle(snap.bundles, judged.same);
    if (top) {
      const target = { bundleId: top.bundleId, name: top.name, votes: top.votes, myVote: top.cardIds.some((id) => snap.mine.has(id)) };
      return [cards.sameItemCard({ target, newRequest: { proposalToken: propose(user, draft), itemName: name }, aiSummarized: judged.viaAi })];
    }
    return [cards.previewCard({ name, proposalToken: propose(user, draft), limitFull: snap.myCount >= snap.limit, aiSummarized: nameByAi })];
  }

  /** S3 요청 쓰기 칸(POST /api/pantry/draft). 글은 공통 검사를 지나 가린 뒤예요. 등급 1이라 무보관 계약 전에는 이름 규칙으로 뽑아요(H1). */
  async function draftFromText(user: DeskUser, text: string): Promise<Card[]> {
    const extracted = await extractDraft(ctx.gateway, text);
    if (!extracted.pantryRequest) return [cards.moveToNaviCard(ctx.ops.get().modules.navi !== 'on', extracted.viaAi)];
    if (!extracted.itemName) return [cards.noNameCard(false, extracted.viaAi)];
    return draftForName(user, extracted.itemName, extracted.viaAi);
  }

  /**
   * 묻기에서 탕비실 의도(F1-10). 라우터가 뽑은 품목 이름을 쓰고, 없으면 규칙으로만 뽑아요(묻기 원문을 AI로 다시 보내지 않아요).
   * 이름 비교(judgeName)도 등급 1이라 무보관 계약 전에는 이름 규칙으로만 해요(H1). "AI 정리"는 라우터가 모델로 뽑았을 때(aiParsed)만이에요.
   */
  async function ask({ text, slots, aiParsed, user }: AskInput): Promise<AskOutcome> {
    const fromSlots = slots.itemName?.trim() || undefined;
    const name = fromSlots ?? extractItemName(text)?.trim();
    if (!name || name.length > PANTRY_ITEM_NAME_MAX) return { cards: [cards.noNameCard(true, aiParsed)], found: false };
    return { cards: await draftForName(user, name, aiParsed && fromSlots !== undefined), found: true };
  }

  // ── 게시 실행(공개 미리보기 [올리기], 바로 실행 plan) ───────────────────────

  async function rootsOf(q: Queryable, ids: number[]): Promise<number[]> {
    const out: number[] = [];
    for (const id of ids) {
      const root = await findBundleRoot(q, id);
      if (root !== null) out.push(root);
    }
    return unique(out);
  }

  async function executePost(p: PostParams, ex: ExecContext): Promise<ExecOutcome> {
    const { q, user } = ex;
    const name = p.itemName;

    // 1) 서버 재검사: 공통 검사 + 전화번호·이메일·사람 이름·건강 정보(ADR-04). 막힌 이름은 결과·재시도 토큰에 넣지 않아요(H2).
    const check = checkItemName(name);
    if (!check.ok) return { status: 'blocked', card: blockedOutcomeCard(user, check.message ?? '올릴 수 없는 글자가 있어요', p.seen) };
    if (!ctx.rateLimiter.hit(user.pseudonymId, 'post')) throw new DeskError('rate-limited', 429, PANTRY_TEXT.rateLimited);

    // 사람 단위 잠금(R3): 같은 사람의 게시·+1이 동시에 와도 상한을 넘지 않아요(I7).
    await repo.lockPerson(q, user.pseudonymId);
    const floor = user.floor;
    const open = await openBundlesOn(q, floor);
    const catalog = await repo.catalog(q);
    // 이름을 안 고쳤는지는 HMAC으로만 봐요. 안 고쳤으면 초안 때 AI가 맞춘 카탈로그·AI가 고른 묶음을 그대로 써요.
    const unchanged = sameMac(name, p.nameMac);
    const catalogItemId = unchanged && p.catalogItemId && catalog.some((c) => c.id === p.catalogItemId) ? p.catalogItemId : matchCatalogByRule(name, catalog);

    // 2) 같은 품목 후보 묶음의 대표 카드를 FOR SHARE로 잠근 뒤 아직 열려 있는지 봐요(M2).
    //    주문안 확정과 겹치면 확정이 끝날 때까지 기다리고, 주문된 묶음은 같은 품목·표시 행 대상에서 빠져요.
    const ruleCandidates = similarByRule(name, open.candidates, catalog);
    const aiRoots = unchanged ? await rootsOf(q, p.aiSeen) : [];
    const live = new Set((await repo.shareLockCards(q, [...ruleCandidates, ...aiRoots])).filter((c) => c.state === 'open').map((c) => c.id));
    const ruleSame = ruleCandidates.filter((id) => live.has(id));

    // 3) 그사이 같은 품목이 올라왔으면 새 글 대신 [여기에 +1](F3-3). 이미 보여 준 묶음은 다시 막지 않아요.
    const seenRoots = new Set(await rootsOf(q, p.seen));
    const fresh = ruleSame.filter((id) => !seenRoots.has(id));
    const top = topBundle(open.bundles, fresh);
    if (top) {
      const myVote = (await repo.myVotedCardIds(q, user.pseudonymId, top.cardIds)).length > 0;
      // 사용자가 확정한(검사를 지난) 이름이라 [새 요청으로]에 그대로 보여 줘요. 토큰에는 HMAC만 들어가요.
      const again = propose(user, {
        floor,
        nameMac: nameMac(name),
        catalogItemId,
        seen: unique([...p.seen, ...fresh]).slice(0, 20),
        aiSeen: unchanged ? p.aiSeen : [],
      });
      return {
        status: 'blocked',
        card: cards.sameItemCard({
          target: { bundleId: top.bundleId, name: top.name, votes: top.votes, myVote },
          newRequest: { proposalToken: again, itemName: name },
          justPosted: true,
          aiSummarized: false,
        }),
      };
    }

    // 4) 표 상한(R14). 상한이 차면 게시도 막아요. 던지면 되돌려져서 같은 미리보기로 다시 올릴 수 있어요.
    const limit = await limitFor(q, floor);
    if ((await countVotedOpenBundles(q, user.pseudonymId)) >= limit) throw new DeskError('vote-limit', 409, PANTRY_TEXT.postLimit);

    // 5) 카드 + 작성자 표 1개를 한 트랜잭션으로(ADR-04). 판에는 품목 이름·층·가명 작성자 ID·시각만 남아요.
    await repo.insertFloorSettingIfMissing(q, { floor, ...DEFAULT_FLOOR_SETTING });
    const cycleNo = await repo.ensureOpenCycle(q, floor, limit);
    const at = iso(ex.now);
    const cardId = await repo.insertCard(q, {
      floor,
      itemName: name,
      catalogItemId,
      authorPseudonymId: user.pseudonymId,
      postedCycleNo: cycleNo,
      postKey: p.postKey,
      createdAt: at,
    });
    if (cardId === null) throw new DeskError('in-progress', 409, '이미 올렸어요. 판을 새로 불러와 주세요');
    await repo.insertVote(q, user.pseudonymId, cardId, at);

    // 6) "같은 상품 같아요" 표시 행(R15). 확정 전이라 표는 합치지 않아요. 2)에서 잠근 열린 묶음에만 달아요.
    for (const root of ruleSame) await repo.insertFlag(q, cardId, root, 'rule');
    const openIds = new Set(open.bundles.map((b) => b.bundleId));
    for (const root of aiRoots) {
      if (openIds.has(root) && live.has(root) && !ruleSame.includes(root)) await repo.insertFlag(q, cardId, root, 'ai');
    }
    return { status: 'done', card: cards.postedCard({ cardId, name, floor }) };
  }

  const postHandler: PlanHandler<PostParams> = {
    module: 'pantry',
    action: 'post',
    schema: PostParams,
    editableKeys: ['itemName'],
    execute: executePost,
    // 만료: 고친 이름으로 새 미리보기를 줘요("시간이 지나 다시 확인해 주세요").
    // 고친 이름이 판 검사(전화번호·사람 이름·자리표 등)에 걸리면 LLM을 부르지 않고 막힘 카드만 줘요(H1, ADR-11).
    reSearch: async (p, user) => {
      const check = checkItemName(p.itemName);
      if (!check.ok) return [blockedOutcomeCard(user, check.message ?? '올릴 수 없는 글자가 있어요', p.seen)];
      return draftForName(user, p.itemName, false);
    },
    // plan 행에는 HMAC을 남기지 않고, 막힌 결과(검사 막힘·같은 품목·기능 꺼짐)면 이름도 빼요(H2, R13).
    storedParams: (p, outcome) => ({
      floor: p.floor,
      postKey: p.postKey,
      catalogItemId: p.catalogItemId,
      seen: p.seen,
      aiSeen: p.aiSeen,
      ...(outcome.status === 'done' ? { itemName: p.itemName } : {}),
    }),
  };

  // ── 표(+1·거두기) ─────────────────────────────────────────────────────────

  async function vote(user: DeskUser, bundleId: number): Promise<VoteResponse> {
    if (!ctx.rateLimiter.hit(user.pseudonymId, 'vote')) throw new DeskError('rate-limited', 429, PANTRY_TEXT.rateLimited);
    return retryWhenBundleMoved(() =>
      ctx.fixed.run(user, {
        module: 'pantry',
        action: 'vote',
        resultCode: (r: VoteResponse) => (r.changed ? 'done' : 'noop'),
        run: async (q, now) => {
          await repo.lockPerson(q, user.pseudonymId);
          const { root, members } = await openBundleOnMyFloor(q, user, bundleId);
          const limit = await limitFor(q, user.floor);
          const count = await countVotedOpenBundles(q, user.pseudonymId);
          // 이미 그 묶음에 표가 있으면 아무 일도 없어요(ADR-07).
          if ((await repo.myVotedCardIds(q, user.pseudonymId, members)).length > 0) {
            return { bundleId: root, votes: await repo.distinctVoters(q, members), myVote: true, changed: false, myBundleCount: count, limit };
          }
          if (count > limit) throw new DeskError('over-limit', 409, PANTRY_TEXT.overLimit);
          if (count >= limit) throw new DeskError('vote-limit', 409, PANTRY_TEXT.voteLimit);
          // +1은 대표 카드에 붙어요. 표 쓰기는 묶음 버전을 올리지 않아요(I8).
          await repo.insertVote(q, user.pseudonymId, root, iso(now));
          return { bundleId: root, votes: await repo.distinctVoters(q, members), myVote: true, changed: true, myBundleCount: count + 1, limit };
        },
      }),
    );
  }

  async function withdraw(user: DeskUser, bundleId: number): Promise<VoteResponse> {
    return retryWhenBundleMoved(() =>
      ctx.fixed.run(user, {
        module: 'pantry',
        action: 'withdraw',
        resultCode: (r: VoteResponse) => (r.changed ? 'done' : 'noop'),
        run: async (q) => {
          await repo.lockPerson(q, user.pseudonymId);
          const { root, members } = await openBundleOnMyFloor(q, user, bundleId);
          // 거두기는 그 사람이 묶음 안에 가진 표를 모두 지워요(I4).
          const removed = await repo.deleteVotes(q, user.pseudonymId, members);
          return {
            bundleId: root,
            votes: await repo.distinctVoters(q, members),
            myVote: false,
            changed: removed > 0,
            myBundleCount: await countVotedOpenBundles(q, user.pseudonymId),
            limit: await limitFor(q, user.floor),
          };
        },
      }),
    );
  }

  /**
   * 카드가 속한 지금 묶음. 내 층 열린 묶음만 표를 바꿀 수 있어요(F3-1, I6).
   * 대표 카드를 FOR SHARE로 잠근 뒤 상태를 봐요(M2). 주문안 확정(FOR UPDATE)과 겹치면 확정이 끝난 뒤의 상태를 봐서
   * 주문된 묶음에 표가 생기거나 닫힌 표가 지워지지 않아요. 합치기·되돌리기와는 기다림만 생기고 409는 없어요(I8).
   * 잠그는 사이 합치기·되돌리기로 대표가 바뀌었으면 BundleMoved를 던져요. 옛 대표 잠금을 쥔 채 새 대표를 잠그면
   * 되돌리기(ID 순서 잠금)와 서로 기다릴 수 있어서, 트랜잭션을 되돌려 잠금을 모두 푼 뒤 처음부터 다시 해요.
   */
  async function openBundleOnMyFloor(q: Queryable, user: DeskUser, cardId: number): Promise<{ root: number; members: number[] }> {
    const root = await findBundleRoot(q, cardId);
    if (root === null) throw notFound();
    const [card] = await repo.shareLockCards(q, [root]);
    if (!card) throw notFound();
    if ((await findBundleRoot(q, cardId)) !== root) throw new BundleMoved();
    if (card.floor !== user.floor) throw new DeskError('other-floor', 403, PANTRY_TEXT.otherFloor);
    if (card.state !== 'open') throw new DeskError('ordered', 409, PANTRY_TEXT.ordered);
    return { root, members: await bundleMemberIds(q, root) };
  }

  // ── 판·내 요청(읽기) ──────────────────────────────────────────────────────

  async function board(user: DeskUser, floorParam?: string): Promise<BoardResponse> {
    assertOn();
    const floor = floorParam ?? user.floor;
    if (floor !== user.floor && !isFacilities(user)) throw new DeskError('forbidden', 403, '내 층 판만 볼 수 있어요');
    return readOnly(async (q) => {
      const open = await openBundlesOn(q, floor);
      const allIds = open.bundles.flatMap((b) => b.cardIds);
      const mine = new Set(await repo.myVotedCardIds(q, user.pseudonymId, allIds));
      const catalogNames = new Map((await repo.catalog(q)).map((c) => [c.id, c.name]));
      const nameOf = new Map(open.bundles.map((b) => [b.bundleId, b.name]));
      const similar = new Map<number, Set<number>>();
      const similarByAi = new Set<number>();
      for (const f of await repo.flagsTouching(q, allIds, ['showing'])) {
        const a = open.bundleOf.get(f.cardA);
        const b = open.bundleOf.get(f.cardB);
        if (a === undefined || b === undefined || a === b) continue;
        similar.set(a, (similar.get(a) ?? new Set()).add(b));
        similar.set(b, (similar.get(b) ?? new Set()).add(a));
        // 'ai' 표시 행은 실제 모델이 고른 것만이에요(게시 초안·제안함 모으기가 viaAi일 때만 만들어요).
        if (f.source === 'ai') similarByAi.add(a).add(b);
      }
      const cycleNo = await repo.openCycleNo(q, floor);
      const items: BoardItem[] = open.bundles.map((b) => {
        const members = b.cardIds.map((id) => open.byId.get(id)).filter((m): m is repo.CardRow => m !== undefined);
        return {
          bundleId: b.bundleId,
          bundleVersion: b.bundleVersion,
          name: b.name,
          votes: b.votes,
          myVote: b.cardIds.some((id) => mine.has(id)),
          catalogName: b.catalogItemId ? (catalogNames.get(b.catalogItemId) ?? null) : null,
          mergedNames: unique(members.filter((m) => m.id !== b.bundleId && m.itemName !== b.name).map((m) => m.itemName)),
          similarTo: [...(similar.get(b.bundleId) ?? [])].map((id) => nameOf.get(id)).filter((n): n is string => n !== undefined),
          similarByAi: similarByAi.has(b.bundleId),
          carriedOver: isCarriedOver(members, cycleNo),
        };
      });
      const ordered = await repo.latestOrderedBatch(q, floor);
      const roots = await cardRoots(q, floor);
      const orderedRoots = new Set(ordered.map((c) => roots.get(c.id) ?? c.id));
      const setting = await repo.floorSetting(q, floor);
      const floors = isFacilities(user) ? unique([...(await repo.floorSettings(q)).map((s) => s.floor), user.floor, floor]) : [user.floor];
      return {
        floor,
        floors,
        canVote: floor === user.floor,
        cycleNote: setting?.cycleNote ?? '',
        limit: setting?.perPersonLimit ?? DEFAULT_FLOOR_SETTING.perPersonLimit,
        myBundleCount: await countVotedOpenBundles(q, user.pseudonymId),
        items,
        lastCycle: { ordered: ordered.filter((c) => orderedRoots.has(c.id)).map((c) => c.itemName), carriedOver: items.filter((i) => i.carriedOver).length },
      };
    });
  }

  async function myRequests(user: DeskUser): Promise<MyRequestsResponse> {
    assertOn();
    return readOnly(async (q) => {
      const voted = await repo.myVoteCards(q, user.pseudonymId);
      if (voted.length === 0) return { items: [] };
      const roots = await cardRoots(q);
      const rootCards = await repo.cardsByIds(q, unique(voted.map((v) => roots.get(v.cardId) ?? v.cardId)));
      const batchAt = await repo.cardBatchAt(
        q,
        rootCards.map((c) => c.id),
      );
      const items: MyRequestItem[] = [];
      for (const floor of unique(rootCards.map((c) => c.floor))) {
        const open = await openBundlesOn(q, floor);
        const bundles = new Map(open.bundles.map((b) => [b.bundleId, b]));
        const cycleNo = await repo.openCycleNo(q, floor);
        const latest = await repo.latestOrderedBatchAt(q, floor);
        for (const c of rootCards.filter((r) => r.floor === floor)) {
          if (c.state === 'ordered') {
            // 가장 최근 주문안 확정에 들어간 것만 보여 줘요. 주문된 품목의 표는 닫혀서 수를 안 보여요.
            if (latest && batchAt.get(c.id) === latest) items.push({ bundleId: c.id, name: c.itemName, floor, votes: null, status: '주문에 들어감' });
            continue;
          }
          const b = bundles.get(c.id);
          if (!b) continue;
          const members = b.cardIds.map((id) => open.byId.get(id)).filter((m): m is repo.CardRow => m !== undefined);
          items.push({
            bundleId: b.bundleId,
            name: b.name,
            floor,
            votes: b.votes,
            status: isCarriedOver(members, cycleNo) ? '다음 주기로 넘어감' : '표 받는 중',
          });
        }
      }
      const rank = { '표 받는 중': 0, '다음 주기로 넘어감': 1, '주문에 들어감': 2 } as const;
      items.sort((a, b) => rank[a.status] - rank[b.status] || (b.votes ?? 0) - (a.votes ?? 0) || b.bundleId - a.bundleId);
      return { items };
    });
  }

  // ── S4 합치기 제안함·합친 기록·설정(총무만) ─────────────────────────────────

  async function listSuggestions(q: Queryable, floor: string): Promise<SuggestionsResponse> {
    const open = await openBundlesOn(q, floor);
    const catalogNames = new Map((await repo.catalog(q)).map((c) => [c.id, c.name]));
    const pairs = new Map<string, { pair: [number, number]; source: 'ai' | 'rule' }>();
    for (const f of await repo.flagsTouching(
      q,
      open.bundles.flatMap((b) => b.cardIds),
      ['showing'],
    )) {
      const a = open.bundleOf.get(f.cardA);
      const b = open.bundleOf.get(f.cardB);
      if (a === undefined || b === undefined || a === b) continue;
      const pair = orderPair(a, b);
      const key = pair.join('-');
      const prev = pairs.get(key);
      pairs.set(key, { pair, source: prev?.source === 'ai' || f.source === 'ai' ? 'ai' : 'rule' });
    }
    const bundles = new Map(open.bundles.map((b) => [b.bundleId, b]));
    const suggestions: MergeSuggestion[] = [];
    for (const { pair, source } of pairs.values()) {
      const A = bundles.get(pair[0]);
      const B = bundles.get(pair[1]);
      const ra = open.byId.get(pair[0]);
      const rb = open.byId.get(pair[1]);
      if (!A || !B || !ra || !rb) continue;
      const rep = chooseRepresentative(ra, rb);
      const catalogId = rep.catalogItemId ?? (rep === ra ? rb : ra).catalogItemId;
      const side = (x: Bundle) => ({
        bundleId: x.bundleId,
        bundleVersion: x.bundleVersion,
        name: x.name,
        votes: x.votes,
        catalogName: x.catalogItemId ? (catalogNames.get(x.catalogItemId) ?? null) : null,
      });
      suggestions.push({
        a: side(A),
        b: side(B),
        votesAfter: await repo.distinctVoters(q, [...A.cardIds, ...B.cardIds]),
        representativeName: rep.itemName,
        catalogName: catalogId ? (catalogNames.get(catalogId) ?? null) : null,
        source,
      });
    }
    suggestions.sort((x, y) => y.votesAfter - x.votesAfter || x.a.bundleId - y.a.bundleId);
    return { floor, suggestions };
  }

  async function suggestions(user: DeskUser, floor: string): Promise<SuggestionsResponse> {
    requireFacilities(user);
    assertOn();
    return readOnly((q) => listSuggestions(q, floor));
  }

  /** 총무가 S4를 열 때 남은 후보를 한 번 더 모아요(R15). 이미 표시 행이 있는 쌍(따로 둠 포함)은 다시 제안하지 않아요. */
  async function collect(user: DeskUser, floor: string): Promise<SuggestionsResponse> {
    requireFacilities(user);
    assertOn();
    const snap = await readOnly(async (q) => {
      const open = await openBundlesOn(q, floor);
      const flags = await repo.flagsTouching(
        q,
        open.bundles.flatMap((b) => b.cardIds),
      );
      return { open, flags, catalog: await repo.catalog(q) };
    });
    const flagged = new Set<string>();
    for (const f of snap.flags) {
      const a = snap.open.bundleOf.get(f.cardA);
      const b = snap.open.bundleOf.get(f.cardB);
      if (a !== undefined && b !== undefined && a !== b) flagged.add(orderPair(a, b).join('-'));
    }
    const found = await collectPairs(ctx.gateway, snap.open.candidates, snap.catalog);
    const fresh = found.filter((f) => !flagged.has(f.pair.join('-')));
    if (fresh.length > 0) {
      await ctx.fixed.run(user, {
        module: 'pantry',
        action: 'collect-suggestions',
        run: async (q) => {
          for (const f of fresh) await repo.insertFlag(q, f.pair[0], f.pair[1], f.source);
          return { added: fresh.length };
        },
      });
    }
    return readOnly((q) => listSuggestions(q, floor));
  }

  /** 합치기(확인 시트 뒤). 관련 대표 카드 행을 ID 순서로 잠그고, 화면이 본 묶음 버전과 다르면 409예요(R3). */
  async function merge(user: DeskUser, req: MergeRequest): Promise<MergeResponse> {
    requireFacilities(user);
    const [a, b] = req.bundleIds;
    const [va, vb] = req.versions;
    if (a === b) throw new DeskError('bad-request', 400, '같은 품목끼리는 합칠 수 없어요');
    return ctx.fixed.run(user, {
      module: 'pantry',
      action: 'merge',
      idempotencyKey: `${a}-${b}-${va}-${vb}`,
      run: async (q, now) => {
        const rows = await repo.lockCards(q, [a, b]);
        const ra = rows.find((r) => r.id === a);
        const rb = rows.find((r) => r.id === b);
        if (!ra || !rb) throw notFound();
        if (ra.floor !== rb.floor) throw new DeskError('bad-request', 400, '같은 층 품목끼리만 합쳐요');
        if (ra.state !== 'open' || rb.state !== 'open' || ra.bundleVersion !== va || rb.bundleVersion !== vb) throw conflict();
        if ((await repo.isMergedAway(q, a)) || (await repo.isMergedAway(q, b))) throw conflict();
        const rep = chooseRepresentative(ra, rb);
        const other = rep === ra ? rb : ra;
        // 합치기는 투표 행을 바꾸지 않아요(I3). 묶음 구성만 바뀌고 버전이 올라가요.
        await repo.insertMerge(q, other.id, rep.id, user.pseudonymId, iso(now));
        await repo.bumpVersions(q, [a, b]);
        const members = await bundleMemberIds(q, rep.id);
        const inside = new Set(members);
        const flags = await repo.flagsTouching(q, members, ['showing']);
        await repo.setFlagState(
          q,
          flags.filter((f) => inside.has(f.cardA) && inside.has(f.cardB)).map((f) => [f.cardA, f.cardB]),
          'merged',
        );
        return { bundleId: rep.id, votes: await repo.distinctVoters(q, members) };
      },
    });
  }

  /** 되돌리기(확인 시트 뒤). 표 수가 합치기 전으로 돌아가요. 투표 행은 그대로예요(I3). */
  async function revert(user: DeskUser, mergeId: number, bundleVersion: number): Promise<MergeResponse> {
    requireFacilities(user);
    return ctx.fixed.run(user, {
      module: 'pantry',
      action: 'revert',
      idempotencyKey: `${mergeId}-${bundleVersion}`,
      run: async (q, now) => {
        const m = await repo.lockMerge(q, mergeId);
        if (!m) throw notFound();
        if (m.revertedAt) throw conflict();
        const root = await findBundleRoot(q, m.representativeCardId);
        if (root === null) throw notFound();
        const rows = await repo.lockCards(q, [root, m.representativeCardId, m.mergedCardId]);
        const rootRow = rows.find((r) => r.id === root);
        if (!rootRow || rootRow.state !== 'open' || rootRow.bundleVersion !== bundleVersion) throw conflict();
        if ((await findBundleRoot(q, m.representativeCardId)) !== root) throw conflict();
        const before = await bundleMemberIds(q, root);
        await repo.revertMerge(q, mergeId, iso(now));
        await repo.bumpVersions(q, [root, m.representativeCardId, m.mergedCardId]);
        // 갈라진 쌍의 표시 행은 다시 "같은 상품 같아요"예요. 총무가 [따로 두기]로 끝낼 수 있어요.
        const roots = await cardRoots(q, rootRow.floor);
        const split = (await repo.flagsTouching(q, before, ['merged'])).filter((f) => roots.get(f.cardA) !== roots.get(f.cardB));
        await repo.setFlagState(
          q,
          split.map((f) => [f.cardA, f.cardB]),
          'showing',
        );
        return { bundleId: root, votes: await repo.distinctVoters(q, await bundleMemberIds(q, root)) };
      },
    });
  }

  /** 따로 두기(버튼 한 번). 판의 "같은 상품 같아요" 표시도 사라지고, 이 쌍은 다시 제안하지 않아요. */
  async function keepApart(user: DeskUser, bundleIds: [number, number]): Promise<{ changed: number }> {
    requireFacilities(user);
    return ctx.fixed.run(user, {
      module: 'pantry',
      action: 'keep-apart',
      run: async (q) => {
        const inA = new Set(await bundleMemberIds(q, bundleIds[0]));
        const inB = new Set(await bundleMemberIds(q, bundleIds[1]));
        const hits = (await repo.flagsTouching(q, [...inA], ['showing'])).filter(
          (f) => (inA.has(f.cardA) && inB.has(f.cardB)) || (inB.has(f.cardA) && inA.has(f.cardB)),
        );
        await repo.setFlagState(
          q,
          hits.map((f) => [f.cardA, f.cardB]),
          'kept-apart',
        );
        return { changed: hits.length };
      },
    });
  }

  async function merges(user: DeskUser, floor: string): Promise<MergesResponse> {
    requireFacilities(user);
    assertOn();
    return readOnly(async (q) => {
      const rows = await repo.activeMerges(q, floor);
      const roots = await cardRoots(q, floor);
      const rootOf = (id: number) => roots.get(id) ?? id;
      const rootCards = new Map((await repo.cardsByIds(q, unique(rows.map((r) => rootOf(r.representativeCardId))))).map((c) => [c.id, c]));
      return {
        floor,
        merges: rows.map((r) => {
          const bundleId = rootOf(r.representativeCardId);
          return {
            mergeId: r.id,
            mergedAt: r.mergedAt,
            representativeName: r.representativeName,
            mergedName: r.mergedName,
            bundleId,
            bundleVersion: rootCards.get(bundleId)?.bundleVersion ?? 0,
          };
        }),
      };
    });
  }

  async function settings(user: DeskUser): Promise<PantrySettingsResponse> {
    requireFacilities(user);
    return readOnly(async (q) => ({ floors: await repo.floorSettings(q) }));
  }

  /** 층별 최소 몫·표 상한·주기 마감 안내(표시용 글자). 주기 마감 안내는 공개 글이라 품목 이름과 같은 검사를 해요. */
  async function saveSettings(user: DeskUser, floor: string, body: PantrySettingsUpdate): Promise<FloorSetting> {
    requireFacilities(user);
    if (body.cycleNote) {
      const check = checkItemName(body.cycleNote);
      if (!check.ok) throw new DeskError('locked', 422, check.message ?? '올릴 수 없는 글자가 있어요');
    }
    return ctx.fixed.run(user, {
      module: 'pantry',
      action: 'settings',
      run: async (q) => {
        const row = { floor, ...body };
        await repo.saveFloorSetting(q, row);
        await repo.setOpenCycleLimit(q, floor, body.perPersonLimit);
        return row;
      },
    });
  }

  // ── 가상 자료(등급 0) ─────────────────────────────────────────────────────

  /** 카탈로그·층 설정·층별 열린 주기. 여러 번 불러도 한 번만 들어가요. */
  async function seedBase(q: Queryable): Promise<void> {
    for (const c of CATALOG_FIXTURES) await repo.insertCatalogItem(q, c);
    for (const floor of DEMO_FLOORS) {
      await repo.insertFloorSettingIfMissing(q, { floor, ...DEFAULT_FLOOR_SETTING });
      await repo.ensureOpenCycle(q, floor, DEFAULT_FLOOR_SETTING.perPersonLimit);
    }
  }

  async function seed(opts: { demoCards?: boolean } = {}): Promise<void> {
    await ctx.db.tx(async (q) => {
      await seedBase(q);
      if (opts.demoCards === false || (await repo.countCards(q)) > 0) return;
      // 시연용 요청. 표를 준 사람은 가상 가명 ID예요(실제 직원과 이어지지 않아요).
      const demo: { floor: string; name: string; catalog: string | null; voters: string[] }[] = [
        { floor: '3층', name: '코카콜라 제로 355', catalog: 'cat-coke-zero', voters: ['p_demo_a', 'p_demo_b', 'p_demo_c'] },
        { floor: '3층', name: '제로 콜라 캔', catalog: 'cat-coke-zero', voters: ['p_demo_d', 'p_demo_a'] },
        { floor: '3층', name: '녹차 티백', catalog: 'cat-green-tea', voters: ['p_demo_b'] },
        { floor: '3층', name: '바나나', catalog: 'cat-banana', voters: ['p_demo_e', 'p_demo_c'] },
        { floor: '5층', name: '원두', catalog: 'cat-coffee-beans', voters: ['p_demo_f', 'p_demo_g'] },
        { floor: '5층', name: '커피믹스', catalog: 'cat-coffee-mix', voters: ['p_demo_g'] },
        { floor: '2층', name: '종이컵', catalog: 'cat-paper-cup', voters: ['p_demo_h'] },
      ];
      const ids: number[] = [];
      for (const [i, d] of demo.entries()) {
        const at = iso(ctx.now() - (demo.length - i) * 60_000);
        const id = await repo.insertCard(q, {
          floor: d.floor,
          itemName: d.name,
          catalogItemId: d.catalog,
          authorPseudonymId: d.voters[0]!,
          postedCycleNo: 1,
          postKey: randomUUID(),
          createdAt: at,
        });
        if (id === null) continue;
        ids.push(id);
        for (const v of d.voters) await repo.insertVote(q, v, id, at);
      }
      // "같은 상품 같아요" 표시 하나(판·총무 제안함 시연). 같은 카탈로그 품목이라 이름 규칙이 찾은 것으로 둬요(모델이 고르지 않았으니 "AI 정리"가 아니에요).
      if (ids[0] !== undefined && ids[1] !== undefined) await repo.insertFlag(q, ids[0], ids[1], 'rule');
    });
  }

  return {
    readOnly,
    ask,
    draftFromText,
    draftForName,
    postHandler,
    vote,
    withdraw,
    board,
    myRequests,
    suggestions,
    collect,
    merge,
    revert,
    keepApart,
    merges,
    settings,
    saveSettings,
    seed,
    assertOn,
  };
}

function topBundle(bundles: Bundle[], ids: number[]): Bundle | undefined {
  const set = new Set(ids);
  return bundles.filter((b) => set.has(b.bundleId)).sort((x, y) => y.votes - x.votes || x.bundleId - y.bundleId)[0];
}

/** 지난 주기에서 넘어온 묶음인지(R16): 묶음 안 카드가 지금 열린 주기보다 앞 주기에 올라왔어요. */
function isCarriedOver(members: repo.CardRow[], openCycleNo: number | null): boolean {
  return openCycleNo !== null && members.some((m) => m.postedCycleNo !== null && m.postedCycleNo < openCycleNo);
}
