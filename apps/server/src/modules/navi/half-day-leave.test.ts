import {
  type Card,
  type InquiryListResponse,
  type LeaveDay,
  leaveDayHalves,
  leaveDayWord,
  mergeLeaveHalves,
  type NotificationsResponse,
} from '@one-line-desk/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { leaveSummary } from './inquiries';
import { computeLeave, readExplicitHalfPart, readHalfPart, ruleLeaveQuestion, sickUsage } from './leave';
import { checkLeaveLink } from './mcp-read';

// 반차를 오전·오후로 나눠요(11/3 사용자 결정, ADR-24 개정). 시험 시계는 2026-10-26(월) 09:00이에요.
// 하늘(재무팀)이 휴가를 보내고 인사팀(지후)이 승인해요. 하늘은 11월 6일(금)이 이미 연차 예정이라 11월 4·5일을 써요.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
type Day = { date: string; kind: 'full' | 'half'; half?: string };
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
const requestId = () => `half-${Date.now().toString(36)}-${(n += 1)}`;
const REASON = '가족 행사 HALFCANARY4';
const sendLeave = (me: Session, days: Day[], extra: Record<string, unknown> = {}) =>
  me.call('POST', '/api/navi/inquiries', { rowId: 'HR-02', question: '휴가 신청', reason: REASON, requestId: requestId(), leave: { days, ...extra } });
const inbox = async (me: Session) => ((await me.call('GET', '/api/navi/inquiries/inbox')).body as InquiryListResponse).items;
const notes = async (me: Session) => ((await me.call('GET', '/api/notifications')).body as NotificationsResponse).items;
const ask = async (me: Session, text: string) => (await me.call('POST', '/api/ask', { text, kind: 'navi' })).body.cards as Card[];
const requestAction = (cards: Card[], id: string) => cards.find((c) => c.id === id)?.actions.secondary.find((a) => a.type === 'leave-request');
const approveFirst = async (jihu: Session) => {
  const item = (await inbox(jihu)).find((i) => i.state === 'new')!;
  const ok = await jihu.call('POST', `/api/navi/inquiries/${item.id}/decision`, { decision: 'approved' });
  expect(ok.status).toBe(200);
  return item;
};

