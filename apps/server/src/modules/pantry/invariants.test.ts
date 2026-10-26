import type { MergeResponse, VoteResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { DeskError } from '../../core/errors';
import type { DeskUser } from '../../core/user';
import { createTestApp } from '../../testing';
import { listOpenBundles } from './bundles';
import { type BoardService, createBoardService } from './service';
import { fakeUser, postActionOf, seededRandom } from './test-kit';

// [ADR-07 시험] 불변식 I1~I8: 게시·+1·거두기·합치기·되돌리기를 무작위로 섞어 병렬로 돌린 뒤 검사해요.
// 시험 DB(PGlite)는 연결이 하나라 트랜잭션이 차례로 돌지만, 요청 사이 끼어들기(화면이 본 버전이 낡음, 같은 사람 연타)는 그대로 생겨요.

type Test = Awaited<ReturnType<typeof createTestApp>>;

const opened: Test[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup(limit = 5) {
  const t = await createTestApp();
  opened.push(t);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 100_000 });
  const svc = createBoardService(t.ctx);
  await svc.seed({ demoCards: false });
  await t.db.query("update pantry_floor_settings set per_person_limit = $1 where floor = '3층'", [limit]);
  return { t, svc };
}

async function post(t: Test, svc: BoardService, user: DeskUser, name: string) {
  const action = postActionOf(await svc.draftForName(user, name));
  return t.ctx.plans.direct(user, action.proposalToken, { itemName: name });
}

/** 투표 행과 합치기 기록에서 묶음을 따로 다시 세요(listOpenBundles와 비교용). */
async function recount(t: Test) {
  const cards = (await t.db.query<{ id: number; state: string }>("select id, state from pantry_cards where floor = '3층'")).rows.map((r) => ({
    ...r,
    id: Number(r.id),
  }));
  const edges = (
    await t.db.query<{ merged_card_id: number; representative_card_id: number }>(
      'select merged_card_id, representative_card_id from pantry_merges where reverted_at is null',
    )
  ).rows;
  const votes = (await t.db.query<{ pseudonym_id: string; card_id: number }>('select pseudonym_id, card_id from pantry_votes')).rows;
  const parent = new Map(edges.map((e) => [Number(e.merged_card_id), Number(e.representative_card_id)]));
  const rootOf = (id: number) => {
    let cur = id;
    for (let i = 0; i < 10_000 && parent.has(cur); i++) cur = parent.get(cur)!;
    return cur;
  };
  const people = new Map<number, Set<string>>();
  for (const c of cards.filter((c) => c.state === 'open')) {
    const root = rootOf(c.id);
    if (!people.has(root)) people.set(root, new Set());
    for (const v of votes.filter((v) => Number(v.card_id) === c.id)) people.get(root)!.add(v.pseudonym_id);
  }
  return { people, parent, votes, cards };
}

async function checkInvariants(t: Test) {
  const bundles = await listOpenBundles(t.db, '3층');
  const { people, parent, votes } = await recount(t);
  // I1 묶음 표 = 서로 다른 사람 수
  for (const b of bundles) expect(b.votes, `묶음 ${b.bundleId}`).toBe(people.get(b.bundleId)?.size ?? 0);
  expect(bundles.map((b) => b.bundleId).sort()).toEqual([...people.keys()].sort());
  // I2 한 사람 한 카드 한 표
  const keys = votes.map((v) => `${v.pseudonym_id}:${v.card_id}`);
  expect(new Set(keys).size).toBe(keys.length);
  // I5 합치기 연결에 순환 없음, 한 카드는 한 번만 묶여요
  for (const start of parent.keys()) {
    const seen = new Set<number>();
    let cur: number | undefined = start;
    while (cur !== undefined) {
      expect(seen.has(cur), `순환: ${start}`).toBe(false);
      seen.add(cur);
      cur = parent.get(cur);
    }
  }
}

