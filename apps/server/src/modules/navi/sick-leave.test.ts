import type { Card, InquiryListResponse, NotificationsResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { LeaveUse } from '../../adapters/types';
import { createTestApp, MOCK } from '../../testing';
import { computeLeave, isSickLeaveQuestion, needsSickNote, readSickDates, sickUsage } from './leave';

// 병가 요청(11/3, ADR-24 개정, docs/병가준비_2026-11-01.md). 시험 시계는 2026-10-26(월) 09:00이에요.
// 하늘(재무팀)의 가상 근태 기록에는 올해 병가 1.5일(1월 19일 하루·9월 7일 반차)과 지난해 병가(2025-12-15)가 있어요.
// 사용자 결정: ① 사유는 정해진 선택지만 ② 지난 3일까지 ③ 하루·반차 ④ 연간 한도는 운영 값(0이면 없음) ⑤ 운영 값 일수(기본 3일)를 넘으면 진단서 안내 ⑥ 유급·무급은 계산 안 함.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
type Day = { date: string; kind: 'full' | 'half'; half?: 'am' | 'pm' };
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 10_000 });
  await t.modules.find((m) => m.kind === 'navi')!.seed!();
  return { t, haneul: await t.loginAs(MOCK.staff), jihu: await t.loginAs(MOCK.hr) };
}

let n = 0;
const requestId = () => `sick-${Date.now().toString(36)}-${(n += 1)}`;
const ask = async (me: Session, text: string) => (await me.call('POST', '/api/ask', { text, kind: 'navi' })).body.cards as Card[];
const field = (card: Card | undefined, name: string) => card?.fields.find((f) => f.name === name)?.value;
const sickCard = async (me: Session, text = '병가 쓰고 싶어요') => (await ask(me, text)).find((c) => c.id === 'navi-sick-leave');
const remainingOf = async (me: Session) =>
  Number((await ask(me, '내 연차 몇 개 남았어?')).find((c) => c.id === 'navi-my-leave')!.headline.match(/([\d.]+)일/)![1]);
const sendSick = (me: Session, days: Day[], sickReason: string | null = 'clinic', extra: Record<string, unknown> = {}) =>
  me.call('POST', '/api/navi/inquiries', {
    rowId: 'HR-02',
    question: '병가 신청',
    requestId: requestId(),
    leave: { days, type: 'sick', ...(sickReason ? { sickReason } : {}) },
    ...extra,
  });
const inbox = async (me: Session) => ((await me.call('GET', '/api/navi/inquiries/inbox')).body as InquiryListResponse).items;
const notes = async (me: Session) => ((await me.call('GET', '/api/notifications')).body as NotificationsResponse).items;

describe('병가 계산(서버 규칙, ADR-18)', () => {
  const uses: LeaveUse[] = [
    { date: '2025-12-15', kind: 'full', type: 'sick' },
    { date: '2026-01-19', kind: 'full', type: 'sick' },
    { date: '2026-09-07', kind: 'half', type: 'sick' },
    { date: '2026-04-01', kind: 'full' },
    { date: '2026-04-02', kind: 'full', type: 'official' },
  ];

  it('[병가-4] 올해 병가는 올해 근태 기록의 병가만 세요(반차 0.5). 한도 0은 "없음"(null)이에요', () => {
    const record = { hireDate: '2020-03-02', uses };
    expect(sickUsage(record, '2026-10-26', 0)).toEqual({ year: 2026, used: 1.5, limit: null });
    expect(sickUsage(record, '2026-10-26', 10)).toEqual({ year: 2026, used: 1.5, limit: 10 });
    expect(sickUsage(record, '2025-12-20', 0)).toMatchObject({ year: 2025, used: 1 });
  });

  it('[병가-연차] 병가는 남은 연차 계산에서 빠지지 않아요', () => {
    expect(computeLeave({ hireDate: '2020-03-02', uses }, '2026-10-26')).toMatchObject({ usedFull: 1, usedHalf: 0, used: 1 });
  });

  it('[병가-5] 진단서 안내는 요청 일수가 기준 일수를 "넘을" 때만이에요(같으면 아니에요)', () => {
    const full = (k: number): Day[] => Array.from({ length: k }, (_, i) => ({ date: `2026-11-0${i + 2}`, kind: 'full' }));
    expect(needsSickNote(full(3), 3)).toBe(false);
    expect(needsSickNote([...full(3), { date: '2026-11-05', kind: 'half' }], 3)).toBe(true);
    expect(needsSickNote(full(4), 3)).toBe(true);
    expect(needsSickNote(full(2), 1)).toBe(true);
  });

  it('[병가-질문] 병가 질문은 규칙으로만 알아보고, "오늘·어제·그제"는 지난 3일 안의 평일만 읽어요', () => {
    for (const q of ['병가 쓰고 싶어요', '병가 신청 어디서 해요?', '아파서 오늘 쉬어야 해요', '몸이 안 좋아서 출근 못 해요'])
      expect(isSickLeaveQuestion(q), q).toBe(true);
    for (const q of ['내 연차 몇 개 남았어?', '병원 위치 알려줘', '공가 쓰고 싶어요']) expect(isSickLeaveQuestion(q), q).toBe(false);
    // 2026-10-27(화): 어제 = 26일(월), 그제 = 25일(일, 빼요)
    expect(readSickDates('어제랑 오늘 병가', '2026-10-27')).toEqual(['2026-10-26', '2026-10-27']);
    expect(readSickDates('그제 병가', '2026-10-27')).toEqual([]);
  });
});

