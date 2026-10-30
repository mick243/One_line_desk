import type { Card, InquiryItem, InquiryListResponse, NotificationsResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../../testing';

// 휴가 요청·승인·반려·답장(10/30, ADR-24). 시험 시계는 2026-10-26(월) 09:00이에요.
// 하늘(재무팀)이 담당 찾기에서 휴가를 물으면 연차 카드에 [휴가 신청하기]가 붙고, 인사팀(지후)이 그 요청 안에서만 하늘의 남은 연차를 봐요.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  await t.modules.find((m) => m.kind === 'navi')!.seed!();
  return { t, haneul: await t.loginAs(MOCK.staff), jihu: await t.loginAs(MOCK.hr), doyun: await t.loginAs(MOCK.dev) };
}

let n = 0;
const requestId = () => `req-${Date.now().toString(36)}-${(n += 1)}`;
const REASON = '가족 행사 LEAVECANARY5';
type Session = Awaited<ReturnType<TestApp['loginAs']>>;

async function leaveCard(me: Session, text: string): Promise<Card> {
  const cards = (await me.call('POST', '/api/ask', { text, kind: 'navi' })).body.cards as Card[];
  return cards.find((c) => c.id === 'navi-my-leave')!;
}
const remainingOf = async (me: Session) => Number((await leaveCard(me, '내 연차 몇 개 남았어?')).headline.match(/([\d.]+)일/)![1]);
const sendLeave = (me: Session, days: { date: string; kind: 'full' | 'half' }[], reason = REASON) =>
  me.call('POST', '/api/navi/inquiries', { rowId: 'HR-02', question: '휴가 신청', reason, requestId: requestId(), leave: { days } });
const inbox = async (me: Session) => ((await me.call('GET', '/api/navi/inquiries/inbox')).body as InquiryListResponse).items;
const mine = async (me: Session) => ((await me.call('GET', '/api/navi/inquiries/mine')).body as InquiryListResponse).items;