describe('반차 오전·오후 보내기(ADR-24 개정)', () => {
  it('[반차-1] 날마다 하루·오전 반차·오후 반차를 골라 보내고, 확인 카드·받은 문의함에 "오전 반차"·"오후 반차"로 보여요', async () => {
    const { haneul, jihu } = await setup();
    const sent = await sendLeave(haneul, [
      { date: '2026-11-05', kind: 'half', half: 'pm' },
      { date: '2026-11-04', kind: 'half', half: 'am' },
      { date: '2026-11-03', kind: 'full' },
    ]);
    expect(sent.status).toBe(200);
    expect(sent.body.card.fields).toContainEqual({ name: '쓸 날', value: '11월 3일(화) 하루 · 11월 4일(수) 오전 반차 · 11월 5일(목) 오후 반차 · 연차 2일' });
    const [item] = await inbox(jihu);
    expect(item).toMatchObject({ question: '휴가 신청 · 11월 3일(화) 하루 · 11월 4일(수) 오전 반차 · 11월 5일(목) 오후 반차' });
    expect(item!.leave!.days).toEqual([
      { date: '2026-11-03', kind: 'full' },
      { date: '2026-11-04', kind: 'half', half: 'am' },
      { date: '2026-11-05', kind: 'half', half: 'pm' },
    ]);
  });

  it('[반차-2] 오전·오후 구분 없는 반차와 정해진 값 밖의 오전·오후는 받지 않아요', async () => {
    const { t, haneul } = await setup();
    const plain = await sendLeave(haneul, [{ date: '2026-11-04', kind: 'half' }]);
    expect(plain.status).toBe(400);
    expect(plain.body.message).toBe('반차는 오전·오후 중 하나를 골라 주세요');
    expect((await sendLeave(haneul, [{ date: '2026-11-04', kind: 'half', half: 'noon' }])).status).toBe(400);
    // 병가·공가도 같아요.
    expect((await sendLeave(haneul, [{ date: '2026-11-04', kind: 'half' }], { type: 'sick', sickReason: 'clinic' })).status).toBe(400);
    expect((await sendLeave(haneul, [{ date: '2026-11-04', kind: 'half' }], { type: 'official', officialReason: 'reserve' })).status).toBe(400);
    expect((await t.db.query('select 1 from navi_inquiries')).rows).toHaveLength(0);
  });

  it('[반차-3] 같은 날 오전 반차와 오후 반차를 같이 고르면 하루로 합쳐요(1일). 같은 반쪽을 두 번·하루와 반차를 같이 고르면 막아요', async () => {
    const { haneul, jihu } = await setup();
    const sent = await sendLeave(haneul, [
      { date: '2026-11-04', kind: 'half', half: 'pm' },
      { date: '2026-11-04', kind: 'half', half: 'am' },
    ]);
    expect(sent.status).toBe(200);
    expect(sent.body.card.fields).toContainEqual({ name: '쓸 날', value: '11월 4일(수) 하루 · 연차 1일' });
    expect((await inbox(jihu))[0]!.leave).toMatchObject({ days: [{ date: '2026-11-04', kind: 'full' }], total: 1 });

    const twice = await sendLeave(haneul, [
      { date: '2026-11-05', kind: 'half', half: 'am' },
      { date: '2026-11-05', kind: 'half', half: 'am' },
    ]);
    expect(twice.status).toBe(400);
    expect(twice.body.message).toMatch(/두 번/);
    const mixed = await sendLeave(haneul, [
      { date: '2026-11-05', kind: 'full' },
      { date: '2026-11-05', kind: 'half', half: 'pm' },
    ]);
    expect(mixed.status).toBe(400);
    expect(mixed.body.message).toMatch(/두 번/);
  });

  it('[반차-4] 겹침은 오전·오후 단위로 봐요: 근태 기록에 오전 반차가 있으면 오후 반차는 되고 오전 반차·하루는 막아요', async () => {
    const { haneul, jihu } = await setup();
    expect((await sendLeave(haneul, [{ date: '2026-11-04', kind: 'half', half: 'am' }])).status).toBe(200);
    await approveFirst(jihu);

    const am = await sendLeave(haneul, [{ date: '2026-11-04', kind: 'half', half: 'am' }]);
    expect(am.status).toBe(409);
    expect(am.body.message).toBe('이미 근태 기록에 있는 날이에요: 11월 4일(수) 오전 반차');
    expect((await sendLeave(haneul, [{ date: '2026-11-04', kind: 'full' }])).status).toBe(409);
    expect((await sendLeave(haneul, [{ date: '2026-11-04', kind: 'half', half: 'pm' }])).status).toBe(200);
    // 하루 예정(11월 6일)에는 오전·오후 어느 쪽도 안 돼요.
    expect((await sendLeave(haneul, [{ date: '2026-11-06', kind: 'half', half: 'pm' }])).status).toBe(409);
    // 오후도 승인하면 그날은 다 찼어요.
    await approveFirst(jihu);
    expect((await sendLeave(haneul, [{ date: '2026-11-04', kind: 'half', half: 'pm' }])).status).toBe(409);
  });

  it('[반차-4] 근태 기록의 오전·오후 모르는 반차는 하루로 봐서 어느 쪽도 막아요. 승인할 때도 오전·오후 단위로 다시 봐요', async () => {
    const { t, haneul, jihu } = await setup();
    expect((await sendLeave(haneul, [{ date: '2026-11-05', kind: 'half', half: 'pm' }])).status).toBe(200);
    // 보낸 뒤 근태 기록에 그날 오전 반차가 들어왔어요(그룹웨어에서 직접 넣음): 승인은 겹치지 않아 돼요.
    await t.ctx.adapters.leave.recordUses({ idpSubject: MOCK.staff, email: 'haneul@corp.example' }, [{ date: '2026-11-05', kind: 'half', half: 'am' }]);
    await approveFirst(jihu);
    // 오전·오후 모르는 반차가 있는 날
    await t.ctx.adapters.leave.recordUses({ idpSubject: MOCK.staff, email: 'haneul@corp.example' }, [{ date: '2026-11-04', kind: 'half' }]);
    expect((await sendLeave(haneul, [{ date: '2026-11-04', kind: 'half', half: 'am' }])).status).toBe(409);
    expect((await sendLeave(haneul, [{ date: '2026-11-04', kind: 'half', half: 'pm' }])).status).toBe(409);
  });

  it('[반차-5] 일수 계산은 그대로 반차 0.5일이에요: 남은 연차·승인 뒤 남은 연차·올해 병가', async () => {
    const { haneul, jihu } = await setup();
    const remaining = async () => Number((await ask(haneul, '내 연차 몇 개 남았어?')).find((c) => c.id === 'navi-my-leave')!.headline.match(/([\d.]+)일/)![1]);
    const before = await remaining();
    await sendLeave(haneul, [
      { date: '2026-11-04', kind: 'half', half: 'am' },
      { date: '2026-11-05', kind: 'half', half: 'pm' },
    ]);
    const [item] = await inbox(jihu);
    expect(item!.leave).toMatchObject({ total: 1, balance: { remaining: before, after: before - 1 } });
    await approveFirst(jihu);
    expect(await remaining()).toBe(before - 1);

    const record = {
      hireDate: '2020-03-02',
      uses: [
        { date: '2026-04-01', kind: 'half' as const, half: 'am' as const },
        { date: '2026-04-02', kind: 'half' as const },
      ],
    };
    expect(computeLeave(record, '2026-10-26')).toMatchObject({ usedHalf: 2, used: 1 });
    const sick = { hireDate: '2020-03-02', uses: [{ date: '2026-04-01', kind: 'half' as const, half: 'pm' as const, type: 'sick' as const }] };
    expect(sickUsage(sick, '2026-10-26', 0).used).toBe(0.5);
  });

  it('[반차-6] 승인하면 근태 기록(LeaveUse)에 오전·오후(half)가 같이 들어가요', async () => {
    const { t, haneul, jihu } = await setup();
    const recordUses = vi.spyOn(t.ctx.adapters.leave, 'recordUses');
    // 병가는 자유 글 사유를 보내지 않아요.
    const sent = await haneul.call('POST', '/api/navi/inquiries', {
      rowId: 'HR-02',
      question: '병가 신청',
      requestId: requestId(),
      leave: {
        days: [
          { date: '2026-11-04', kind: 'half', half: 'am' },
          { date: '2026-11-05', kind: 'half', half: 'pm' },
          { date: '2026-11-03', kind: 'full' },
        ],
        type: 'sick',
        sickReason: 'clinic',
      },
    });
    expect(sent.status).toBe(200);
    await approveFirst(jihu);
    expect(recordUses.mock.calls[0]![1]).toEqual([
      { date: '2026-11-03', kind: 'full', type: 'sick' },
      { date: '2026-11-04', kind: 'half', half: 'am', type: 'sick' },
      { date: '2026-11-05', kind: 'half', half: 'pm', type: 'sick' },
    ]);
    const record = await t.ctx.adapters.leave.leaveOf({ idpSubject: MOCK.staff, email: 'haneul@corp.example' });
    expect(record!.uses.filter((u) => u.date >= '2026-11-03' && u.date <= '2026-11-05')).toEqual([
      { date: '2026-11-03', kind: 'full', type: 'sick' },
      { date: '2026-11-04', kind: 'half', half: 'am', type: 'sick' },
      { date: '2026-11-05', kind: 'half', half: 'pm', type: 'sick' },
    ]);
  });

  it('[반차-감사] 감사 로그·알림에는 날짜·하루/오전/오후·사유가 없어요', async () => {
    const { t, haneul, jihu } = await setup();
    await sendLeave(haneul, [
      { date: '2026-11-04', kind: 'half', half: 'am' },
      { date: '2026-11-05', kind: 'half', half: 'pm' },
    ]);
    await approveFirst(jihu);
    const audit = await t.db.query<{ row: string }>("select (to_jsonb(a) - 'at')::text as row from audit_log a");
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows.map((r) => r.row).join('\n')).not.toMatch(/2026-11-0[45]|오전|오후|반차|half|"am"|"pm"|HALFCANARY4/);
    const all = [...(await notes(jihu)), ...(await notes(haneul))];
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(all)).not.toMatch(/11월|오전|오후|반차|하루|HALFCANARY4/);
  });
});

