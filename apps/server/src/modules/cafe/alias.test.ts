import type { CafeSettleResponse, HomeAskResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { interpretByRules } from '../../core/home';
import { createTestApp, MOCK } from '../../testing';
import { assertNoClash, cleanAliases } from './alias';
import { menuWords, modelInput, readByRules } from './chat';
import { CAFE_MENU_FIXTURES } from './fixtures';

// 후보 16(11/17, ADR-29 보강): 카페 메뉴 줄임말을 총무가 S9 메뉴 관리에서 직접 적어요(AI 없이).
// - 저장은 지금 메뉴 고치기(고정 버튼, 감사 동작 menu-add·menu-update)와 같은 길이고, 줄임말 글은 감사 로그에 없어요.
// - 공통 입력 검사·2~12자·5개까지·다른 메뉴와 겹침·다른 기능 낱말·너무 넓은 말을 거부해요.
// - 낱말 규칙 주문 해석과 홈 낱말(ctx.services.cafe.menuWords)이 DB 줄임말을 써요. 모델에는 보내지 않아요.
// 시계는 2026-10-26(월) 13:00(한국)이에요.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const START = Date.parse('2026-10-26T13:00:00+09:00');

async function setup() {
  const t = await createTestApp({ start: START });
  opened.push(t);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 1000 });
  for (const kind of ['rooms', 'navi', 'pantry', 'notices', 'cafeteria'] as const) await t.modules.find((m) => m.kind === kind)!.seed!();
  await t.ctx.ops.setModule('p_test-operator', 'cafeteria', 'on');
  const staff = await t.loginAs(MOCK.staff);
  const facilities = await t.loginAs(MOCK.facilities);
  const barista = await t.loginAs(MOCK.barista);
  expect((await barista.call('POST', '/api/cafe/board/open')).status).toBe(200);
  return { t, staff, facilities };
}

const aliasesOf = async (t: TestApp, id: string) =>
  (await t.db.query<{ aliases: string[] }>('select aliases from cafe_menu where id = $1', [id])).rows[0]!.aliases;

async function addMenu(me: Session, body: Record<string, unknown>) {
  return me.call('POST', '/api/cafe/menu', { priceWon: 3000, options: ['아이스'], ...body });
}

