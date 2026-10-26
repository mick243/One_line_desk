import { type BoardResponse, type Card, type MergeSuggestion, PANTRY_TEXT, PREVIEW_LIMIT_FIELD } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { createBoardService } from './service';
import { fakeUser, postActionOf } from './test-kit';

// F3 같이 채워요 판: 경로 시험(PRD F3 완료 기준, 주문안 빼고).

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 10_000 });
  const svc = createBoardService(t.ctx);
  await svc.seed({ demoCards: false });
  return { t, svc };
}

type Session = Awaited<ReturnType<Awaited<ReturnType<typeof createTestApp>>['loginAs']>>;

async function draft(me: Session, text: string): Promise<Card[]> {
  const res = await me.call('POST', '/api/pantry/draft', { text });
  expect(res.status).toBe(200);
  return res.body.cards as Card[];
}

/** 판 요청 쓰기 → 미리보기 → (이름을 고쳐) [올리기] */
async function postVia(me: Session, text: string, itemName?: string) {
  const action = postActionOf(await draft(me, text));
  return me.call('POST', '/api/plans/direct', { proposalToken: action.proposalToken, edits: { itemName: itemName ?? action.itemName } });
}

async function board(me: Session, floor?: string): Promise<BoardResponse> {
  const res = await me.call('GET', `/api/pantry/board${floor ? `?floor=${encodeURIComponent(floor)}` : ''}`);
  expect(res.status).toBe(200);
  return res.body as BoardResponse;
}

const F3 = encodeURIComponent('3층');
const F5 = encodeURIComponent('5층');

async function count(t: Awaited<ReturnType<typeof createTestApp>>, table: string): Promise<number> {
  const { rows } = await t.db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return rows[0]!.n;
}