describe('병가 카드(담당 찾기)', () => {
  it('[병가-카드] "병가"를 물으면 병가 카드에 [병가 신청하기]가 붙고 올해 병가 쓴 날을 보여 줘요(연차 카드는 안 붙어요)', async () => {
    const { haneul } = await setup();
    const cards = await ask(haneul, '오늘 병가 쓸게요');
    const card = cards.find((c) => c.id === 'navi-sick-leave')!;
    expect(cards.find((c) => c.id === 'navi-my-leave')).toBeUndefined();
    expect(card).toMatchObject({ label: '안내', headline: '병가는 연차에서 빠지지 않아요', evidence: { aiSummarized: false } });
    expect(field(card, '올해 병가')).toBe('올해 병가 1.5일 썼어요');
    expect(field(card, '병가 사유')).toBe('몸이 안 좋아요 · 병원 진료 · 가족 돌봄 중에서 골라요');
    expect(field(card, '진단서')).toBe('3일을 넘게 쉬면 진단서는 인사팀에 따로 내 주세요');
    expect(field(card, '유급·무급')).toBe('회사 규정에 따라 인사팀이 처리해요');
    expect(card.tail).toBe('나에게만 보여요. 병가 기록은 저장하지 않고 AI로 보내지 않아요');
    expect(card.actions.secondary.find((a) => a.type === 'leave-request')).toMatchObject({
      text: '병가 신청하기',
      leaveType: 'sick',
      rowId: 'HR-02',
      days: [{ date: '2026-10-26', kind: 'full' }],
      sick: { year: 2026, used: 1.5, limit: null, noteOverDays: 3 },
    });
  });

  it('[병가-4] 운영 값에 연간 한도가 있으면 "올해 병가 N일 중 M일 썼어요", 0이면 쓴 날만 보여요', async () => {
    const { t, haneul } = await setup();
    t.ctx.ops.patchValues({ sickLeaveYearDays: 10 });
    expect(field(await sickCard(haneul), '올해 병가')).toBe('올해 병가 10일 중 1.5일 썼어요');
    t.ctx.ops.patchValues({ sickLeaveYearDays: 0 });
    expect(field(await sickCard(haneul), '올해 병가')).toBe('올해 병가 1.5일 썼어요');
  });

  it('[병가-4] 운영 값 범위: 연간 한도 0~365(0은 없음), 진단서 기준 1~30일이에요', async () => {
    const { t } = await setup();
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/values', { sickLeaveYearDays: 0 })).status).toBe(200);
    expect((await op.call('PUT', '/api/ops/values', { sickLeaveYearDays: 60, sickNoteOverDays: 5 })).status).toBe(200);
    expect(t.ctx.ops.get().values).toMatchObject({ sickLeaveYearDays: 60, sickNoteOverDays: 5 });
    for (const body of [{ sickLeaveYearDays: 366 }, { sickLeaveYearDays: -1 }, { sickNoteOverDays: 0 }, { sickNoteOverDays: 31 }, { sickNoteOverDays: 2.5 }]) {
      expect((await op.call('PUT', '/api/ops/values', body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('[병가-남] 남의 병가를 물으면 숫자 없이 "볼 수 없어요"이고 근태 기록도 읽지 않아요', async () => {
    const { t, haneul } = await setup();
    let reads = 0;
    const leaveOf = t.ctx.adapters.leave.leaveOf.bind(t.ctx.adapters.leave);
    t.ctx.adapters.leave.leaveOf = async (p) => {
      reads += 1;
      return leaveOf(p);
    };
    const card = await sickCard(haneul, '팀장님 병가 며칠 썼어요?');
    expect(card).toMatchObject({ headline: '남의 병가는 볼 수 없어요' });
    expect(JSON.stringify(card)).not.toMatch(/\d+(\.\d)?일/);
    expect(reads).toBe(0);
  });
});

describe('병가 요청(ADR-24 개정)', () => {
  it('[병가-보내기] 보내면 인사팀이 병가로 받고, 결정 전에는 보낸 사람 올해 병가 쓴 날을 그 요청 안에서 봐요. 남은 연차는 오지 않아요', async () => {
    const { t, haneul, jihu } = await setup();
    const sent = await sendSick(haneul, [
      { date: '2026-10-26', kind: 'half', half: 'pm' },
      { date: '2026-10-23', kind: 'full' },
    ]);
    expect(sent.status).toBe(200);
    expect(sent.body.card).toMatchObject({ label: '확정', headline: '인사팀에 병가 요청을 보냈어요' });
    expect(sent.body.card.fields).toContainEqual({ name: '쓸 날', value: '10월 23일(금) 하루 · 10월 26일(월) 오후 반차 · 병가 1.5일' });
    expect(sent.body.card.fields).toContainEqual({ name: '병가 사유', value: '병원 진료' });
    expect(sent.body.card.fields.find((f: { name: string }) => f.name === '진단서')).toBeUndefined();

    const [item] = await inbox(jihu);
    expect(item).toMatchObject({ question: '병가 신청 · 병원 진료 · 10월 23일(금) 하루 · 10월 26일(월) 오후 반차', reason: '병원 진료', canDecide: true });
    expect(item!.leave).toEqual({
      type: 'sick',
      sickReason: 'clinic',
      days: [
        { date: '2026-10-23', kind: 'full' },
        { date: '2026-10-26', kind: 'half', half: 'pm' },
      ],
      total: 1.5,
      sick: { year: 2026, used: 1.5, limit: null },
    });
    expect((await notes(jihu))[0]!.title).toBe('인사팀에 병가 요청이 왔어요 · 휴가 신청');

    // [병가-1] DB에는 사유 코드와 서버가 채운 선택지 이름만 있어요. 공가 사유 칸은 비어 있어요.
    const { rows } = await t.db.query<{ sick_reason_code: string; leave_reason_code: string | null; leave_type: string; reason: string }>(
      'select sick_reason_code, leave_reason_code, leave_type, reason from navi_inquiries',
    );
    expect(rows).toEqual([{ sick_reason_code: 'clinic', leave_reason_code: null, leave_type: 'sick', reason: '병원 진료' }]);
  });

  it('[병가-1] 사유는 정해진 코드만 받아요: 자유 글 사유·코드 없음·코드 밖·다른 종류에 병가 코드는 400이에요', async () => {
    const { t, haneul } = await setup();
    const days: Day[] = [{ date: '2026-10-27', kind: 'full' }];
    expect((await sendSick(haneul, days, 'clinic', { reason: '감기 몸살 SICKCANARY7' })).status).toBe(400);
    expect((await sendSick(haneul, days, null)).status).toBe(400);
    expect((await sendSick(haneul, days, 'flu')).status).toBe(400);
    const other = (leave: Record<string, unknown>) =>
      haneul.call('POST', '/api/navi/inquiries', {
        rowId: 'HR-02',
        question: '휴가 신청',
        reason: '개인 사정',
        requestId: requestId(),
        leave: { days, ...leave },
      });
    expect((await other({ sickReason: 'clinic' })).status).toBe(400);
    expect((await other({ type: 'official', officialReason: 'vote', sickReason: 'clinic' })).status).toBe(400);
    expect((await other({ type: 'sick', sickReason: 'clinic', officialReason: 'vote' })).status).toBe(400);
    // 연차·공가는 여전히 자유 글 사유가 꼭 있어요.
    expect((await haneul.call('POST', '/api/navi/inquiries', { rowId: 'HR-02', question: '휴가 신청', requestId: requestId(), leave: { days } })).status).toBe(
      400,
    );
    expect((await t.db.query('select 1 from navi_inquiries')).rows).toHaveLength(0);
  });

  it('[병가-2] 병가는 지난 3일까지 받고 4일 전은 거부해요. 연차는 지난 날을 그대로 받지 않아요. 주말은 병가도 안 돼요', async () => {
    const { haneul } = await setup();
    const late = await sendSick(haneul, [{ date: '2026-10-22', kind: 'full' }]);
    expect(late.status).toBe(400);
    expect(late.body.message).toMatch(/병가는 3일 전까지만/);
    expect((await sendSick(haneul, [{ date: '2026-10-24', kind: 'full' }])).body.message).toMatch(/주말/);
    expect((await sendSick(haneul, [{ date: '2026-10-23', kind: 'full' }])).status).toBe(200);
    const annual = await haneul.call('POST', '/api/navi/inquiries', {
      rowId: 'HR-02',
      question: '휴가 신청',
      reason: '개인 사정',
      requestId: requestId(),
      leave: { days: [{ date: '2026-10-23', kind: 'full' }] },
    });
    expect(annual.status).toBe(400);
    expect(annual.body.message).toMatch(/지난 날/);
  });

  it('[병가-3·승인] 반차 병가를 승인하면 근태 기록에 병가로 들어가 올해 병가가 늘고, 남은 연차는 그대로예요', async () => {
    const { haneul, jihu } = await setup();
    const before = await remainingOf(haneul);
    await sendSick(haneul, [
      { date: '2026-10-27', kind: 'half', half: 'am' },
      { date: '2026-10-28', kind: 'full' },
    ]);
    const [item] = await inbox(jihu);
    const ok = await jihu.call('POST', `/api/navi/inquiries/${item!.id}/decision`, { decision: 'approved' });
    expect(ok.body).toMatchObject({ state: 'approved', recorded: true });
    expect(await remainingOf(haneul)).toBe(before);
    expect(field(await sickCard(haneul), '올해 병가')).toBe('올해 병가 3일 썼어요');
    expect((await notes(haneul))[0]!.title).toBe('인사팀이 병가 요청을 승인했어요 · 휴가 신청');
    // 결정한 요청에는 올해 병가가 더 오지 않아요. 근태 기록에 들어간 날은 다시 신청하지 못해요.
    expect((await inbox(jihu))[0]!.leave!.sick).toBeUndefined();
    expect((await sendSick(haneul, [{ date: '2026-10-28', kind: 'full' }])).status).toBe(409);
  });

  it('[병가-반려] 반려는 사유가 꼭 있어야 하고, 올해 병가·남은 연차는 그대로예요', async () => {
    const { haneul, jihu } = await setup();
    const before = await remainingOf(haneul);
    await sendSick(haneul, [{ date: '2026-10-27', kind: 'full' }], 'unwell');
    const [item] = await inbox(jihu);
    const path = `/api/navi/inquiries/${item!.id}/decision`;
    expect((await jihu.call('POST', path, { decision: 'rejected' })).status).toBe(400);
    expect((await jihu.call('POST', path, { decision: 'rejected', reason: '날짜를 다시 확인해 주세요' })).status).toBe(200);
    expect(field(await sickCard(haneul), '올해 병가')).toBe('올해 병가 1.5일 썼어요');
    expect(await remainingOf(haneul)).toBe(before);
    expect((await notes(haneul))[0]!.title).toBe('인사팀이 병가 요청을 반려했어요 · 휴가 신청');
  });

  it('[병가-5] 기준 일수(기본 3일)를 넘는 병가 요청만 보낸 카드·받은 문의함에 진단서 안내가 붙어요', async () => {
    const { t, haneul, jihu } = await setup();
    const week = (k: number, half = false): Day[] => [
      ...['2026-11-02', '2026-11-03', '2026-11-04'].slice(0, k).map((date) => ({ date, kind: 'full' as const })),
      // 11월 6일은 하늘의 연차 예정일이라 반차는 5일에 둬요.
      ...(half ? [{ date: '2026-11-05', kind: 'half' as const, half: 'am' as const }] : []),
    ];
    const three = await sendSick(haneul, week(3));
    expect(three.body.card.fields.find((f: { name: string }) => f.name === '진단서')).toBeUndefined();
    await jihu.call('POST', `/api/navi/inquiries/${(await inbox(jihu))[0]!.id}/decision`, { decision: 'rejected', reason: '다시 보내 주세요' });

    const over = await sendSick(haneul, week(3, true));
    expect(over.body.card.fields).toContainEqual({ name: '진단서', value: '진단서는 인사팀에 따로 내 주세요' });
    const open = (await inbox(jihu)).find((i) => i.state === 'new')!;
    expect(open.leave).toMatchObject({ total: 3.5, sickNote: true });
    expect((await inbox(jihu)).find((i) => i.state === 'rejected')!.leave!.sickNote).toBeUndefined();

    // 기준 일수는 운영 값이에요.
    t.ctx.ops.patchValues({ sickNoteOverDays: 1 });
    await jihu.call('POST', `/api/navi/inquiries/${open.id}/decision`, { decision: 'rejected', reason: '다시 보내 주세요' });
    const two = await sendSick(haneul, week(2));
    expect(two.body.card.fields).toContainEqual({ name: '진단서', value: '진단서는 인사팀에 따로 내 주세요' });
  });

  it('[병가-감사] 감사 로그·알림에 병가 사유 코드·사유 이름·날짜가 없어요', async () => {
    const { t, haneul, jihu } = await setup();
    await sendSick(haneul, [{ date: '2026-10-27', kind: 'full' }], 'family');
    const [item] = await inbox(jihu);
    await jihu.call('POST', `/api/navi/inquiries/${item!.id}/decision`, { decision: 'approved' });
    const audit = await t.db.query<{ row: string }>("select (to_jsonb(a) - 'at')::text as row from audit_log a");
    const text = audit.rows.map((r) => r.row).join('\n');
    expect(text).toContain('leave.request');
    expect(text).not.toMatch(/family|가족 돌봄|2026-10-27|10월 27일|sick/);
    expect(JSON.stringify([...(await notes(jihu)), ...(await notes(haneul))])).not.toMatch(/family|가족 돌봄|10월 27일|2026-10-27/);
  });

  it('[병가-DB] DB도 모양을 지켜요: 병가는 병가 사유만, 공가는 공가 사유만, 일반 문의는 사유 코드 없이만 들어가요', async () => {
    const { t } = await setup();
    const insert = (kind: string, leaveType: string | null, official: string | null, sick: string | null) =>
      t.db.query(
        `insert into navi_inquiries (row_id, task, team, department, sender_pseudonym, sender_name, sender_department, question, reason,
           kind, leave_days, sender_subject, leave_type, leave_reason_code, sick_reason_code)
         values ('HR-02', '휴가 신청', '인사팀', '인사팀', 'p-test', '가상', '재무팀', '병가 신청', '사유', $1, $2::jsonb, $3, $4, $5, $6)`,
        [kind, kind === 'leave' ? '[{"date":"2026-11-03","kind":"full"}]' : null, kind === 'leave' ? 'sub-test' : null, leaveType, official, sick],
      );
    await expect(insert('leave', 'sick', null, null)).rejects.toThrow();
    await expect(insert('leave', 'sick', null, 'flu')).rejects.toThrow();
    await expect(insert('leave', 'sick', 'reserve', 'clinic')).rejects.toThrow();
    await expect(insert('leave', 'annual', null, 'clinic')).rejects.toThrow();
    await expect(insert('leave', 'official', 'vote', 'clinic')).rejects.toThrow();
    await expect(insert('leave', 'official', null, null)).rejects.toThrow();
    await expect(insert('general', null, null, 'clinic')).rejects.toThrow();
    await expect(insert('leave', 'sick', null, 'clinic')).resolves.toBeDefined();
    await expect(insert('leave', 'official', 'vote', null)).resolves.toBeDefined();
    await expect(insert('leave', 'annual', null, null)).resolves.toBeDefined();
    await expect(insert('general', null, null, null)).resolves.toBeDefined();
  });
});