describe('휴가 요청(ADR-24)', () => {
  it('휴가를 물으면 연차 카드에 [휴가 신청하기]가 붙고, 질문에서 읽은 날을 미리 채워요', async () => {
    const { haneul } = await setup();
    const card = await leaveCard(haneul, '다음 주 화수 휴가 쓰고 싶어');
    const action = card.actions.secondary.find((a) => a.type === 'leave-request');
    expect(action).toMatchObject({
      type: 'leave-request',
      text: '휴가 신청하기',
      rowId: 'HR-02',
      team: '인사팀',
      task: '휴가 신청',
      days: [
        { date: '2026-11-03', kind: 'full' },
        { date: '2026-11-04', kind: 'full' },
      ],
    });
    expect(action && action.type === 'leave-request' && action.remaining).toBe(await remainingOf(haneul));
    // 날 없이 양만 말하면 고를 일수만 알려 줘요.
    const amount = (await leaveCard(haneul, '연차 이틀 쓰면 몇 개 남아?')).actions.secondary.find((a) => a.type === 'leave-request');
    expect(amount).toMatchObject({ days: [], planned: 2 });
  });

  it('보내면 인사팀 받은 문의함에만 가고, 인사팀은 그 요청 안에서 보낸 사람 남은 연차를 봐요(승인하면 몇 일 남는지도)', async () => {
    const { t, haneul, jihu, doyun } = await setup();
    const before = await remainingOf(haneul);
    const sent = await sendLeave(haneul, [
      { date: '2026-11-04', kind: 'half' },
      { date: '2026-11-03', kind: 'full' },
    ]);
    expect(sent.status).toBe(200);
    expect(sent.body.card).toMatchObject({ label: '확정', headline: '인사팀에 휴가 요청을 보냈어요' });
    expect(sent.body.card.fields).toContainEqual({ name: '쓸 날', value: '11월 3일(화) 하루 · 11월 4일(수) 반차 · 연차 1.5일' });

    const [item] = await inbox(jihu);
    expect(item).toMatchObject({
      kind: 'leave',
      state: 'new',
      question: '휴가 신청 · 11월 3일(화) 하루 · 11월 4일(수) 반차',
      reason: REASON,
      sender: { name: '가상 직원 하늘', department: '재무팀' },
      leave: { total: 1.5, balance: { remaining: before, after: before - 1.5 } },
      canDecide: true,
      canReply: true,
    });
    // 휴가 요청은 [처리했어요] 대신 승인·반려예요.
    expect(item!.actions.map((a) => a.text)).toEqual(['확인했어요']);
    // 보낸 사람 화면에는 남은 연차 칸이 따로 오지 않아요(본인 연차는 연차 카드로 봐요). 다른 부서는 받은 문의함에 아무것도 없어요.
    expect((await mine(haneul))[0]!.leave).toEqual({ days: expect.any(Array), total: 1.5 });
    expect(await inbox(doyun)).toEqual([]);
    // 인사팀 알림에는 날짜·사유가 없어요.
    const note = ((await jihu.call('GET', '/api/notifications')).body as NotificationsResponse).items[0]!;
    expect(note.title).toBe('인사팀에 휴가 요청이 왔어요 · 휴가 신청');
    expect(JSON.stringify(note)).not.toMatch(/LEAVECANARY5|11월/);
    // 사유는 감사 로그에 남지 않아요.
    const audit = await t.db.query<{ row: string }>('select row_to_json(a)::text as row from audit_log a');
    expect(audit.rows.map((r) => r.row).join('\n')).not.toContain('LEAVECANARY5');
  });

  it('승인하면 근태 기록에 들어가 남은 연차에서 바로 빠지고, 보낸 사람에게 알려요. 두 번 승인되지 않아요', async () => {
    const { haneul, jihu } = await setup();
    const before = await remainingOf(haneul);
    await sendLeave(haneul, [
      { date: '2026-11-03', kind: 'full' },
      { date: '2026-11-04', kind: 'half' },
    ]);
    const [item] = await inbox(jihu);
    const ok = await jihu.call('POST', `/api/navi/inquiries/${item!.id}/decision`, { decision: 'approved' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: 'approved', recorded: true });
    expect(await remainingOf(haneul)).toBe(before - 1.5);
    expect((await mine(haneul))[0]).toMatchObject({ state: 'approved', recorded: true });
    const note = ((await haneul.call('GET', '/api/notifications')).body as NotificationsResponse).items[0]!;
    expect(note.title).toBe('인사팀이 휴가 요청을 승인했어요 · 휴가 신청');

    expect((await jihu.call('POST', `/api/navi/inquiries/${item!.id}/decision`, { decision: 'approved' })).status).toBe(404);
    expect(await remainingOf(haneul)).toBe(before - 1.5);
    // 결정한 요청에는 남은 연차가 더 오지 않아요.
    expect((await inbox(jihu))[0]).toMatchObject({ canDecide: false, leave: { total: 1.5 } });
    expect((await inbox(jihu))[0]!.leave!.balance).toBeUndefined();
    // 승인된 날로 다시 신청하면 막아요.
    expect((await sendLeave(haneul, [{ date: '2026-11-03', kind: 'full' }])).status).toBe(409);
  });

  it('반려는 사유가 꼭 있어야 하고, 보낸 사람은 내 문의에서 사유를 봐요. 남은 연차는 그대로예요', async () => {
    const { haneul, jihu } = await setup();
    const before = await remainingOf(haneul);
    await sendLeave(haneul, [{ date: '2026-11-03', kind: 'full' }]);
    const [item] = await inbox(jihu);
    const path = `/api/navi/inquiries/${item!.id}/decision`;
    expect((await jihu.call('POST', path, { decision: 'rejected' })).status).toBe(400);
    expect((await jihu.call('POST', path, { decision: 'rejected', reason: '   ' })).status).toBe(400);
    const no = await jihu.call('POST', path, { decision: 'rejected', reason: '그 주는 결산 마감이에요. 다음 주로 다시 신청해 주세요' });
    expect(no.status).toBe(200);
    expect((await mine(haneul))[0]).toMatchObject({ state: 'rejected', decisionReason: '그 주는 결산 마감이에요. 다음 주로 다시 신청해 주세요' });
    expect(await remainingOf(haneul)).toBe(before);
    const note = ((await haneul.call('GET', '/api/notifications')).body as NotificationsResponse).items[0]!;
    expect(note.title).toBe('인사팀이 휴가 요청을 반려했어요 · 휴가 신청');
    expect(note.title).not.toContain('결산');
  });

  it('받은 부서만 승인·반려·답장해요. 다른 부서·보낸 사람은 못 해요', async () => {
    const { haneul, jihu, doyun } = await setup();
    await sendLeave(haneul, [{ date: '2026-11-03', kind: 'full' }]);
    const [item] = await inbox(jihu);
    for (const me of [haneul, doyun]) {
      expect((await me.call('POST', `/api/navi/inquiries/${item!.id}/decision`, { decision: 'approved' })).status).toBe(404);
      expect((await me.call('POST', `/api/navi/inquiries/${item!.id}/reply`, { text: '안녕하세요', requestId: requestId() })).status).toBe(404);
    }
  });

  it('날 검사: 지난 날·주말·같은 날 두 번·이미 근태 기록에 있는 날은 보내지 않아요', async () => {
    const { haneul } = await setup();
    const reject = async (days: { date: string; kind: 'full' | 'half' }[], status: number, message: RegExp) => {
      const res = await sendLeave(haneul, days);
      expect(res.status, JSON.stringify(days)).toBe(status);
      expect(res.body.message).toMatch(message);
    };
    await reject([{ date: '2026-10-23', kind: 'full' }], 400, /지난 날/);
    await reject([{ date: '2026-10-31', kind: 'full' }], 400, /주말/);
    await reject(
      [
        { date: '2026-11-03', kind: 'full' },
        { date: '2026-11-03', kind: 'half' },
      ],
      400,
      /두 번/,
    );
    // 하늘은 11월 6일이 이미 예정이에요(가상 근태 기록).
    await reject([{ date: '2026-11-06', kind: 'full' }], 409, /이미 근태 기록에 있는 날/);
    // 휴가 요청은 분장표의 휴가 신청 업무로만 가요.
    const res = await haneul.call('POST', '/api/navi/inquiries', {
      rowId: null,
      question: '휴가',
      reason: REASON,
      requestId: requestId(),
      leave: { days: [{ date: '2026-11-03', kind: 'full' }] },
    });
    expect(res.status).toBe(400);
  });
});