describe('[후보16] 카페 메뉴 줄임말(총무가 직접 적기)', () => {
  it('[후보16] 총무가 메뉴를 더하거나 고칠 때 줄임말을 저장해요. 띄어쓰기는 없애고, 메뉴 이름·앱 줄임말과 같은 것은 빼요. 빠뜨리면 지금 것 그대로예요', async () => {
    const { t, facilities } = await setup();
    const added = await addMenu(facilities, { name: '자몽에이드', aliases: ['자에', ' 자몽 에이 '] });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ name: '자몽에이드', aliases: ['자에', '자몽에이'], builtinAliases: [] });
    const id = added.body.id as string;

    // 아메리카노: 이름과 같은 줄임말·앱이 원래 아는 "아아"는 빼고 남겨요.
    const put = await facilities.call('PUT', '/api/cafe/menu/americano', {
      name: '아메리카노',
      priceWon: 2000,
      options: ['아이스', '핫', '연하게', '샷 추가'],
      active: true,
      aliases: ['아메리카노', '아아', '아메리'],
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ aliases: ['아메리'], builtinAliases: ['아아', '뜨아', '아메'] });

    // 줄임말 칸을 빼고 고치면 지금 줄임말 그대로예요.
    expect((await facilities.call('PUT', `/api/cafe/menu/${id}`, { name: '자몽에이드', priceWon: 3500, options: [], active: true })).status).toBe(200);
    expect(await aliasesOf(t, id)).toEqual(['자에', '자몽에이']);

    // S9 정산 화면 메뉴에 줄임말과 앱 줄임말(읽기만)이 보여요.
    const settle = (await facilities.call('GET', '/api/cafe/settle')).body as CafeSettleResponse;
    expect(settle.menu.find((m) => m.id === id)).toMatchObject({ aliases: ['자에', '자몽에이'], builtinAliases: [] });
    expect(settle.menu.find((m) => m.id === 'latte')).toMatchObject({ aliases: [], builtinAliases: ['라떼', '라테', '카페라떼'] });

    // 빈 목록으로 보내면 지워요.
    expect((await facilities.call('PUT', `/api/cafe/menu/${id}`, { name: '자몽에이드', priceWon: 3500, options: [], active: true, aliases: [] })).status).toBe(
      200,
    );
    expect(await aliasesOf(t, id)).toEqual([]);
  });

  it('[후보16] 겹침·다른 기능 낱말·너무 넓은 말·길이·글자·개수를 거부하고(400), 거부 문구에 줄임말 글을 되적지 않아요', async () => {
    const { t, facilities } = await setup();
    expect((await addMenu(facilities, { name: '자몽에이드', aliases: ['자에'] })).status).toBe(200);
    const cases: [string, string[]][] = [
      ['다른 메뉴 줄임말과 같음', ['자에']],
      ['다른 메뉴 이름과 같음', ['아이스티']],
      ['다른 메뉴의 앱 줄임말과 같음', ['라떼']],
      ['옵션 이름과 같음', ['샷추가']],
      ['다른 기능 낱말(회의)', ['회의커피']],
      ['다른 기능 낱말(탕비실)', ['탕비실차']],
      ['다른 기능 낱말(휴가)', ['휴가음료']],
      ['다른 기능 낱말(공지)', ['공지차']],
      ['다른 기능 낱말(예약)', ['예약라떼']],
      ['너무 넓은 말(커피)', ['커피']],
      ['너무 넓은 말(음료)', ['음료']],
      ['너무 넓은 말(주문)', ['주문']],
      ['한 글자', ['딸']],
      ['너무 긺', ['딸기'.repeat(7)]],
      ['숫자', ['딸기2']],
      ['문장을 나누는 말', ['말랑딸기']],
      ['같은 말 두 번', ['딸라', '딸 라']],
      ['공통 입력 검사(메일)', ['a@corp.example']],
      ['여섯 개', ['딸라', '딸바', '딸요', '딸쉐', '딸스', '딸크']],
    ];
    for (const [why, aliases] of cases) {
      const res = await addMenu(facilities, { name: '딸기라테', aliases });
      expect(res.status, why).toBe(400);
      for (const a of aliases) if (a.length > 1) expect(JSON.stringify(res.body), why).not.toContain(a.replace(/\s/g, ''));
    }
    // 메뉴 이름을 다른 메뉴 줄임말과 같게 바꿀 수 없어요.
    expect((await facilities.call('PUT', '/api/cafe/menu/latte', { name: '자에', priceWon: 2500, options: [], active: true })).status).toBe(400);
    expect((await t.db.query("select 1 from cafe_menu where name in ('딸기라테', '자에')")).rows).toEqual([]);
  });

  it('[후보16] 총무가 아닌 사람은 줄임말을 저장할 수 없어요(403)', async () => {
    const { t, staff } = await setup();
    const body = { name: '아메리카노', priceWon: 2000, options: ['아이스'], active: true, aliases: ['아메리'] };
    expect((await staff.call('PUT', '/api/cafe/menu/americano', body)).status).toBe(403);
    expect((await staff.call('POST', '/api/cafe/menu', { name: '자몽에이드', priceWon: 3000, options: [], aliases: ['자에'] })).status).toBe(403);
    expect(await aliasesOf(t, 'americano')).toEqual([]);
  });

  it('[후보16·ADR-29 시험] 총무 줄임말로 낱말 규칙 주문과 홈 낱말이 읽혀요(계약 전). 자동 실행은 없고, 모델 입력에는 줄임말이 없어요', async () => {
    const { t, staff, facilities } = await setup();
    const id = (await addMenu(facilities, { name: '자몽에이드', aliases: ['자에'] })).body.id as string;
    // 홈 해석: 줄임말이 카페 낱말이 돼요(core/home.ts는 그대로, ctx.services.cafe.menuWords로 받아요).
    const words = await t.ctx.services.cafe!.menuWords();
    expect(words).toContain('자에');
    expect(interpretByRules('2시에 자에 두 잔', [], words)).toMatchObject({ intent: 'move', moveTo: 'cafe' });
    const res = (await staff.call('POST', '/api/home/ask', { text: '2시에 자에 두 잔' })).body as HomeAskResponse;
    const card = res.cards[0]!;
    expect(card).toMatchObject({ kind: 'cafeteria', label: '제안', evidence: { aiSummarized: false } });
    expect(card.fields).toContainEqual({ name: '메뉴', value: '자몽에이드 × 2' });
    expect(card.fields).toContainEqual({ name: '합계', value: '6,000원' });
    expect((await t.db.query("select count(*)::int as n from plans where module = 'cafeteria'")).rows[0]).toEqual({ n: 0 });
    expect((await t.db.query('select count(*)::int as n from cafe_orders')).rows[0]).toEqual({ n: 0 });

    const menu = CAFE_MENU_FIXTURES.map((m) => ({ id: m.id, name: m.name, options: m.options, aliases: [] as string[] }));
    menu.push({ id, name: '자몽에이드', options: ['아이스'], aliases: ['자에'] });
    expect(readByRules('자에 하나랑 아아 하나', menu)).toEqual({
      lines: [
        { menuId: id, qty: 1, options: [] },
        { menuId: 'americano', qty: 1, options: ['아이스'] },
      ],
      missed: 0,
      near: [],
    });
    // 줄임말이 없으면 못 찾은 메뉴로 세요(앞 줄 옵션으로 붙이지 않아요).
    expect(readByRules('자에 하나랑 아아 하나', menu.slice(0, -1)).missed).toBe(1);
    expect(menuWords(menu)).toContain('자에');
    // 모델에 가는 메뉴 목록(문장 줄 빼고)에는 메뉴 이름·옵션 이름뿐이고 총무 줄임말은 없어요.
    expect(modelInput('자에 하나', menu).split('\n').slice(0, -1).join('\n')).not.toContain('자에');
  });

  it('[후보16·ADR-29 시험] 감사 로그에는 메뉴 고치기 동작만 남고 줄임말 글이 없어요. 메뉴 표는 7일 지우기 대상이 아니에요', async () => {
    const { t, facilities } = await setup();
    const id = (await addMenu(facilities, { name: '자몽에이드', aliases: ['자몽에이'] })).body.id as string;
    await facilities.call('PUT', '/api/cafe/menu/americano', {
      name: '아메리카노',
      priceWon: 2000,
      options: ['아이스', '핫'],
      active: true,
      aliases: ['아메리'],
    });
    // 거부된 줄임말도 남지 않아요.
    await facilities.call('PUT', '/api/cafe/menu/latte', { name: '카페라테', priceWon: 2500, options: [], active: true, aliases: ['회의커피'] });
    const { rows } = await t.db.query<{ action: string; result: string }>(
      "select action, result from audit_log where module = 'cafeteria' and action in ('menu-add', 'menu-update') order by id",
    );
    expect(rows).toEqual([
      { action: 'menu-add', result: 'done' },
      { action: 'menu-update', result: 'done' },
    ]);
    const audit = JSON.stringify((await t.db.query('select * from audit_log')).rows);
    for (const word of ['자몽에이', '아메리', '회의커피']) expect(audit, word).not.toContain(word);
    expect(JSON.stringify((await t.db.query('select * from access_log')).rows)).not.toContain('아메리');

    t.advance(8 * 24 * 60 * 60_000);
    await t.runRetention();
    expect(await aliasesOf(t, id)).toEqual(['자몽에이']);
    expect(await aliasesOf(t, 'americano')).toEqual(['아메리']);
  });
});

describe('[후보16] 줄임말 검사 함수', () => {
  it('[후보16] 메뉴 이름과 같은 줄임말은 빼고, 다른 메뉴와 겹치면 거부해요. 앱 줄임말과 같은 것은 빼요', () => {
    expect(cleanAliases(['녹차 라떼', '녹라'], '녹차라떼')).toEqual(['녹라']);
    const all = [
      { id: 'a', name: '아메리카노', options: ['아이스'], aliases: ['아메리'] },
      { id: 'b', name: '녹차라테', options: [], aliases: [] },
    ];
    expect(assertNoClash('b', '녹차라테', ['녹라', '녹차라떼'], all)).toEqual(['녹라']);
    expect(() => assertNoClash('b', '녹차라테', ['아메리'], all)).toThrow();
    expect(() => assertNoClash('b', '녹차라테', ['아아'], all)).toThrow();
    expect(() => assertNoClash(null, '아메리', [], all)).toThrow();
  });
});