describe('옛 구분 없는 반차(11/3 전에 보낸 요청, 7일 보관)', () => {
  it('[반차-옛 값] 받은 문의함은 옛 반차를 그대로 읽고(0.5일), 글로는 "반차(구분 없음)"이에요. 승인하면 오전·오후 없이 근태 기록에 들어가요', async () => {
    const { t, haneul, jihu } = await setup();
    await t.db.query(
      `insert into navi_inquiries (row_id, task, team, department, sender_pseudonym, sender_name, sender_department, question, reason,
         kind, leave_days, sender_subject, leave_type, created_at, updated_at)
       values ('HR-02', '휴가 신청', '인사팀', '인사팀', 'p-old', '가상 직원 하늘', '재무팀', '휴가 신청 · 11월 4일(수) 반차', '사유',
         'leave', $1::jsonb, $2, 'annual', $3, $3)`,
      ['[{"date":"2026-11-04","kind":"half"}]', MOCK.staff, '2026-10-26T08:00:00+09:00'],
    );
    const [item] = await inbox(jihu);
    expect(item!.leave).toMatchObject({ type: 'annual', days: [{ date: '2026-11-04', kind: 'half' }], total: 0.5, balance: { days: 0.5 } });
    expect(leaveSummary(item!.leave!.days)).toBe('11월 4일(수) 반차(구분 없음)');
    const recordUses = vi.spyOn(t.ctx.adapters.leave, 'recordUses');
    await approveFirst(jihu);
    expect(recordUses.mock.calls[0]![1]).toEqual([{ date: '2026-11-04', kind: 'half', type: 'annual' }]);
    // 오전·오후를 모르니 그날은 어느 쪽으로도 다시 신청하지 못해요.
    expect((await sendLeave(haneul, [{ date: '2026-11-04', kind: 'half', half: 'pm' }])).status).toBe(409);
  });

  it('[반차-옛 값] 글 도우미: 하루·오전 반차·오후 반차·반차(구분 없음), 반쪽 계산과 같은 날 합치기', () => {
    expect(leaveDayWord({ kind: 'full' })).toBe('하루');
    expect(leaveDayWord({ kind: 'half', half: 'am' })).toBe('오전 반차');
    expect(leaveDayWord({ kind: 'half', half: 'pm' })).toBe('오후 반차');
    expect(leaveDayWord({ kind: 'half' })).toBe('반차(구분 없음)');
    expect(leaveDayHalves({ kind: 'half', half: 'pm' })).toEqual(['pm']);
    expect(leaveDayHalves({ kind: 'half' })).toEqual(['am', 'pm']);
    const days: LeaveDay[] = [
      { date: '2026-11-04', kind: 'half', half: 'am' },
      { date: '2026-11-05', kind: 'half', half: 'am' },
      { date: '2026-11-04', kind: 'half', half: 'pm' },
    ];
    expect(mergeLeaveHalves(days)).toEqual([
      { date: '2026-11-04', kind: 'full' },
      { date: '2026-11-05', kind: 'half', half: 'am' },
    ]);
    // 하루에 딸려 온 오전·오후 칸은 버려요.
    expect(mergeLeaveHalves([{ date: '2026-11-04', kind: 'full', half: 'am' }])).toEqual([{ date: '2026-11-04', kind: 'full' }]);
  });
});