describe('게시: 묻기·초안은 판에 쓰지 못해요(ADR-04)', () => {
  it('[F3-완료1] 묻기 경로(/ask)로는 판에 아무것도 안 생기고, 묻기에 넣은 카나리는 DB 어디에도 없어요', async () => {
    const { t } = await setup();
    const me = await t.loginAs(MOCK.staff);
    const canary = '카나리판QZ9';
    const res = await me.call('POST', '/api/ask', { text: `제로콜라 또 넣어 주세요 ${canary}` });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('pantry');
    expect(res.body.cards[0].variant).toBe('pantry-preview');
    const draftRes = await me.call('POST', '/api/pantry/draft', { text: `녹차 티백 채워 주세요 ${canary}` });
    expect(draftRes.status).toBe(200);

    for (const table of ['pantry_cards', 'pantry_votes', 'pantry_merges', 'pantry_similar_flags', 'plans', 'action_receipts']) {
      expect(await count(t, table)).toBe(0);
    }
    const { rows: tables } = await t.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'");
    for (const { table_name } of tables) {
      const { rows } = await t.db.query(`select * from ${table_name}`);
      expect(JSON.stringify(rows), table_name).not.toContain(canary);
    }
  });

  it('[ADR-04 시험] 초안이 쓰는 읽기 전용 트랜잭션에서는 판 표 INSERT가 DB에서 거부돼요', async () => {
    const { svc } = await setup();
    await expect(
      svc.readOnly((q) => q.query("insert into pantry_cards (floor, item_name, author_pseudonym_id) values ('3층', '몰래 쓰기', 'p_x')")),
    ).rejects.toThrow(/read-only/);
    await expect(svc.readOnly((q) => q.query("insert into pantry_votes (pseudonym_id, card_id) values ('p_x', 1)"))).rejects.toThrow(/read-only/);
  });

  it('[F3-완료2] 판에 올라간 글자는 미리보기에서 확정한 글자와 같아요(고친 이름 그대로)', async () => {
    const { t } = await setup();
    const me = await t.loginAs(MOCK.staff);
    const names = ['코카콜라 제로 500mL', '녹차(티백)', 'Banana 🍌'];
    for (const [i, name] of names.entries()) {
      const res = await postVia(me, ['제로콜라 또 넣어 주세요', '녹차 채워 주세요', '바나나 요청'][i]!, name);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('done');
    }
    const items = (await board(me)).items.map((i) => i.name);
    expect(items.sort()).toEqual([...names].sort());
    const { rows } = await t.db.query<{ item_name: string }>('select item_name from pantry_cards order by id');
    expect(rows.map((r) => r.item_name)).toEqual(names);
  });

  it('[ADR-03·04 시험] 같은 제안 토큰으로 두 번 올려도 카드는 하나, 내 표 하나예요(차례로·동시)', async () => {
    const { t } = await setup();
    const me = await t.loginAs(MOCK.staff);
    const one = postActionOf(await draft(me, '바나나 요청'));
    const first = await me.call('POST', '/api/plans/direct', { proposalToken: one.proposalToken, edits: { itemName: '바나나' } });
    const second = await me.call('POST', '/api/plans/direct', { proposalToken: one.proposalToken, edits: { itemName: '바나나' } });
    expect(first.body).toEqual(second.body);

    const two = postActionOf(await draft(me, '종이컵 채워 주세요'));
    const both = await Promise.all(
      [1, 2, 3].map(() => me.call('POST', '/api/plans/direct', { proposalToken: two.proposalToken, edits: { itemName: '종이컵' } })),
    );
    expect(both.some((r) => r.status === 200 && r.body.status === 'done')).toBe(true);
    expect(await count(t, 'pantry_cards')).toBe(2);
    expect(await count(t, 'pantry_votes')).toBe(2);
  });

  it('[ADR-03·04 시험] [올리지 않기]는 서버를 부르지 않아서 초안만으로는 DB 변화가 0이에요', async () => {
    const { t } = await setup();
    const me = await t.loginAs(MOCK.staff);
    await draft(me, '바나나 요청');
    expect(await count(t, 'pantry_cards')).toBe(0);
    expect(await count(t, 'plans')).toBe(0);
  });

  it('[F3-3] 건강 정보는 요청 쓰기 칸에서도, 올리기 직전 재검사에서도 막혀요', async () => {
    const { t } = await setup();
    const me = await t.loginAs(MOCK.staff);
    const locked = await me.call('POST', '/api/pantry/draft', { text: '땅콩 알레르기 있어서 견과 말고 젤리요' });
    expect(locked.status).toBe(422);
    expect(locked.body.locks[0].kind).toBe('health');

    // 고친 이름의 건강 정보는 공통 검사 잠금이라 core plans.direct()가 처리기 전에 내용 없이 400으로 막아요(ADR-11).
    const res = await postVia(me, '젤리 요청', '알레르기 없는 젤리');
    expect(res).toMatchObject({ status: 400, body: { error: 'locked' } });
    expect(JSON.stringify(res.body)).not.toContain('알레르기');
    expect(await count(t, 'pantry_cards')).toBe(0);
    expect(await count(t, 'plans')).toBe(0);
  });

  it('[F3-3] 전화번호·이메일·사람 이름이 든 이름은 막힘 카드와 [이름 고치기]예요', async () => {
    const { t } = await setup();
    const me = await t.loginAs(MOCK.staff);
    const cases: [string, string][] = [
      ['생수 010-1234-5678', '[전화번호]'],
      ['커피 a.b@example.com', '[이메일]'],
      ['김가상 대리 커피', '[사람 이름]'],
    ];
    for (const [name, label] of cases) {
      const res = await postVia(me, '생수 요청', name);
      expect(res.body.status).toBe('blocked');
      expect(res.body.card.headline).toBe(`올릴 수 없는 글자가 있어요: ${label}`);
      const fix = postActionOf([res.body.card]);
      expect(fix.text).toBe('이름 고치기');
      const fixed = await me.call('POST', '/api/plans/direct', { proposalToken: fix.proposalToken, edits: { itemName: `생수 ${label.length}` } });
      expect(fixed.body.status).toBe('done');
    }
    const { rows } = await t.db.query<{ item_name: string }>('select item_name from pantry_cards');
    expect(JSON.stringify(rows)).not.toMatch(/010|example|김가상/);
  });

  it('[F3-3] 비슷한 품목이 이미 있으면 새 글 대신 같은 품목 카드([여기에 +1])가 먼저 와요', async () => {
    const { t, svc } = await setup();
    const other = fakeUser('a');
    const cards = await svc.draftForName(other, '코카콜라 제로 355');
    await t.ctx.plans.direct(other, postActionOf(cards).proposalToken, { itemName: '코카콜라 제로 355' });

    const me = await t.loginAs(MOCK.staff);
    const viaAsk = await me.call('POST', '/api/ask', { text: '제로콜라 요청' });
    const same = viaAsk.body.cards[0] as Card;
    expect(same).toMatchObject({ variant: 'pantry-same', headline: "'코카콜라 제로 355'와 같아 보여요", label: '제안' });
    expect(same.actions.primary).toMatchObject({ type: 'fixed', text: '여기에 +1', path: '/api/pantry/votes' });
    expect(same.actions.secondary[0]).toMatchObject({ type: 'post', text: '새 요청으로' });

    const plus = same.actions.primary as Extract<Card['actions']['primary'], { type: 'fixed' }>;
    const voted = await me.call('POST', plus!.path, plus!.body);
    expect(voted.body).toMatchObject({ votes: 2, myVote: true, changed: true });
    expect(await count(t, 'pantry_cards')).toBe(1);
  });

  it('[F3-3] 미리보기를 보는 사이 같은 품목이 올라왔으면 "방금 같은 품목이 올라왔어요"이고, [새 요청으로]는 표시 행과 함께 올라가요', async () => {
    const { t, svc } = await setup();
    const me = await t.loginAs(MOCK.staff);
    const mine = postActionOf(await draft(me, '바나나 요청'));

    const other = fakeUser('b');
    await t.ctx.plans.direct(other, postActionOf(await svc.draftForName(other, '바나나 1송이')).proposalToken, { itemName: '바나나 1송이' });

    const res = await me.call('POST', '/api/plans/direct', { proposalToken: mine.proposalToken, edits: { itemName: mine.itemName } });
    expect(res.body.status).toBe('blocked');
    expect(res.body.card).toMatchObject({ variant: 'pantry-same', headline: PANTRY_TEXT.justPosted, label: '제안' });
    expect(await count(t, 'pantry_cards')).toBe(1);

    const again = postActionOf([res.body.card]);
    const posted = await me.call('POST', '/api/plans/direct', { proposalToken: again.proposalToken, edits: { itemName: again.itemName } });
    expect(posted.body.status).toBe('done');
    const b = await board(me);
    expect(b.items).toHaveLength(2);
    expect(b.items.every((i) => i.similarTo.length === 1)).toBe(true);
  });

  it('[F3-4] 판에 담당 질문을 쓰면 [담당 찾기로 옮기기]이고, 같이 채워요 단독 모드에서는 "여기에는 탕비실 요청만 올려요"예요', async () => {
    const { t } = await setup();
    const me = await t.loginAs(MOCK.staff);
    const [card] = await draft(me, '법인카드 잃어버렸어요');
    expect(card).toMatchObject({
      label: '안내',
      headline: PANTRY_TEXT.moveToAsk,
      actions: { primary: { type: 'navigate', to: 'navi', text: '담당 찾기로 옮기기' } },
    });

    for (const m of ['navi', 'notices', 'rooms'] as const) await t.ctx.ops.setModule('p_operator', m, 'off');
    const [alone] = await draft(me, '법인카드 잃어버렸어요');
    expect(alone!.headline).toBe(PANTRY_TEXT.standaloneOnly);
    expect(alone!.actions.primary).toBeUndefined();
  });

  it('[ADR-03 시험] 미리보기를 오래 두어 만료되면 올리지 않고 "시간이 지나 다시 확인해 주세요"와 고친 이름 그대로의 새 미리보기를 줘요', async () => {
    const { t } = await setup();
    const me = await t.loginAs(MOCK.staff);
    const action = postActionOf(await draft(me, '바나나 요청'));
    t.advance((t.ctx.ops.get().values.proposalTtlSeconds + 1) * 1000);
    const res = await me.call('POST', '/api/plans/direct', { proposalToken: action.proposalToken, edits: { itemName: '바나나 한 송이' } });
    expect(res.body).toMatchObject({ status: 'expired', message: '시간이 지나 다시 확인해 주세요' });
    expect(res.body.cards[0]).toMatchObject({ variant: 'pantry-preview', fields: [{ name: '올라갈 이름', value: '바나나 한 송이' }] });
    expect(await count(t, 'pantry_cards')).toBe(0);
    const again = await me.call('POST', '/api/plans/direct', {
      proposalToken: postActionOf(res.body.cards).proposalToken,
      edits: { itemName: '바나나 한 송이' },
    });
    expect(again.body.status).toBe('done');
  });

  it('[ADR-12·13] 같이 채워요가 꺼지면 게시·판이 막히고, 게시·+1 요청이 많으면 429예요', async () => {
    const { t } = await setup();
    const me = await t.loginAs(MOCK.staff);
    const action = postActionOf(await draft(me, '바나나 요청'));
    const second = postActionOf(await draft(me, '종이컵 요청'));
    t.ctx.ops.patchValues({ rateLimitPerMinute: 1 });
    expect((await me.call('POST', '/api/plans/direct', { proposalToken: action.proposalToken, edits: { itemName: '바나나' } })).body.status).toBe('done');
    const limited = await me.call('POST', '/api/plans/direct', { proposalToken: second.proposalToken, edits: { itemName: '종이컵' } });
    expect(limited).toMatchObject({ status: 429, body: { message: PANTRY_TEXT.rateLimited } });

    t.ctx.ops.patchValues({ rateLimitPerMinute: 10_000 });
    await t.ctx.ops.setModule('p_operator', 'pantry', 'off');
    expect((await me.call('GET', '/api/pantry/board')).status).toBe(409);
    const off = await me.call('POST', '/api/plans/direct', { proposalToken: second.proposalToken, edits: { itemName: '종이컵' } });
    expect(off.body).toMatchObject({ status: 'blocked', card: { label: '막힘' } });
    expect(await count(t, 'pantry_cards')).toBe(1);
  });
});