describe('연차 기간별 계산(10/30 버그: 다음 기간 날인데 "7.5일 → 7.5일"로만 보였어요)', () => {
  it('다음 연차 기간 날은 이번 기간 연차에서 빼지 않고, 다음 기간 연차에서 따로 계산해요. 승인하면 다음 기간에서 빠져요', async () => {
    // 도윤: 2025-12-01 입사라 이번 연차 기간은 2026-11-30까지예요. 2027년 2월은 다음 기간(근속 1년, 15일)이에요.
    const { doyun, jihu } = await setup();
    const action = (await leaveCard(doyun, '내 연차 몇 개 남았어?')).actions.secondary.find((a) => a.type === 'leave-request');
    expect(action).toMatchObject({ periodEnd: '2026-11-30', next: { periodStart: '2026-12-01', remaining: 15 } });

    await sendLeave(doyun, [
      { date: '2027-02-04', kind: 'full' },
      { date: '2027-02-08', kind: 'full' },
    ]);
    const [first] = await inbox(jihu);
    const now = first!.leave!.balance!;
    expect(now).toMatchObject({
      periodEnd: '2026-11-30',
      days: 0,
      after: now.remaining,
      next: { periodStart: '2026-12-01', remaining: 15, after: 13, days: 2 },
    });

    expect((await jihu.call('POST', `/api/navi/inquiries/${first!.id}/decision`, { decision: 'approved' })).status).toBe(200);
    // 이번 기간과 다음 기간에 걸친 새 요청: 이번 기간 하루, 다음 기간 하루. 다음 기간은 승인된 2일이 이미 빠져 있어요.
    await sendLeave(doyun, [
      { date: '2026-11-27', kind: 'full' },
      { date: '2027-03-02', kind: 'half' },
    ]);
    const second = (await inbox(jihu)).find((i) => i.state === 'new')!.leave!.balance!;
    expect(second).toMatchObject({ remaining: now.remaining, after: now.remaining - 1, days: 1, next: { remaining: 13, after: 12.5, days: 0.5 } });
  });
});

describe('답장(ADR-24)', () => {
  it('받은 팀이 답장하면 보낸 사람 내 문의에 이름과 함께 보이고, 알림에는 글이 없어요. 같은 requestId는 한 번만 들어가요', async () => {
    const { haneul, jihu } = await setup();
    await haneul.call('POST', '/api/navi/inquiries', { rowId: 'HR-01', question: '재직증명서가 필요해요', reason: '은행 제출', requestId: requestId() });
    const [item] = await inbox(jihu);
    const rid = requestId();
    const body = { text: '내일 오전까지 메일로 보내 드릴게요 REPLYCANARY3', requestId: rid };
    expect((await jihu.call('POST', `/api/navi/inquiries/${item!.id}/reply`, body)).status).toBe(200);
    expect((await jihu.call('POST', `/api/navi/inquiries/${item!.id}/reply`, body)).status).toBe(200);
    const got: InquiryItem = (await mine(haneul))[0]!;
    expect(got.replies).toEqual([{ from: 'team', name: '가상 인사 지후', text: '내일 오전까지 메일로 보내 드릴게요 REPLYCANARY3', at: expect.any(String) }]);
    expect((await inbox(jihu))[0]!.replies).toHaveLength(1);
    const notes = ((await haneul.call('GET', '/api/notifications')).body as NotificationsResponse).items;
    expect(notes.map((x) => x.title)).toContain('인사팀이 문의에 답장했어요 · 재직증명서 발급');
    expect(JSON.stringify(notes)).not.toContain('REPLYCANARY3');
    // 키 같은 글은 답장에도 넣지 못해요(ADR-11).
    expect((await jihu.call('POST', `/api/navi/inquiries/${item!.id}/reply`, { text: '비밀번호는 abc123!@#이에요', requestId: requestId() })).status).toBe(400);
  });

  it('7일이 지나면 문의와 답장이 같이 지워져요(ADR-21)', async () => {
    const { t, haneul, jihu } = await setup();
    await sendLeave(haneul, [{ date: '2026-11-03', kind: 'full' }]);
    const [item] = await inbox(jihu);
    await jihu.call('POST', `/api/navi/inquiries/${item!.id}/reply`, { text: '확인했어요', requestId: requestId() });
    t.advance(7 * 24 * 60 * 60_000 + 60_000);
    // 쉬는 시간이 지나 세션이 끊겨서 다시 들어와요.
    expect(await inbox(await t.loginAs(MOCK.hr))).toEqual([]);
    expect((await t.db.query('select 1 from navi_inquiry_replies')).rows).toHaveLength(0);
  });
});