describe('질문에서 오전·오후 읽기(규칙)', () => {
  it('[반차-채우기] "오전 반차"·"오후에 휴가"·"점심 먹고"를 읽어 양식의 반차를 채우고, "반차"라고만 하면 오전·오후를 비워 둬요', async () => {
    const { haneul } = await setup();
    const days = async (text: string) => {
      const a = requestAction(await ask(haneul, text), 'navi-my-leave');
      return a && a.type === 'leave-request' ? a.days : null;
    };
    expect(await days('11월 5일 오전 반차 쓰고 싶어')).toEqual([{ date: '2026-11-05', kind: 'half', half: 'am' }]);
    expect(await days('11월 5일 오후에 휴가 쓰고 싶어')).toEqual([{ date: '2026-11-05', kind: 'half', half: 'pm' }]);
    expect(await days('금요일 점심 먹고 연차 쓰려고')).toEqual([{ date: '2026-10-30', kind: 'half', half: 'pm' }]);
    expect(await days('금요일 반차 쓰려고')).toEqual([{ date: '2026-10-30', kind: 'half' }]);
    expect(await days('다음 주 화수 휴가 쓰고 싶어')).toEqual([
      { date: '2026-11-03', kind: 'full' },
      { date: '2026-11-04', kind: 'full' },
    ]);
  });

  it('[반차-채우기] 규칙: 오전·오후 둘 다 말하면 비워 두고, "아침부터"는 오전으로 읽지 않아요. 병가·공가는 분명히 말했을 때만 읽어요', async () => {
    expect(readHalfPart('아침에만 쉴게요')).toBe('am');
    expect(readHalfPart('점심 전까지만')).toBe('am');
    expect(readHalfPart('점심 이후에')).toBe('pm');
    expect(readHalfPart('오전에 하나 오후에 하나')).toBeNull();
    expect(readHalfPart('아침부터 쉬고 싶어')).toBeNull();
    expect(ruleLeaveQuestion('11월 5일 오전 반차 쓰면 몇 개 남아?', '2026-10-26')).toMatchObject({ planHalf: 1, planFull: 0, planPart: 'am' });
    expect(ruleLeaveQuestion('11월 5일 연차 쓰면?', '2026-10-26').planPart).toBeUndefined();
    expect(readExplicitHalfPart('오늘 아침부터 아파서 병가')).toBeNull();
    expect(readExplicitHalfPart('오늘 오후 반차로 병가 쓸게요')).toBe('pm');

    const { haneul } = await setup();
    const sick = requestAction(await ask(haneul, '오늘 오후 반차로 병가 쓸게요'), 'navi-sick-leave');
    expect(sick).toMatchObject({ leaveType: 'sick', days: [{ date: '2026-10-26', kind: 'half', half: 'pm' }] });
    const sickAll = requestAction(await ask(haneul, '오늘 아침부터 아파서 병가 쓸게요'), 'navi-sick-leave');
    expect(sickAll).toMatchObject({ days: [{ date: '2026-10-26', kind: 'full' }] });
  });
});

describe('MCP 휴가 준비 링크의 날 검사', () => {
  it('[반차-MCP] 구분 없는 반차는 링크 없이 "사람에게 물어 주세요"를 돌려주고, 같은 날 오전·오후는 하루로 합쳐요', () => {
    const today = '2026-10-26';
    expect(checkLeaveLink({ type: 'annual', days: [{ date: '2026-11-04', kind: 'half' }] }, today)).toEqual({
      ok: false,
      code: 'half-part',
      message: '반차는 오전·오후 중 하나여야 해요. 어느 쪽인지 사람에게 물어 주세요',
    });
    expect(
      checkLeaveLink(
        {
          type: 'sick',
          days: [
            { date: '2026-11-04', kind: 'half', half: 'pm' },
            { date: '2026-11-04', kind: 'half', half: 'am' },
            { date: '2026-11-03', kind: 'half', half: 'am' },
          ],
        },
        today,
      ),
    ).toEqual({
      ok: true,
      days: [
        { date: '2026-11-03', kind: 'half', half: 'am' },
        { date: '2026-11-04', kind: 'full' },
      ],
    });
  });
});
