import type { InquiryListResponse, NotificationsResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../../testing';

// 담당 팀에 문의 보내기와 앱 안 알림(10/26, ADR-16).
// 재직증명서 발급(HR-01)은 인사팀 행이에요. 가상 직원: 도윤(개발팀) → 인사팀, 지후(인사팀)가 받아요.

const QUESTION = '재직증명서 직인본이 필요해요 INQCANARY7';
const REASON = '은행 대출 서류로 내야 해요';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  await t.modules.find((m) => m.kind === 'navi')!.seed!();
  return t;
}

let n = 0;
const requestId = () => `req-${Date.now().toString(36)}-${(n += 1)}`;

describe('담당 팀에 문의 보내기(ADR-16)', () => {
  it('[ADR-16] 담당 카드에 [인사팀에 문의하기]가 있고, 보내면 인사팀 받은 문의함에만 보여요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const card = (await doyun.call('POST', '/api/ask', { text: '재직증명서 어디서 떼요?', kind: 'navi' })).body.cards[0];
    expect(card.actions.secondary).toEqual([{ type: 'inquire', text: '인사팀에 문의하기', rowId: 'HR-01', team: '인사팀', task: '재직증명서 발급' }]);

    const sent = await doyun.call('POST', '/api/navi/inquiries', { rowId: 'HR-01', question: QUESTION, reason: REASON, requestId: requestId() });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'done', card: { label: '확정', headline: '인사팀에 보냈어요' } });
    // 답 글은 앱으로 오지 않아요. 실제 동작대로 "처리 상태"만 알린다고 적어요(10/29 개선 회의 C1).
    expect(sent.body.card.evidence.text).toBe('처리 상태가 바뀌면 알려 드려요. 답은 그 팀이 따로 연락해요. 담당 찾기 "내 문의"에서도 볼 수 있어요');

    const jihu = await t.loginAs(MOCK.hr);
    const inbox = (await jihu.call('GET', '/api/navi/inquiries/inbox')).body as InquiryListResponse;
    expect(inbox.enabled).toBe(true);
    expect(inbox.items).toEqual([
      expect.objectContaining({
        task: '재직증명서 발급',
        team: '인사팀',
        question: QUESTION,
        reason: REASON,
        state: 'new',
        sender: { name: '가상 직원 도윤', department: '개발팀' },
      }),
    ]);
    expect(inbox.items[0]!.actions.map((a) => a.text)).toEqual(['확인했어요', '처리했어요']);

    // 다른 부서(재무팀 하늘)는 받은 문의함에 아무것도 없어요.
    const haneul = await t.loginAs(MOCK.staff);
    expect(((await haneul.call('GET', '/api/navi/inquiries/inbox')).body as InquiryListResponse).items).toEqual([]);
    // 받은 문의함이 없는 부서(개발팀)는 닫혀 있어요.
    expect(((await doyun.call('GET', '/api/navi/inquiries/inbox')).body as InquiryListResponse).enabled).toBe(false);
    // 보낸 사람은 내 문의에서 상태를 봐요(보낸 사람 칸은 없어요).
    const mine = (await doyun.call('GET', '/api/navi/inquiries/mine')).body as InquiryListResponse;
    expect(mine.items).toEqual([expect.objectContaining({ question: QUESTION, state: 'new', actions: [] })]);
    expect(mine.items[0]!.sender).toBeUndefined();
  });

  it('[ADR-16] 보내면 인사팀에 알림이 가고, 알림 글에는 문의 내용이 없어요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    await doyun.call('POST', '/api/navi/inquiries', { rowId: 'HR-01', question: QUESTION, reason: REASON, requestId: requestId() });

    const jihu = await t.loginAs(MOCK.hr);
    const box = (await jihu.call('GET', '/api/notifications')).body as NotificationsResponse;
    expect(box.unread).toBe(1);
    expect(box.items).toEqual([expect.objectContaining({ title: '인사팀에 새 문의가 왔어요 · 재직증명서 발급', page: 'navi', read: false })]);
    expect(JSON.stringify(box)).not.toContain('INQCANARY7');
    // 보낸 사람·다른 부서에는 가지 않아요.
    expect(((await doyun.call('GET', '/api/notifications')).body as NotificationsResponse).unread).toBe(0);
    expect(((await (await t.loginAs(MOCK.staff)).call('GET', '/api/notifications')).body as NotificationsResponse).items).toEqual([]);

    // 읽음은 사람마다예요.
    const after = (await jihu.call('POST', '/api/notifications/read', { ids: [box.items[0]!.id] })).body as NotificationsResponse;
    expect(after.unread).toBe(0);
    const notifRows = (await t.db.query<{ title: string }>('select title from notifications')).rows;
    expect(JSON.stringify(notifRows)).not.toContain('INQCANARY7');
  });

  it('[ADR-21] 7일 지난 알림은 목록에 보이지 않고, 목록을 읽어도 지우지 않아요. 지우기는 보관 잡이 해요(10/29 개선 회의 A6)', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    await doyun.call('POST', '/api/navi/inquiries', { rowId: 'HR-01', question: QUESTION, reason: REASON, requestId: requestId() });
    const count = async () => (await t.db.query<{ n: number }>('select count(*)::int as n from notifications')).rows[0]!.n;
    expect(await count()).toBe(1);

    t.advance(8 * 24 * 60 * 60 * 1000);
    const jihu = await t.loginAs(MOCK.hr);
    const deletes: string[] = [];
    const query = t.db.query.bind(t.db);
    t.db.query = ((sql: string, params?: unknown[]) => {
      if (/^\s*delete/i.test(sql)) deletes.push(sql);
      return query(sql, params);
    }) as typeof t.db.query;
    const box = (await jihu.call('GET', '/api/notifications')).body as NotificationsResponse;
    t.db.query = query;
    expect(box).toEqual({ unread: 0, items: [] });
    expect(deletes.filter((s) => s.includes('notifications'))).toEqual([]);
    expect(await count()).toBe(1);

    await t.runRetention();
    expect(await count()).toBe(0);
  });

  it('[ADR-16] 받은 부서가 [확인했어요]·[처리했어요]를 누르면 보낸 사람에게 알림이 가요(다른 부서는 못 바꿔요)', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    await doyun.call('POST', '/api/navi/inquiries', { rowId: 'HR-01', question: QUESTION, reason: REASON, requestId: requestId() });
    const jihu = await t.loginAs(MOCK.hr);
    const id = ((await jihu.call('GET', '/api/navi/inquiries/inbox')).body as InquiryListResponse).items[0]!.id;

    const haneul = await t.loginAs(MOCK.staff);
    expect((await haneul.call('POST', `/api/navi/inquiries/${id}/state`, { state: 'done' })).status).toBe(404);

    expect((await jihu.call('POST', `/api/navi/inquiries/${id}/state`, { state: 'seen' })).body).toMatchObject({ state: 'seen' });
    expect((await jihu.call('POST', `/api/navi/inquiries/${id}/state`, { state: 'seen' })).status).toBe(404);
    expect((await jihu.call('POST', `/api/navi/inquiries/${id}/state`, { state: 'done' })).body).toMatchObject({ state: 'done', actions: [] });

    const box = (await doyun.call('GET', '/api/notifications')).body as NotificationsResponse;
    expect(box.items.map((i) => i.title)).toEqual(['인사팀이 문의를 처리했어요 · 재직증명서 발급', '인사팀이 문의를 확인했어요 · 재직증명서 발급']);
    expect(((await doyun.call('GET', '/api/navi/inquiries/mine')).body as InquiryListResponse).items[0]!.state).toBe('done');
  });

  it('[ADR-16·ADR-11] 같은 요청은 한 번만 들어가고, 키·주민번호·건강 정보가 든 글은 보내지 않아요(LLM 호출 0건)', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const id = requestId();
    const body = { rowId: 'HR-01', question: QUESTION, reason: REASON, requestId: id };
    const first = await doyun.call('POST', '/api/navi/inquiries', body);
    const second = await doyun.call('POST', '/api/navi/inquiries', body);
    expect(second.body).toEqual(first.body);
    expect((await t.db.query('select * from navi_inquiries')).rows).toHaveLength(1);

    const locked = await doyun.call('POST', '/api/navi/inquiries', { ...body, requestId: requestId(), question: '토큰 AKIAABCDEFGHIJKLMNOP 이 안 돼요' });
    expect(locked.status).toBe(400);
    expect(JSON.stringify(locked.body)).not.toContain('AKIA');
    expect((await doyun.call('POST', '/api/navi/inquiries', { ...body, requestId: requestId(), reason: '' })).status).toBe(400);
    expect((await doyun.call('POST', '/api/navi/inquiries', { ...body, requestId: requestId(), extra: 1 })).status).toBe(400);
    expect((await t.db.query('select * from navi_inquiries')).rows).toHaveLength(1);
    expect((await t.db.query('select * from ai_usage')).rows).toHaveLength(0);

    // 감사 로그에는 내용이 없어요.
    const audit = JSON.stringify((await t.db.query('select * from audit_log')).rows);
    expect(audit).toContain('inquiry.send');
    expect(audit).not.toContain('INQCANARY7');
  });

  it('[ADR-16] 분장표에서 못 찾은 질문은 총무팀으로 보내요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const card = (await doyun.call('POST', '/api/ask', { text: '무지개 색 고양이 사진 공유', kind: 'navi' })).body.cards[0];
    expect(card.actions.secondary).toEqual([expect.objectContaining({ type: 'inquire', rowId: null, team: '총무팀' })]);
    await doyun.call('POST', '/api/navi/inquiries', {
      rowId: null,
      question: '이건 어디에 물어봐야 해요?',
      reason: '분장표에 없어서요',
      requestId: requestId(),
    });
    const seoyeon = await t.loginAs(MOCK.facilities);
    const inbox = (await seoyeon.call('GET', '/api/navi/inquiries/inbox')).body as InquiryListResponse;
    expect(inbox.items).toEqual([expect.objectContaining({ team: '총무팀', task: '분장표에 없는 문의' })]);
  });

  it('[R4] 담당 찾기가 꺼지면 보낼 수 없어요', async () => {
    const t = await setup();
    // 담당 찾기 끔은 같이 채워요 단독 모드에서만 돼요(ADR-12, QA-14).
    for (const m of ['notices', 'rooms', 'navi'] as const) await t.ctx.ops.setModule('p_test_operator', m, 'off');
    const doyun = await t.loginAs(MOCK.dev);
    expect((await doyun.call('POST', '/api/navi/inquiries', { rowId: 'HR-01', question: QUESTION, reason: REASON, requestId: requestId() })).status).toBe(409);
  });
});