describe('표: 내 층·상한·투표자 비노출(ADR-07)', () => {
  it('[F3-완료5] 다른 층 사람의 +1·거두기는 거부돼요', async () => {
    const { t } = await setup();
    const staff = await t.loginAs(MOCK.staff);
    expect((await postVia(staff, '바나나 요청')).body.status).toBe('done');
    const bundleId = (await board(staff)).items[0]!.bundleId;

    const dev = await t.loginAs(MOCK.dev);
    const res = await dev.call('POST', '/api/pantry/votes', { bundleId });
    expect(res).toMatchObject({ status: 403, body: { error: 'other-floor', message: PANTRY_TEXT.otherFloor } });
    expect((await dev.call('DELETE', `/api/pantry/votes/${bundleId}`)).status).toBe(403);
    expect((await dev.call('GET', `/api/pantry/board?floor=${F3}`)).status).toBe(403);
  });

  it('[F3-5] 누가 표를 줬는지는 판·내 요청 응답 어디에도 없어요(총무 포함)', async () => {
    const { t, svc } = await setup();
    const voters = [fakeUser('v1'), fakeUser('v2')];
    await t.ctx.plans.direct(voters[0]!, postActionOf(await svc.draftForName(voters[0]!, '원두')).proposalToken, { itemName: '원두' });
    const id = (await svc.board(voters[0]!)).items[0]!.bundleId;
    await svc.vote(voters[1]!, id);

    const staff = await t.loginAs(MOCK.staff);
    const facilities = await t.loginAs(MOCK.facilities);
    const bodies = [
      (await staff.call('GET', '/api/pantry/board')).body,
      (await staff.call('GET', '/api/pantry/my-requests')).body,
      (await facilities.call('GET', `/api/pantry/board?floor=${F3}`)).body,
      (await facilities.call('POST', '/api/pantry/suggestions/collect', { floor: '3층' })).body,
    ];
    const { rows } = await t.db.query<{ pseudonym_id: string }>('select pseudonym_id from pantry_votes');
    for (const body of bodies) {
      const json = JSON.stringify(body);
      for (const r of rows) expect(json).not.toContain(r.pseudonym_id);
      expect(json).not.toContain('가상 사람');
    }
    expect((bodies[2] as BoardResponse).items[0]).toMatchObject({ name: '원두', votes: 2 });
  });

  it('[F3-완료4] 상한을 넘는 +1과 게시는 거부되고, 미리보기 [올리기]도 잠겨요', async () => {
    const { t, svc } = await setup();
    const facilities = await t.loginAs(MOCK.facilities);
    expect((await facilities.call('PUT', `/api/pantry/settings/${F3}`, { minShareWon: 50000, perPersonLimit: 2, cycleNote: '금요일 마감' })).status).toBe(200);
    const author = fakeUser('author');
    for (const name of ['원두', '바나나']) {
      await t.ctx.plans.direct(author, postActionOf(await svc.draftForName(author, name)).proposalToken, { itemName: name });
    }
    // 작성자도 상한 2라서 셋째 게시는 막혀요. 던져서 되돌려지니 카드는 둘이에요.
    const third = postActionOf(await svc.draftForName(author, '종이컵')).proposalToken;
    await expect(t.ctx.plans.direct(author, third, { itemName: '종이컵' })).rejects.toMatchObject({ code: 'vote-limit', status: 409 });
    expect(await count(t, 'pantry_cards')).toBe(2);

    const staff = await t.loginAs(MOCK.staff);
    const ids = (await board(staff)).items.map((i) => i.bundleId);
    expect((await staff.call('POST', '/api/pantry/votes', { bundleId: ids[0] })).status).toBe(200);
    expect((await staff.call('POST', '/api/pantry/votes', { bundleId: ids[1] })).status).toBe(200);
    const preview = await draft(staff, '젤리 요청');
    expect(preview[0]!.fields).toContainEqual({ name: PREVIEW_LIMIT_FIELD, value: PANTRY_TEXT.postLimit });
    const post = await staff.call('POST', '/api/plans/direct', { proposalToken: postActionOf(preview).proposalToken, edits: { itemName: '젤리' } });
    expect(post).toMatchObject({ status: 409, body: { error: 'vote-limit', message: PANTRY_TEXT.postLimit } });

    await staff.call('DELETE', `/api/pantry/votes/${ids[0]}`);
    const retry = await staff.call('POST', '/api/plans/direct', { proposalToken: postActionOf(preview).proposalToken, edits: { itemName: '젤리' } });
    expect(retry.body.status).toBe('done');
    const full = await staff.call('POST', '/api/pantry/votes', { bundleId: ids[0] });
    expect(full).toMatchObject({ status: 409, body: { message: PANTRY_TEXT.voteLimit } });
  });

  it('[R14] 합치기가 풀려 상한을 넘으면 표는 그대로 두고, 새 +1에 안내 문구를 보여 줘요', async () => {
    const { t, svc } = await setup();
    const facilities = await t.loginAs(MOCK.facilities);
    await facilities.call('PUT', `/api/pantry/settings/${F3}`, { minShareWon: 0, perPersonLimit: 2, cycleNote: '' });
    const author = fakeUser('w');
    for (const name of ['원두', '바나나']) {
      await t.ctx.plans.direct(author, postActionOf(await svc.draftForName(author, name)).proposalToken, { itemName: name });
    }
    const author2 = fakeUser('w2');
    for (const name of ['종이컵', '젤리']) {
      await t.ctx.plans.direct(author2, postActionOf(await svc.draftForName(author2, name)).proposalToken, { itemName: name });
    }
    const staff = await t.loginAs(MOCK.staff);
    const [a, b, c, d] = (await board(staff)).items;
    await staff.call('POST', '/api/pantry/votes', { bundleId: a!.bundleId });
    await staff.call('POST', '/api/pantry/votes', { bundleId: b!.bundleId });
    const merged = await facilities.call('POST', '/api/pantry/merges', {
      bundleIds: [a!.bundleId, b!.bundleId],
      versions: [a!.bundleVersion, b!.bundleVersion],
    });
    expect(merged.status).toBe(200);
    expect((await staff.call('POST', '/api/pantry/votes', { bundleId: c!.bundleId })).status).toBe(200);

    const { body: list } = await facilities.call('GET', `/api/pantry/merges?floor=${F3}`);
    const record = list.merges[0];
    expect((await facilities.call('POST', `/api/pantry/merges/${record.mergeId}/revert`, { bundleVersion: record.bundleVersion })).status).toBe(200);

    const after = await board(staff);
    expect(after.myBundleCount).toBe(3);
    expect(after.limit).toBe(2);
    const res = await staff.call('POST', '/api/pantry/votes', { bundleId: d!.bundleId });
    expect(res).toMatchObject({ status: 409, body: { error: 'over-limit', message: PANTRY_TEXT.overLimit } });
  });

  it('[F3-9] 합친 뒤 묶음 표는 서로 다른 사람 수이고, 거두면 그 사람이 묶음 안에 가진 표가 모두 빠져요', async () => {
    const { t, svc } = await setup();
    const [x, y] = [fakeUser('x'), fakeUser('y')];
    await t.ctx.plans.direct(x, postActionOf(await svc.draftForName(x, '녹차')).proposalToken, { itemName: '녹차' });
    const yCards = await svc.draftForName(y, '녹차 티백');
    await t.ctx.plans.direct(y, postActionOf(yCards).proposalToken, { itemName: '녹차 티백' });
    const staff = await t.loginAs(MOCK.staff);
    const items = (await board(staff)).items;
    for (const i of items) await staff.call('POST', '/api/pantry/votes', { bundleId: i.bundleId });
    expect(items.map((i) => i.votes)).toEqual([1, 1]);

    const facilities = await t.loginAs(MOCK.facilities);
    const { body: sug } = await facilities.call('POST', '/api/pantry/suggestions/collect', { floor: '3층' });
    const s = sug.suggestions[0] as MergeSuggestion;
    // 둘 다 카탈로그에 맞았으니 먼저 만든 카드가 대표예요(ADR-07).
    expect(s).toMatchObject({ votesAfter: 3, representativeName: '녹차', catalogName: '녹차 티백 100개입' });
    await facilities.call('POST', '/api/pantry/merges', { bundleIds: [s.a.bundleId, s.b.bundleId], versions: [s.a.bundleVersion, s.b.bundleVersion] });

    const merged = (await board(staff)).items;
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ votes: 3, myVote: true, mergedNames: ['녹차 티백'], name: '녹차', catalogName: '녹차 티백 100개입' });
    await staff.call('DELETE', `/api/pantry/votes/${merged[0]!.bundleId}`);
    expect((await board(staff)).items[0]).toMatchObject({ votes: 2, myVote: false });
    // 직원이 두 카드에 준 표가 모두 빠지고, 가짜 작성자 둘의 표만 남아요.
    expect(await count(t, "pantry_votes where pseudonym_id not like 'p_test_%'")).toBe(0);
  });

  it('[ADR-07 I6] 주문에 들어간 묶음에는 새 표를 줄 수 없어요', async () => {
    const { t, svc } = await setup();
    const a = fakeUser('o');
    await t.ctx.plans.direct(a, postActionOf(await svc.draftForName(a, '원두')).proposalToken, { itemName: '원두' });
    const staff = await t.loginAs(MOCK.staff);
    const id = (await board(staff)).items[0]!.bundleId;
    await t.db.query("update pantry_cards set state = 'ordered' where id = $1", [id]);
    expect(await staff.call('POST', '/api/pantry/votes', { bundleId: id })).toMatchObject({ status: 409, body: { error: 'ordered' } });
  });
});

