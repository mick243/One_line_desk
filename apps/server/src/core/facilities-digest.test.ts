import type { NotificationsResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../testing';

// 총무 확인 대기 아침 요약(11/25 자동화 후보 5). 시험 시계는 2026-10-26(월) 9:00(한국 시각)에서 시작해요.

const HOUR = 60 * 60 * 1000;
type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup(start?: number) {
  const t = await createTestApp(start === undefined ? {} : { start });
  opened.push(t);
  return t;
}

// 시계를 하루씩 넘기면 세션이 쉬는 시간으로 끊겨서, 볼 때마다 다시 로그인해요.
const digestsOf = async (t: TestApp, subject: string) =>
  ((await (await t.loginAs(subject)).call('GET', '/api/notifications')).body as NotificationsResponse).items.filter((i) => i.title.startsWith('확인할 일이'));

describe('[11/25] 총무 확인 대기 아침 요약', () => {
  it('근무일 9시대 첫 회차에 한 번, 종류와 수만 총무에게 보내요. 대기가 가장 많은 종류의 페이지가 열려요', async () => {
    const t = await setup();
    const fake = { notices: 2, cafe: 0, missed: 1 };
    t.ctx.services.facilitiesPending = [
      { label: '공지 알림 대상', page: 'notices', count: async () => fake.notices },
      { label: '카페 한도 요청', page: 'cafe-settle', count: async () => fake.cafe },
      { label: '카페 못 받았어요', page: 'cafe-settle', count: async () => fake.missed },
    ];
    await t.runRetention();
    const [first, ...rest] = await digestsOf(t, MOCK.facilities);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ title: '확인할 일이 3건 있어요 · 공지 알림 대상 2 · 카페 못 받았어요 1', page: 'notices' });

    // 같은 날 다시 돌아도(5분 재시도 등) 한 번만이에요.
    t.advance(30 * 60 * 1000);
    await t.runRetention();
    expect(await digestsOf(t, MOCK.facilities)).toHaveLength(1);

    // 9시대가 아니면 보내지 않아요.
    t.advance(2 * HOUR);
    await t.runRetention();
    expect(await digestsOf(t, MOCK.facilities)).toHaveLength(1);

    // 다음 날 9시대에 다시 가요. 총무가 아닌 사람에게는 가지 않아요.
    t.advance(24 * HOUR - 2.5 * HOUR);
    await t.runRetention();
    expect(await digestsOf(t, MOCK.facilities)).toHaveLength(2);
    expect(await digestsOf(t, MOCK.staff)).toEqual([]);
    expect(await digestsOf(t, MOCK.operator)).toEqual([]);
  });

  it('대기가 0이면 보내지 않고, 주말에는 보내지 않아요', async () => {
    const t = await setup(Date.parse('2026-10-31T09:10:00+09:00')); // 토요일
    let n = 1;
    t.ctx.services.facilitiesPending = [{ label: '공지 알림 대상', page: 'notices', count: async () => n }];
    await t.runRetention();
    expect(await digestsOf(t, MOCK.facilities)).toEqual([]);
    t.advance(2 * 24 * HOUR); // 월요일인데 대기가 0
    n = 0;
    await t.runRetention();
    expect(await digestsOf(t, MOCK.facilities)).toEqual([]);
  });

  it('공지·카페 모듈이 자기 표에서 센 수를 내놓아요(처리 전 한도 요청 1건)', async () => {
    const t = await setup();
    const sources = t.ctx.services.facilitiesPending ?? [];
    expect(sources.map((s) => s.label)).toEqual(expect.arrayContaining(['공지 알림 대상', '카페 한도 요청', '카페 못 받았어요']));
    const limit = sources.find((s) => s.label === '카페 한도 요청')!;
    expect(await limit.count()).toBe(0);
    await t.db.query(
      "insert into cafe_limit_requests (pseudonym_id, idp_subject, month, amount_won, status, created_at) values ('p_test', 'mock|emp-002', '2026-10', 600000, 'pending', now())",
    );
    expect(await limit.count()).toBe(1);
    await t.runRetention();
    expect((await digestsOf(t, MOCK.facilities))[0]?.title).toBe('확인할 일이 1건 있어요 · 카페 한도 요청 1');
  });
});