const NAMES = ['제로콜라', '코카콜라 제로 355', '녹차', '녹차 티백', '바나나', '생수', '물', '원두', '커피믹스', '종이컵', '젤리', '감자칩'];

describe('[ADR-07 시험] 표·묶음 불변식', () => {
  it('[F3-완료3] 게시·+1·거두기·합치기·되돌리기를 무작위 병렬로 섞어도 I1·I2·I5·I7·I8이 지켜지고, 모두 되돌리면 카드별 표 = 투표 행에서 다시 센 값이에요', async () => {
    const limit = 4;
    const { t, svc } = await setup(limit);
    const rand = seededRandom(20261026);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const staff = Array.from({ length: 8 }, (_, i) => fakeUser(`s${i}`));
    const managers = [fakeUser('f1', { facilities: true }), fakeUser('f2', { facilities: true })];

    for (const [i, name] of NAMES.slice(0, 6).entries()) await post(t, svc, staff[i]!, name);

    const errors: string[] = [];
    const voteResults: VoteResponse[] = [];
    const voteErrors: string[] = [];
    const tagVote = (e: unknown) => {
      voteErrors.push(e instanceof DeskError ? e.code : String(e));
      throw e;
    };
    let merges = 0;
    let reverts = 0;
    for (let round = 0; round < 12; round++) {
      const board = await svc.board(managers[0]!);
      const items = board.items;
      const active = (await svc.merges(managers[0]!, '3층')).merges;
      const ops: (() => Promise<unknown>)[] = [];
      for (let k = 0; k < 16; k++) {
        const r = rand();
        const who = pick(staff);
        if (r < 0.15) ops.push(() => post(t, svc, who, pick(NAMES)));
        else if (r < 0.55 && items.length)
          ops.push(() =>
            svc
              .vote(who, pick(items).bundleId)
              .then((v) => voteResults.push(v))
              .catch(tagVote),
          );
        else if (r < 0.7 && items.length) ops.push(() => svc.withdraw(who, pick(items).bundleId).catch(tagVote));
        else if (r < 0.88 && items.length >= 2) {
          const a = pick(items);
          const b = pick(items.filter((x) => x.bundleId !== a.bundleId));
          ops.push(() =>
            svc.merge(pick(managers), { bundleIds: [a.bundleId, b.bundleId], versions: [a.bundleVersion, b.bundleVersion] }).then((m: MergeResponse) => {
              merges += 1;
              return m;
            }),
          );
        } else if (active.length) {
          const m = pick(active);
          ops.push(() =>
            svc.revert(pick(managers), m.mergeId, m.bundleVersion).then(() => {
              reverts += 1;
            }),
          );
        }
      }
      const settled = await Promise.allSettled(ops.map((op) => op()));
      for (const s of settled) {
        if (s.status === 'rejected') {
          const e = s.reason;
          expect(e, String(e)).toBeInstanceOf(DeskError);
          errors.push((e as DeskError).code);
        }
      }
      await checkInvariants(t);
    }

    // 실패는 정해진 것뿐이에요: 버전 충돌(합치기·되돌리기), 상한, 이미 주문됨 없음.
    expect(new Set(errors)).toSatisfy((codes: Set<string>) => [...codes].every((c) => ['conflict', 'vote-limit', 'over-limit', 'in-progress'].includes(c)));
    // 같은 씨앗이라 늘 같은 순서예요. 충돌·상한 거부가 실제로 섞였는지도 확인해요.
    expect(errors).toContain('conflict');
    expect(errors).toContain('vote-limit');
    expect(merges).toBeGreaterThan(0);
    expect(reverts).toBeGreaterThan(0);
    // I7 검사 순간 상한을 넘는 +1 0건
    for (const v of voteResults.filter((v) => v.changed)) expect(v.myBundleCount).toBeLessThanOrEqual(limit);
    // I8 표 쓰기(+1·거두기)는 묶음 버전 충돌(409 conflict)을 만들지 않아요. 상한 거부만 있어요.
    expect(voteErrors.filter((c) => c !== 'vote-limit' && c !== 'over-limit')).toEqual([]);

    // 합치기를 모두 되돌려요. I3: 되돌리기는 투표 행을 바꾸지 않아요.
    const before = (await t.db.query('select pseudonym_id, card_id from pantry_votes order by pseudonym_id, card_id')).rows;
    for (;;) {
      const left = (await svc.merges(managers[0]!, '3층')).merges;
      if (left.length === 0) break;
      await svc.revert(managers[0]!, left[0]!.mergeId, left[0]!.bundleVersion);
    }
    const after = (await t.db.query('select pseudonym_id, card_id from pantry_votes order by pseudonym_id, card_id')).rows;
    expect(after).toEqual(before);
    // ② 모두 풀면 카드별 표 = 투표 행에서 다시 센 값
    const bundles = await listOpenBundles(t.db, '3층');
    for (const b of bundles) {
      expect(b.cardIds).toEqual([b.bundleId]);
      const { rows } = await t.db.query<{ n: number }>('select count(*)::int as n from pantry_votes where card_id = $1', [b.bundleId]);
      expect(b.votes).toBe(rows[0]!.n);
    }
    await checkInvariants(t);
  }, 120_000);

  it('[F3-완료4·I7] 같은 사람이 +1을 동시에 연타해도 상한을 넘지 않아요(게시와 섞여도)', async () => {
    const { t, svc } = await setup(2);
    const authors = Array.from({ length: 5 }, (_, i) => fakeUser(`a${i}`));
    for (const [i, a] of authors.entries()) await post(t, svc, a, NAMES[i * 2]!);
    const me = fakeUser('me');
    const ids = (await svc.board(me)).items.map((i) => i.bundleId);
    const results = await Promise.allSettled([
      ...ids.flatMap((id) => [1, 2, 3, 4].map(() => svc.vote(me, id))),
      post(t, svc, me, '감자칩'),
      post(t, svc, me, '젤리'),
    ]);
    const count = (await t.db.query<{ n: number }>("select count(distinct card_id)::int as n from pantry_votes where pseudonym_id = 'p_test_me'")).rows[0]!.n;
    expect(count).toBeLessThanOrEqual(2);
    expect(count).toBe(2);
    const rejected = results.filter((r) => r.status === 'rejected').map((r) => ((r as PromiseRejectedResult).reason as DeskError).code);
    expect(rejected.length).toBeGreaterThan(0);
    expect(new Set(rejected)).toEqual(new Set(['vote-limit']));
  }, 60_000);

  it('[I4] 거두면 그 묶음에 내 표가 없어요(합친 묶음의 여러 카드에 표가 있어도)', async () => {
    const { t, svc } = await setup();
    const [a, b, me] = [fakeUser('a'), fakeUser('b'), fakeUser('me')];
    const fac = fakeUser('f', { facilities: true });
    await post(t, svc, a, '원두');
    await post(t, svc, b, '종이컵');
    const [x, y] = (await svc.board(me)).items;
    await svc.vote(me, x!.bundleId);
    await svc.vote(me, y!.bundleId);
    const merged = await svc.merge(fac, { bundleIds: [x!.bundleId, y!.bundleId], versions: [x!.bundleVersion, y!.bundleVersion] });
    expect(merged.votes).toBe(3);
    const res = await svc.withdraw(me, merged.bundleId);
    expect(res).toMatchObject({ votes: 2, myVote: false, changed: true, myBundleCount: 0 });
    expect((await t.db.query("select * from pantry_votes where pseudonym_id = 'p_test_me'")).rows).toEqual([]);
  });

  it('[R3·I8] 409는 두 총무가 같은 묶음을 바꿀 때만 나요. +1과 합치기가 동시에 와도 409가 없어요', async () => {
    const { t, svc } = await setup();
    const authors = Array.from({ length: 4 }, (_, i) => fakeUser(`m${i}`));
    for (const [i, a] of authors.entries()) await post(t, svc, a, ['원두', '종이컵', '젤리', '감자칩'][i]!);
    const [f1, f2] = [fakeUser('f1', { facilities: true }), fakeUser('f2', { facilities: true })];
    const [a, b, c, d] = (await svc.board(f1)).items;
    const voters = Array.from({ length: 6 }, (_, i) => fakeUser(`v${i}`));

    // 같은 묶음: 하나만 성공, 하나는 409
    const same = await Promise.allSettled([
      svc.merge(f1, { bundleIds: [a!.bundleId, b!.bundleId], versions: [a!.bundleVersion, b!.bundleVersion] }),
      svc.merge(f2, { bundleIds: [a!.bundleId, b!.bundleId], versions: [a!.bundleVersion, b!.bundleVersion] }),
      ...voters.map((v) => svc.vote(v, a!.bundleId)),
    ]);
    expect(
      same
        .slice(0, 2)
        .map((r) => r.status)
        .sort(),
    ).toEqual(['fulfilled', 'rejected']);
    const rejected = same.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'conflict', status: 409, message: '다른 총무가 먼저 이 품목을 바꿨어요. 새로 불러왔어요.' });
    expect(same.slice(2).every((r) => r.status === 'fulfilled')).toBe(true);

    // 다른 묶음: 둘 다 성공
    const other = await Promise.allSettled([svc.merge(f2, { bundleIds: [c!.bundleId, d!.bundleId], versions: [c!.bundleVersion, d!.bundleVersion] })]);
    expect(other[0]!.status).toBe('fulfilled');

    // 되돌리기 둘이 같은 기록이면 하나만 성공
    const active = (await svc.merges(f1, '3층')).merges.find((m) => m.bundleId === a!.bundleId || m.bundleId === b!.bundleId)!;
    const reverts = await Promise.allSettled([svc.revert(f1, active.mergeId, active.bundleVersion), svc.revert(f2, active.mergeId, active.bundleVersion)]);
    expect(reverts.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(((reverts.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as DeskError).code).toBe('conflict');
    await checkInvariants(t);
  }, 60_000);

  it('[I3] 합치기·되돌리기는 투표 행을 바꾸지 않아요', async () => {
    const { t, svc } = await setup();
    const people = Array.from({ length: 4 }, (_, i) => fakeUser(`i${i}`));
    for (const [i, p] of people.entries()) await post(t, svc, p, ['녹차', '녹차 티백', '원두', '종이컵'][i]!);
    const fac = fakeUser('f', { facilities: true });
    for (const p of people) for (const item of (await svc.board(p)).items.slice(0, 2)) await svc.vote(p, item.bundleId);
    const snapshot = async () => (await t.db.query('select pseudonym_id, card_id, created_at from pantry_votes order by 1, 2')).rows;
    const before = await snapshot();
    const [a, b, c] = (await svc.board(fac)).items;
    const m1 = await svc.merge(fac, { bundleIds: [a!.bundleId, b!.bundleId], versions: [a!.bundleVersion, b!.bundleVersion] });
    const fresh = (await svc.board(fac)).items;
    const top = fresh.find((i) => i.bundleId === m1.bundleId)!;
    const cc = fresh.find((i) => i.bundleId === c!.bundleId)!;
    await svc.merge(fac, { bundleIds: [top.bundleId, cc.bundleId], versions: [top.bundleVersion, cc.bundleVersion] });
    expect(await snapshot()).toEqual(before);
    for (;;) {
      const left = (await svc.merges(fac, '3층')).merges;
      if (!left.length) break;
      await svc.revert(fac, left.at(-1)!.mergeId, left.at(-1)!.bundleVersion);
    }
    expect(await snapshot()).toEqual(before);
    await checkInvariants(t);
  }, 60_000);
});