describe('S4 합치기·되돌리기·따로 두기·설정은 총무만(ADR-07, D8)', () => {
  it('[F3-완료5] 총무가 아닌 사람의 합치기·되돌리기·제안함·설정은 모두 거부돼요', async () => {
    const { t } = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const calls: [method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown][] = [
      ['POST', '/api/pantry/merges', { bundleIds: [1, 2], versions: [0, 0] }],
      ['POST', '/api/pantry/merges/1/revert', { bundleVersion: 0 }],
      ['POST', '/api/pantry/suggestions/keep-apart', { bundleIds: [1, 2] }],
      ['POST', '/api/pantry/suggestions/collect', { floor: '3층' }],
      ['GET', `/api/pantry/suggestions?floor=${F3}`],
      ['GET', `/api/pantry/merges?floor=${F3}`],
      ['GET', '/api/pantry/settings'],
      ['PUT', `/api/pantry/settings/${F3}`, { minShareWon: 0, perPersonLimit: 9, cycleNote: '' }],
    ];
    for (const [method, url, body] of calls) {
      expect((await staff.call(method, url, body)).status, url).toBe(403);
    }
    expect(await count(t, 'pantry_merges')).toBe(0);
  });

  it('[F3-6·7] 같은 상품 표시는 판에 보이고 표는 안 합쳐요. [따로 두기]면 표시가 사라지고 다시 제안하지 않아요', async () => {
    const { t, svc } = await setup();
    const [x, y] = [fakeUser('k1'), fakeUser('k2')];
    await t.ctx.plans.direct(x, postActionOf(await svc.draftForName(x, '생수')).proposalToken, { itemName: '생수' });
    await t.ctx.plans.direct(y, postActionOf(await svc.draftForName(y, '물')).proposalToken, { itemName: '물' });
    const staff = await t.loginAs(MOCK.staff);
    const before = await board(staff);
    expect(before.items.map((i) => [i.name, i.votes, i.similarTo])).toEqual(
      expect.arrayContaining([
        ['생수', 1, ['물']],
        ['물', 1, ['생수']],
      ]),
    );

    const facilities = await t.loginAs(MOCK.facilities);
    const { body } = await facilities.call('GET', `/api/pantry/suggestions?floor=${F3}`);
    expect(body.suggestions).toHaveLength(1);
    const s = body.suggestions[0] as MergeSuggestion;
    expect((await facilities.call('POST', '/api/pantry/suggestions/keep-apart', { bundleIds: [s.a.bundleId, s.b.bundleId] })).body).toEqual({ changed: 1 });
    expect((await board(staff)).items.every((i) => i.similarTo.length === 0)).toBe(true);
    expect((await facilities.call('POST', '/api/pantry/suggestions/collect', { floor: '3층' })).body.suggestions).toEqual([]);
  });

  it('[F3-8·10] 되돌리면 카드별 표가 합치기 전으로 돌아가고, 오래된 버전으로 다시 누르면 충돌 문구예요', async () => {
    const { t, svc } = await setup();
    const [x, y] = [fakeUser('r1'), fakeUser('r2')];
    await t.ctx.plans.direct(x, postActionOf(await svc.draftForName(x, '제로콜라')).proposalToken, { itemName: '제로콜라' });
    const yDraft = await svc.draftForName(y, '코카콜라 제로 355');
    await t.ctx.plans.direct(y, postActionOf(yDraft).proposalToken, { itemName: '코카콜라 제로 355' });
    await svc.vote(x, (await svc.board(x)).items.find((i) => i.name === '코카콜라 제로 355')!.bundleId);

    const facilities = await t.loginAs(MOCK.facilities);
    const s = (await facilities.call('GET', `/api/pantry/suggestions?floor=${F3}`)).body.suggestions[0] as MergeSuggestion;
    expect(s).toMatchObject({ representativeName: '제로콜라', catalogName: '코카콜라 제로 355', votesAfter: 2, source: 'rule' });
    const merged = await facilities.call('POST', '/api/pantry/merges', {
      bundleIds: [s.a.bundleId, s.b.bundleId],
      versions: [s.a.bundleVersion, s.b.bundleVersion],
    });
    expect(merged.body.votes).toBe(2);
    const stale = await facilities.call('POST', '/api/pantry/merges', {
      bundleIds: [s.a.bundleId, s.b.bundleId],
      versions: [s.a.bundleVersion + 5, s.b.bundleVersion],
    });
    expect(stale).toMatchObject({ status: 409, body: { error: 'conflict', message: PANTRY_TEXT.conflict } });

    const record = (await facilities.call('GET', `/api/pantry/merges?floor=${F3}`)).body.merges[0];
    expect(record).toMatchObject({ representativeName: '제로콜라', mergedName: '코카콜라 제로 355' });
    expect((await facilities.call('POST', `/api/pantry/merges/${record.mergeId}/revert`, { bundleVersion: record.bundleVersion })).status).toBe(200);
    expect((await facilities.call('POST', `/api/pantry/merges/${record.mergeId}/revert`, { bundleVersion: record.bundleVersion + 1 })).status).toBe(409);

    const after = (await svc.board(x)).items;
    expect(after.map((i) => [i.name, i.votes]).sort()).toEqual([
      ['제로콜라', 1],
      ['코카콜라 제로 355', 2],
    ]);
    // 되돌린 쌍은 다시 "같은 상품 같아요"예요.
    expect(after.every((i) => i.similarTo.length === 1)).toBe(true);
  });

  it('설정은 층별 최소 몫·표 상한·주기 마감 안내를 바꾸고, 열린 주기 상한도 맞춰요. 공개 글이라 전화번호는 막아요', async () => {
    const { t } = await setup();
    const facilities = await t.loginAs(MOCK.facilities);
    const res = await facilities.call('PUT', `/api/pantry/settings/${F5}`, { minShareWon: 70000, perPersonLimit: 3, cycleNote: '목요일 저녁 마감' });
    expect(res.body).toEqual({ floor: '5층', minShareWon: 70000, perPersonLimit: 3, cycleNote: '목요일 저녁 마감' });
    const { body } = await facilities.call('GET', '/api/pantry/settings');
    expect(body.floors.map((f: { floor: string }) => f.floor)).toEqual(['2층', '3층', '4층', '5층']);
    expect(body.floors.find((f: { floor: string }) => f.floor === '5층')).toMatchObject({ perPersonLimit: 3, cycleNote: '목요일 저녁 마감' });
    const { rows } = await t.db.query<{ per_person_limit: number }>("select per_person_limit from pantry_cycles where floor = '5층' and state = 'open'");
    expect(rows[0]!.per_person_limit).toBe(3);
    const bad = await facilities.call('PUT', `/api/pantry/settings/${F5}`, { minShareWon: 0, perPersonLimit: 3, cycleNote: '문의 010-1234-5678' });
    expect(bad.status).toBe(422);
    const dev = await t.loginAs(MOCK.dev);
    expect((await board(dev)).cycleNote).toBe('목요일 저녁 마감');
  });
});

describe('내 요청·주기(R16, F3-15)', () => {
  it('[F3-15] 내 요청은 표 받는 중 · 주문에 들어감 · 다음 주기로 넘어감으로 보여요', async () => {
    const { t } = await setup();
    const staff = await t.loginAs(MOCK.staff);
    for (const text of ['원두 요청', '바나나 요청']) expect((await postVia(staff, text)).body.status).toBe('done');
    let mine = (await staff.call('GET', '/api/pantry/my-requests')).body.items;
    expect(mine.map((i: { status: string }) => i.status)).toEqual(['표 받는 중', '표 받는 중']);

    // 주문안 확정(주문안 에이전트 몫)을 흉내 내요: 묶음 하나가 '주문됨', 주기가 닫히고 새 주기가 열려요.
    const ordered = (await board(staff)).items.find((i) => i.name === '원두')!;
    await t.db.tx(async (q) => {
      await q.query("update pantry_cards set state = 'ordered' where id = $1", [ordered.bundleId]);
      await q.query("update pantry_cycles set state = 'closed' where floor = '3층' and state = 'open'");
      await q.query("insert into pantry_cycles (floor, cycle_no, state, per_person_limit) values ('3층', 2, 'open', 5)");
    });
    mine = (await staff.call('GET', '/api/pantry/my-requests')).body.items;
    expect(mine).toEqual([
      { bundleId: expect.any(Number), name: '바나나', floor: '3층', votes: 1, status: '다음 주기로 넘어감' },
      { bundleId: ordered.bundleId, name: '원두', floor: '3층', votes: null, status: '주문에 들어감' },
    ]);
    const b = await board(staff);
    expect(b.lastCycle).toEqual({ ordered: ['원두'], carriedOver: 1 });
    expect(b.items.map((i) => [i.name, i.carriedOver])).toEqual([['바나나', true]]);
  });

  it('가상 자료 넣기는 여러 번 불러도 한 번만 들어가요', async () => {
    const { t, svc } = await setup();
    await svc.seed();
    await svc.seed();
    expect(await count(t, 'pantry_catalog')).toBeGreaterThanOrEqual(30);
    const cards = await count(t, 'pantry_cards');
    expect(cards).toBeGreaterThan(0);
    await svc.seed();
    expect(await count(t, 'pantry_cards')).toBe(cards);
    expect(await count(t, "pantry_cycles where state = 'open'")).toBe(4);
  });
});
