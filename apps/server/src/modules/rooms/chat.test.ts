import { randomUUID } from 'node:crypto';
import type { Card, CardAction, PlanConfirmResponse, PlanCreateResponse, RoomChatResponse, RoomListResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AiGateway, type LlmProvider, type ProviderResult, type StructuredRequest } from '../../core/ai/gateway';
import { pseudonymize } from '../../core/pseudonym';
import { createTestApp, MOCK } from '../../testing';
import { LOAN_KINDS, loanKindsIn } from '@one-line-desk/shared';
import { NO_AUTO_SENTENCES } from '@one-line-desk/shared/rooms-chat/samples';
import { CHAT_INTENTS, interpretByRules, mentionedRoom, repeatWeeksOf } from './chat';
import { listRooms } from './repo';

// 회의실 채팅·장비 대여(ADR-19). 시계는 2026-10-26(월) 09:00이에요. "내일"은 10월 27일(화)이에요.
// 시킨 예약·대여만 바로 실행하고, 묻는 문장·조건이 빠진 문장·4시간 넘는 회의·자동 실행 끔·하루 상한은 아무것도 쓰지 않아요.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;

const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  await t.modules.find((m) => m.kind === 'rooms')!.seed!();
  return t;
}

let seq = 0;
const newRequestId = () => `req-${Date.now().toString(36)}-${++seq}`;

async function chat(me: Session, text: string, requestId = newRequestId()): Promise<RoomChatResponse> {
  const res = await me.call('POST', '/api/rooms/chat', { text, requestId });
  expect(res.status).toBe(200);
  return res.body as RoomChatResponse;
}

async function appReservations(t: TestApp) {
  return (
    await t.db.query<{ id: string; room_id: string; pseudonym_id: string }>(
      "select id::text, room_id, pseudonym_id from room_reservations where source = 'app' order by id",
    )
  ).rows;
}

async function loans(t: TestApp) {
  return (
    await t.db.query<{ id: string; item_id: string; reservation_id: string | null; upper: Date }>(
      'select id::text, item_id, reservation_id::text, upper(slot) from room_equipment_loans order by id',
    )
  ).rows;
}

const labels = (cards: Card[]) => cards.map((c) => c.label);
const fixedOf = (card: Card | undefined, text: string): Extract<CardAction, { type: 'fixed' }> => {
  const action = card?.actions.secondary.find((a) => a.text === text);
  if (action?.type !== 'fixed') throw new Error(`${text} 버튼이 없어요`);
  return action;
};

describe('규칙 해석', () => {
  const now = Date.parse('2026-10-26T09:00:00+09:00');

  it.each([
    ['내일 3시 6명 회의실 잡아 줘', 'reserve', true],
    ['내일 3시 6명 빈 방 있어?', 'reserve', false],
    ['내일 3시 6명 잡아 줄 수 있어?', 'reserve', false],
    ['프로젝터 있는 방 내일 3시 4명 예약해', 'reserve', true],
    ['내일 3시 회의에 빔프로젝터 빌려 줘', 'rent', true],
    ['노트북 빌려 줄래?', 'rent', true],
    ['내일 3시 노트북 빌릴 수 있어?', 'rent', false],
    ['내일 3시 6명 회의실 잡고 빔프로젝터도 빌려 줘', 'reserve', true],
    ['빔프로젝터 남았어?', 'equipment', false],
    ['3C 장비 뭐 있어?', 'equipment', false],
    ['회의실별 장비 현황 알려 줘', 'equipment', false],
    ['지금 빈 방 있어?', 'overview', false],
    ['지금 빈 회의실 있어?', 'overview', false],
    ['5층 회의실 지금 비어 있어?', 'overview', false],
    ['오늘 회의실 예약 현황', 'overview', false],
    ['내 예약 보여 줘', 'my', false],
    ['내일 예약 취소해 줘', 'cancel', false],
    ['빔프로젝터 반납할게', 'cancel', false],
    ['안녕하세요', 'help', false],
    // 10/29 회의 A1: 시키는 말투여도 읽기 부탁이면 예약·대여가 아니에요.
    ['내일 3시 6명 빈 회의실 알려 줘', 'reserve', false],
    ['내일 3시 노트북 빌릴 수 있는지 알려 줘', 'rent', false],
  ])('"%s" → %s(바로 실행 %s)', (text, intent, command) => {
    const it = interpretByRules(text, now);
    expect(it.intent).toBe(intent);
    expect(it.command).toBe(command);
  });

  it('장비 종류와 말한 방을 읽어요', async () => {
    expect(loanKindsIn('노트북이랑 무선 마이크, HDMI 젠더')).toEqual(['노트북', '무선 마이크', 'HDMI 젠더']);
    const t = await setup();
    const rooms = await listRooms(t.db);
    expect(mentionedRoom('3c 장비 뭐 있어?', rooms)?.id).toBe('r-3c');
    expect(mentionedRoom('회의실 2A 지금 비었어?', rooms)?.id).toBe('r-2a');
    expect(mentionedRoom('대회의실 현황', rooms)?.id).toBe('r-5c');
    expect(mentionedRoom('HDMI 2개 빌려 줘', rooms)).toBeNull();
  });
});

describe('채팅으로 예약(자동 실행 허용 목록)', () => {
  it('시킨 문장이고 조건이 다 있으면 서버 1순위 후보로 바로 예약하고, 글은 어디에도 남지 않아요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const text = '내일 3시 6명 회의실 잡아 줘';
    const out = await chat(me, text);

    expect(out.changed).toBe(true);
    expect(out.aiParsed).toBe(false);
    expect(out.reply).toMatch(/^예약했어요: .+ · \d+층, 10월 27일\(화\) 15:00~16:00/);
    expect(out.cards[0]).toMatchObject({ label: '확정', headline: '예약했어요' });
    const cancel = fixedOf(out.cards[0], '취소');
    expect(cancel.confirm?.title).toBe('예약을 취소할까요?');

    const rows = await appReservations(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pseudonym_id).toBe(pseudonymize(t.ctx.config.pseudonymSecret, MOCK.staff));

    const plans = (await t.db.query<{ action: string; state: string; params: string }>('select action, state, params::text from plans')).rows;
    expect(plans).toEqual([expect.objectContaining({ action: 'reserve', state: 'done' })]);
    const audit = await t.ctx.audit.recent(10);
    expect(audit.map((a) => [a.channel, a.action, a.result])).toEqual(
      expect.arrayContaining([
        ['write', 'auto-reserve', 'done'],
        ['ask', 'chat', 'auto-done'],
      ]),
    );
    // R13: 채팅 글은 plan·영수증·감사 로그 어디에도 없어요.
    const stored = [
      ...plans.map((p) => p.params),
      ...(await t.db.query<{ r: string }>('select result::text as r from action_receipts')).rows.map((r) => r.r),
      JSON.stringify(audit),
    ].join('\n');
    expect(stored).not.toContain('잡아');
    expect(stored).not.toContain(text);
  });

  it('같은 시간에 이미 내 예약이 있으면 바로 잡지 않고, 겹치는 내 예약을 맨 앞에 알려요(10/28 사용성 점검)', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    expect((await chat(me, '내일 3시 6명 회의실 잡아 줘')).changed).toBe(true);

    const again = await chat(me, '내일 3시 4명 회의실 잡아 줘');
    expect(again.changed).toBe(false);
    expect(again.reply).toMatch(/^이 시간에 이미 내 예약\(회의실 3C · 3층 10월 27일\(화\) 15:00~16:00\)이 있어서 바로 잡지 않았어요/);
    expect(again.cards[0]).toMatchObject({ label: '안내', headline: '이 시간에 이미 내 예약이 있어요' });
    expect(fixedOf(again.cards[0], '취소').confirm?.title).toBe('예약을 취소할까요?');
    expect(await appReservations(t)).toHaveLength(1);

    // 그래도 하나 더 잡으려면 카드 → 확인 시트예요. 시트에도 겹치는 내 예약이 적혀 있어요.
    const candidate = again.cards.find((c) => c.actions.primary?.type === 'propose')!;
    const action = candidate.actions.primary as Extract<CardAction, { type: 'propose' }>;
    const sheet = (await me.call('POST', '/api/plans', { proposalToken: action.proposalToken })).body as PlanCreateResponse;
    expect(sheet).toMatchObject({ status: 'sheet' });
    if (sheet.status !== 'sheet') throw new Error();
    expect(sheet.sheet.lines).toContain('이 시간에 이미 내 예약이 있어요: 회의실 3C · 3층 10월 27일(화) 15:00~16:00');
  });

  it('내 층에서 가까운 회의실을 먼저 잡아요(10/28 사용성 점검)', async () => {
    const t = await setup();
    const dev = await t.loginAs(MOCK.dev);
    const staff = await t.loginAs(MOCK.staff);
    // 같은 조건이어도 도윤(5층)은 5층, 하늘(3층)은 3층 회의실이에요.
    const fromFive = await chat(dev, '내일 3시 6명 화면 회의실 잡아 줘');
    expect(fromFive.reply).toMatch(/^예약했어요: 회의실 5B · 5층, .*\(내 층에서 조건에 맞는 회의실\)/);
    const fromThree = await chat(staff, '내일 3시 6명 화면 회의실 잡아 줘');
    expect(fromThree.reply).toMatch(/^예약했어요: 회의실 3C · 3층, .*\(내 층에서 조건에 맞는 회의실\)/);
  });

  it('같은 요청 ID로 두 번 와도 한 번만 예약해요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const requestId = newRequestId();
    const first = await chat(me, '내일 3시 6명 회의실 잡아 줘', requestId);
    const again = await chat(me, '내일 3시 6명 회의실 잡아 줘', requestId);
    expect(first.changed).toBe(true);
    expect(again).toMatchObject({ reply: '이미 처리한 요청이에요', changed: false });
    expect(again.cards[0]!.id).toBe(first.cards[0]!.id);
    expect(await appReservations(t)).toHaveLength(1);
  });

  it('말한 방이 비었으면 그 방을, 차 있으면 아무것도 잡지 않고 카드만 보여 줘요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const other = await t.loginAs(MOCK.dev);
    const first = await chat(me, '내일 오후 4시 3명 3C 잡아 줘');
    expect(first.changed).toBe(true);
    expect(first.reply).toContain('회의실 3C');
    expect(first.reply).toContain('말한 회의실');

    const taken = await chat(other, '내일 오후 4시 3명 3C 잡아 줘');
    expect(taken.changed).toBe(false);
    expect(taken.reply).toContain('말한 회의실(회의실 3C)은 그 시간에 쓸 수 없어요');
    expect(await appReservations(t)).toHaveLength(1);
  });

  it.each([
    ['묻는 문장', '내일 3시 6명 빈 방 있어?', 'cards'],
    ['여러 팀 회의인데 팀 이름·인원이 빠짐(11/4)', '내일 3시 합동 회의 회의실 잡아 줘', 'reask-joint'],
    ['여러 팀 회의는 카드에서 확인(ADR-28)', '내일 3시 디자인팀이랑 회의실 잡아 줘', 'joint'],
    ['시작 시각이 빠짐', '내일 6명 회의실 잡아 줘', 'reask'],
    ['4시간 넘음', '내일 1시부터 6시까지 6명 잡아 줘', 'too-long'],
    ['취소는 자동으로 하지 않음', '내일 3시 예약 취소해 줘', 'cancel'],
  ])('%s → 아무것도 쓰지 않아요', async (_name, text, code) => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const out = await chat(me, text);
    expect(out.changed).toBe(false);
    expect(await appReservations(t)).toHaveLength(0);
    expect((await t.db.query('select 1 from plans')).rows).toHaveLength(0);
    const audit = await t.ctx.audit.recent(1);
    expect(audit[0]).toMatchObject({ channel: 'ask', action: 'chat', result: code });
  });

  it('인원을 말하지 않으면 내 팀에서 그 시간에 휴가·자리비움인 사람을 뺀 수로 찾고, 시킨 말이면 그 인원에 맞는 회의실로 바로 잡아요(11/4 사용자 결정, 모든 팀)', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const directory = t.ctx.adapters.directory;
    const real = directory.departmentMembers.bind(directory);
    // 개발팀을 6명으로 가정해요(모의 명단은 4명: 도윤·서준·하은·주원).
    directory.departmentMembers = async (department, limit) => {
      const got = await real(department, limit);
      const extra = [7, 8].map((n) => ({ ...got[0]!, idpSubject: 'mock|emp-09' + n, displayName: '가상 직원 추가' + n }));
      return [...got, ...extra].slice(0, limit);
    };
    const rooms = await listRooms(t.db);
    const capacities = (out: RoomChatResponse) =>
      out.cards.filter((c) => c.actions.primary?.type === 'propose').map((c) => rooms.find((r) => c.id.startsWith('rooms-slot-' + r.id + '-'))?.capacity ?? 0);

    // 휴가·자리비움이 없으면 6명이라 정원 4명 회의실은 후보에서 빠져요.
    const six = await chat(me, '내일 3시 빈 회의실 있어?');
    expect(six.reply).toContain('인원은 우리 팀 6명으로 봤어요');
    expect(capacities(six).length).toBeGreaterThan(0);
    expect(capacities(six).every((n) => n >= 6)).toBe(true);

    // 내일 서준은 하루 휴가(승인된 근태 기록), 하은은 오후 외근이라 15시 회의는 4명이에요. 주원은 오전 반차라 15시에는 와요.
    await t.ctx.adapters.leave.recordUses({ idpSubject: 'mock|emp-006', email: 'seojun@corp.example' }, [{ date: '2026-10-27', kind: 'full' }]);
    await t.ctx.adapters.leave.recordUses({ idpSubject: 'mock|emp-015', email: 'juwon@corp.example' }, [{ date: '2026-10-27', kind: 'half', half: 'am' }]);
    const haeun = await t.loginAs('mock|emp-007');
    const away = await haeun.call('POST', '/api/navi/away', {
      kind: 'outside',
      start: '2026-10-27T13:00:00+09:00',
      end: '2026-10-27T18:00:00+09:00',
      requestId: randomUUID(),
    });
    expect(away.status).toBe(200);

    const four = await chat(me, '내일 3시 회의실 잡아 줘');
    expect(four.changed).toBe(true);
    expect(four.reply).toContain('인원은 우리 팀 4명(6명 중 휴가 1명·자리비움 1명 빼고)으로 봤어요');
    // 이름·휴가 종류는 답에 없어요.
    expect(JSON.stringify(four)).not.toMatch(/서준|하은|주원|추가7|외근|연차/);
    const [booked] = await appReservations(t);
    expect(rooms.find((r) => r.id === booked!.room_id)!.capacity).toBeGreaterThanOrEqual(4);

    // 빠진 사람만 가명 ID로 접속기록(team.headcount)에 남아요.
    const access = await t.db.query<{ subject_refs: string[] }>("select subject_refs from access_log where action = 'team.headcount' order by id");
    expect(access.rows.at(-1)!.subject_refs.sort()).toEqual(
      ['mock|emp-006', 'mock|emp-007'].map((s) => 'person:' + pseudonymize(t.ctx.config.pseudonymSecret, s)).sort(),
    );

    // 같은 팀 일정 스위치를 끄면 근태·자리비움을 읽지 않고 부서 인원만 세요(접속기록도 더 안 남아요).
    await t.ctx.ops.setFlag('p_op', 'teamSchedule', false);
    const before = access.rows.length;
    const off = await chat(me, '내일 5시 빈 회의실 있어?');
    expect(off.reply).toContain('인원은 우리 팀 6명으로 봤어요');
    expect((await t.db.query("select 1 from access_log where action = 'team.headcount'")).rows).toHaveLength(before);

    // 인원을 말하면 그 수가 먼저예요. 2명이면 정원 4명 회의실도 후보예요.
    const two = await chat(me, '내일 4시 2명 빈 회의실 있어?');
    expect(two.reply).not.toContain('우리 팀');
    expect(capacities(two)).toContain(4);
  });

  it('묻는 문장은 후보 카드와 [이 회의실로 예약](확인 시트)이에요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const out = await chat(me, '내일 3시 6명 빈 방 있어?');
    expect(out.cards.some((c) => c.actions.primary?.type === 'propose' && c.actions.primary.text === '이 회의실로 예약')).toBe(true);
  });

  it('화면 판이 서버 판과 다르면(배포 뒤 오래 연 탭) 바로 실행하지 않고 카드로만 보여 줘요(배포 준비 회의 D1)', async () => {
    const t = await setup();
    t.ctx.config.build = 'b2';
    const me = await t.loginAs(MOCK.staff);
    const send = (build?: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/rooms/chat',
        headers: { cookie: me.cookie, 'x-csrf-token': me.csrf, ...(build ? { 'x-desk-build': build } : {}) },
        payload: { text: '내일 3시 6명 회의실 잡아 줘', requestId: newRequestId() },
      });
    // 옛 판 화면, 판 머리가 없는 더 옛 화면은 화면이 보여 준 "지금 동작"과 서버 판정이 다를 수 있어요.
    expect((await send('b1')).json()).toMatchObject({ changed: false });
    expect((await send()).json()).toMatchObject({ changed: false });
    expect(await appReservations(t)).toHaveLength(0);
    // 같은 판이면 그대로 바로 예약해요.
    expect((await send('b2')).json()).toMatchObject({ changed: true });
    expect(await appReservations(t)).toHaveLength(1);
  });

  it('운영 스위치 autoActions를 끄면 카드로만 보여 줘요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/flag', { flag: 'autoActions', value: false })).status).toBe(200);
    expect(((await op.call('GET', '/api/config/public')).body as { autoActions: boolean }).autoActions).toBe(false);
    const me = await t.loginAs(MOCK.staff);
    const out = await chat(me, '내일 3시 6명 회의실 잡아 줘');
    expect(out).toMatchObject({ changed: false });
    expect(out.reply).toContain('채팅 자동 예약이 꺼져 있어요');
    expect(await appReservations(t)).toHaveLength(0);
  });

  it('회의실 쓰기를 끄면 "카드에서 하세요" 대신 그룹웨어로 안내해요(QA D-C03)', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/flag', { flag: 'roomsWrite', value: false })).status).toBe(200);
    const me = await t.loginAs(MOCK.staff);
    const writes = (cards: Card[]) => cards.flatMap((c) => [c.actions.primary, ...c.actions.secondary]).filter((a) => a && a.type !== 'link');

    for (const text of ['내일 3시 6명 회의실 잡아 줘', '내일 3시 6명 빈 방 있어?']) {
      const out = await chat(me, text);
      expect(out.reply, text).toContain('그룹웨어에서 예약하기');
      expect(out.reply, text).not.toContain('카드에서 확인하고');
      expect(writes(out.cards), text).toEqual([]);
    }
    const rent = await chat(me, '내일 3시 빔프로젝터 빌려 줘');
    expect(rent.reply).toBe('지금은 이 앱에서 장비를 빌리지 않아요. 남은 수만 보여 드려요. 빌리려면 그룹웨어로 신청해 주세요');
    expect(writes(rent.cards)).toEqual([]);
    expect(rent.cards.at(-1)!.actions.primary).toMatchObject({ type: 'link' });
    const mine = await chat(me, '내 예약 보여 줘');
    expect(mine.cards[0]!.actions.primary).toMatchObject({ type: 'link' });
    const help = await chat(me, '안녕하세요');
    expect(help.cards[0]!.tail).toBe('지금은 예약·대여를 그룹웨어에서 해요. 채팅으로는 빈 회의실·장비 현황을 볼 수 있어요');
    expect(help.cards[0]!.fields.map((f) => f.name)).not.toContain('예약');
    expect(await appReservations(t)).toHaveLength(0);
  });

  it('다른 페이지에서 옮겨 온 문장(noAuto)은 시키는 말이어도 자동으로 예약하지 않아요(통합 입력 칸)', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const res = await me.call('POST', '/api/rooms/chat', { text: '내일 3시 6명 회의실 잡아 줘', requestId: newRequestId(), noAuto: true });
    expect(res.status).toBe(200);
    const out = res.body as RoomChatResponse;
    expect(out.changed).toBe(false);
    expect(out.cards.some((c) => c.actions.primary?.type === 'propose')).toBe(true);
    expect(await appReservations(t)).toHaveLength(0);
    // 같은 문장을 사람이 직접 보내면 바로 예약해요.
    expect((await chat(me, '내일 3시 6명 회의실 잡아 줘')).changed).toBe(true);
  });

  it('회의실 일이 아닌 문장은 도움말과 [문의하기에서 찾기]를 줘요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const out = await chat(me, '법인카드 잃어버렸어요');
    expect(out.cards[0]!.id).toBe('rooms-chat-help');
    expect(out.cards[0]!.actions.secondary).toEqual([{ type: 'reask', text: '문의하기에서 찾기', kind: 'navi' }]);
  });

  it('빠진 조건을 되물을 때 "알려 주면 바로 예약"이라고 약속하지 않고 한 문장으로 다시 말해 달라고 해요(QA D-B02)', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const out = await chat(me, '회의실 잡아 줘');
    expect(out.reply).toContain('조건을 모두 넣어 한 번에 다시 말해 주세요');
    expect(out.reply).not.toContain('바로 예약할게요');
  });

  it('사람별 하루 5번까지만 자동으로 실행해요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    for (const at of ['10:00', '11:00', '13:00', '14:00', '16:00']) expect((await chat(me, `내일 ${at} 2명 잡아 줘`)).changed).toBe(true);
    const sixth = await chat(me, '내일 17:00 2명 잡아 줘');
    expect(sixth).toMatchObject({ changed: false });
    expect(sixth.reply).toContain('오늘 채팅 자동 실행 5번을 다 썼어요');
    expect(await appReservations(t)).toHaveLength(5);

    // 다른 사람은 따로 세요. 다음 날이 되면 다시 돼요.
    const other = await t.loginAs(MOCK.dev);
    expect((await chat(other, '내일 17:00 2명 잡아 줘')).changed).toBe(true);
    t.advance(24 * 3_600_000);
    const nextDay = await t.loginAs(MOCK.staff);
    expect((await chat(nextDay, '내일 17:00 2명 잡아 줘')).changed).toBe(true);
  });
});

/** 목적마다 정해 준 답을 돌려주는 실제 모델 흉내. 정한 답이 없으면 부르는 쪽의 규칙 해석을 돌려줘요. */
class ScriptedProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  reply: unknown = undefined;
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    return { output: req.schema.parse(this.reply ?? req.fallback()), inputTokens: 1, outputTokens: 1 };
  }
}

describe('바로 실행하면 안 되는 문장(10/29 회의 A1)', () => {
  // 서버에서만 걸러지는 문장: 날짜를 못 읽음("화상회의"는 화요일이 아니에요), 같은 칸에 값이 둘
  const SERVER_ONLY = [
    '다음 주 화상회의 3시 6명 잡아 줘',
    '이번 주 일정 3시 6명 잡아 줘',
    '내일 3시나 4시에 6명 잡아 줘',
    '내일 3시 6명이나 8명 회의실 잡아 줘',
    '내일 3시나 4시에 노트북 빌려 줘',
  ];

  it('공유 금지 표와 서버 전용 문장은 예약·대여·plan을 하나도 만들지 않아요', async () => {
    const t = await setup();
    t.ctx.ops.patchValues({ rateLimitPerMinute: 10_000 });
    const me = await t.loginAs(MOCK.staff);
    for (const text of [...NO_AUTO_SENTENCES, ...SERVER_ONLY]) expect((await chat(me, text)).changed, text).toBe(false);
    expect(await appReservations(t)).toHaveLength(0);
    expect(await loans(t)).toHaveLength(0);
    expect((await t.db.query('select 1 from plans')).rows).toHaveLength(0);
  });

  it('같은 칸에 값이 둘이면 이유를 말하고 카드만 보여 줘요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const out = await chat(me, '내일 3시나 4시에 6명 잡아 줘');
    expect(out.reply).toBe('시각이 둘 이상 있어서 바로 실행하지 않았어요. 맞는 카드에서 골라 주세요');
    expect(out.cards.some((c) => c.actions.primary?.type === 'propose')).toBe(true);
    expect((await t.ctx.audit.recent(1))[0]).toMatchObject({ channel: 'ask', action: 'chat', result: 'held' });
  });

  it('모델이 어떤 일·장비를 골라도 규칙이 시키는 말로 본 일 밖의 쓰기는 없어요', async () => {
    const provider = new ScriptedProvider();
    const t = await createTestApp({ provider });
    opened.push(t);
    await t.modules.find((m) => m.kind === 'rooms')!.seed!();
    t.ctx.gateway = new AiGateway(provider, true, t.db);
    t.ctx.ops.patchValues({ rateLimitPerMinute: 10_000 });
    const me = await t.loginAs(MOCK.staff);

    const texts = [...NO_AUTO_SENTENCES.slice(0, 8), '내 예약 보여 줘', '회의실별 장비 현황 알려 줘', '지금 빈 방 있어?'];
    for (const intent of CHAT_INTENTS) {
      provider.reply = { intent, command: true, kinds: [...LOAN_KINDS] };
      for (const text of texts) expect((await chat(me, text)).changed, `${intent} · ${text}`).toBe(false);
    }
    // 예약하라는 문장도 모델이 다른 일(대여)이나 말하지 않은 장비를 고르면 바로 실행하지 않아요.
    provider.reply = { intent: 'rent', command: true, kinds: ['노트북'] };
    expect((await chat(me, '내일 3시 6명 회의실 잡아 줘')).changed).toBe(false);
    provider.reply = { intent: 'reserve', command: true, kinds: ['노트북'] };
    expect((await chat(me, '내일 3시 6명 회의실 잡아 줘')).changed).toBe(false);
    expect(await appReservations(t)).toHaveLength(0);
    expect(await loans(t)).toHaveLength(0);

    // 모델과 규칙이 같으면 지금처럼 바로 예약해요.
    provider.reply = undefined;
    const done = await chat(me, '내일 3시 6명 회의실 잡아 줘');
    expect(done).toMatchObject({ changed: true, aiParsed: true });
    expect(await appReservations(t)).toHaveLength(1);
  });
});

describe('장비 대여', () => {
  it('예약하면서 장비도 빌리면 회의에 붙고, 회의를 취소하면 대여도 같이 취소돼요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const out = await chat(me, '내일 3시 6명 회의실 잡고 빔프로젝터도 빌려 줘');
    expect(out.changed).toBe(true);
    // 예약 확정 · 대여 확정 뒤에 같은 시간 다른 빈 회의실로 바꾸기 카드가 붙어요(11/5).
    expect(labels(out.cards)).toEqual(['확정', '확정', '제안']);
    expect(out.reply).toContain('빌렸어요: 빔프로젝터');
    // 빔프로젝터는 빌리는 장비라 방 조건(화면)에 들어가지 않아요.
    expect(
      (await t.db.query<{ params: { query: { equipment: string[] } } }>("select params from plans where action = 'reserve'")).rows[0]!.params.query.equipment,
    ).toEqual([]);
    expect(out.cards[1]!.fields).toEqual(expect.arrayContaining([{ name: '가져갈 곳', value: '2층 총무 보관함' }]));

    const [reservation] = await appReservations(t);
    expect((await loans(t))[0]).toMatchObject({ item_id: 'eq-projector-1', reservation_id: reservation!.id });
    const mine = (await me.call('GET', '/api/rooms/my-reservations')).body as { items: { loans: string[] }[] };
    expect(mine.items[0]!.loans).toEqual(['빔프로젝터']);

    const cancelled = await me.call('DELETE', `/api/rooms/reservations/${reservation!.id}`);
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { card: Card }).card.fields).toEqual(expect.arrayContaining([{ name: '같이 빌린 장비', value: '빔프로젝터 대여도 취소했어요' }]));
    expect(await loans(t)).toHaveLength(0);
  });

  it('"내일 3시 회의"처럼 내 예약 시각을 말하면 그 회의에 붙여 빌려요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    await chat(me, '내일 3시 6명 회의실 잡아 줘');
    const out = await chat(me, '내일 3시 회의에 노트북이랑 웹캠 빌려 줘');
    expect(out.changed).toBe(true);
    expect(out.reply).toContain('빌렸어요: 노트북·웹캠');
    const [reservation] = await appReservations(t);
    expect((await loans(t)).map((l) => l.reservation_id)).toEqual([reservation!.id, reservation!.id]);
  });

  it('같은 시간에 남은 장비가 없으면 막히고 아무것도 쓰지 않아요', async () => {
    const t = await setup();
    const a = await t.loginAs(MOCK.staff);
    const b = await t.loginAs(MOCK.dev);
    const c = await t.loginAs(MOCK.hr);
    expect((await chat(a, '내일 2시 빔프로젝터 빌려 줘')).changed).toBe(true);
    expect((await chat(b, '내일 2시 빔프로젝터 빌려 줘')).changed).toBe(true);
    const third = await chat(c, '내일 2시 30분 빔프로젝터 빌려 줘');
    expect(third.changed).toBe(false);
    expect(third.cards[0]).toMatchObject({ label: '막힘', headline: '그 시간에 빌릴 수 있는 빔프로젝터가 없어요' });
    expect(await loans(t)).toHaveLength(2);
  });

  it('묻는 문장은 남은 수와 [빌리기](확인 시트)예요. 확인하면 바로 확정이에요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const out = await chat(me, '내일 3시 노트북 빌릴 수 있어?');
    expect(out.changed).toBe(false);
    expect(out.cards[0]!.fields).toEqual([{ name: '노트북', value: '3대 남음 · 전체 3대' }]);
    const primary = out.cards[0]!.actions.primary;
    if (primary?.type !== 'propose') throw new Error('빌리기 버튼이 없어요');
    expect(primary.text).toBe('빌리기');

    const created = (await me.call('POST', '/api/plans', { proposalToken: primary.proposalToken })).body as PlanCreateResponse;
    if (created.status !== 'sheet') throw new Error('확인 시트가 아니에요');
    expect(created.sheet.confirmLabel).toBe('빌리기');
    const done = (await me.call('POST', `/api/plans/${created.planId}/confirm`)).body as PlanConfirmResponse;
    expect(done).toMatchObject({ status: 'done', card: { headline: '장비를 빌렸어요' } });
    expect(await loans(t)).toHaveLength(1);
  });

  it('시작 전에는 [대여 취소], 쓰는 중에는 [반납]이에요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const first = await chat(me, '오늘 10시 스피커폰 빌려 줘');
    const cancel = fixedOf(first.cards[0], '대여 취소');
    expect((await me.call('DELETE', cancel.path)).body).toMatchObject({ card: { headline: '대여를 취소했어요' } });
    expect(await loans(t)).toHaveLength(0);

    const second = await chat(me, '오늘 10시 스피커폰 빌려 줘');
    expect(fixedOf(second.cards[0], '대여 취소').path).toMatch(/^\/api\/rooms\/loans\/\d+$/);
    t.advance(90 * 60_000); // 10:30, 쓰는 중
    const listed = (await me.call('GET', '/api/rooms/my-loans')).body as { items: { endAction: CardAction }[] };
    const back = listed.items[0]!.endAction;
    if (back.type !== 'fixed') throw new Error('반납 버튼이 없어요');
    expect(back.text).toBe('반납');
    expect((await me.call('DELETE', back.path)).body).toMatchObject({ card: { headline: '반납했어요' } });
    expect(new Date((await loans(t))[0]!.upper).getTime()).toBe(t.now());
    // 남의 대여는 끝낼 수 없어요.
    const other = await t.loginAs(MOCK.dev);
    expect((await other.call('DELETE', back.path)).status).toBe(404);
  });

  it('대여는 실행 중인 rent plan 없이는 DB에 들어가지 않아요', async () => {
    const t = await setup();
    await expect(
      t.db.query(
        "insert into room_equipment_loans (item_id, slot, pseudonym_id, plan_id) values ('eq-laptop-1', tstzrange(now(), now() + interval '1 hour'), 'p_x', gen_random_uuid())",
      ),
    ).rejects.toThrow(/confirmed plan/);
  });
});

describe('현황·장비 현황', () => {
  it('내 예약·대여, 지금 빈 방, 방별 장비를 읽기만 해요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    await chat(me, '내일 3시 6명 회의실 잡고 노트북도 빌려 줘');
    const before = (await t.db.query('select 1 from plans')).rows.length;

    const mine = await chat(me, '내 예약 보여 줘');
    expect(mine.reply).toBe('다가오는 예약 1건, 대여 1건이에요');
    expect(mine.cards.map((c) => c.headline)).toEqual(['내 예약', '내 대여']);
    expect(mine.cards[0]!.fields).toEqual(expect.arrayContaining([{ name: '같이 빌린 장비', value: '노트북' }]));

    const free = await chat(me, '지금 빈 방 있어?');
    expect(free.cards[0]!.headline).toMatch(/^지금 빈 회의실 \d+곳이에요$/);
    // 하늘(3층)에게는 3층 회의실이 먼저예요. 층을 말하면 그 층만 보여 줘요(10/28 사용성 점검).
    expect(free.cards[0]!.fields[0]!.name).toMatch(/· 3층$/);
    const fifth = await chat(me, '5층 회의실 지금 비어 있어?');
    expect(fifth.reply).toBe('지금 비어 있는 5층 회의실이에요');
    expect(fifth.cards[0]!.fields.length).toBeGreaterThan(0);
    expect(fifth.cards[0]!.fields.every((f) => f.name.endsWith('· 5층'))).toBe(true);
    // [그림으로 모든 회의실 보기]가 펼칠 조건은 현황 카드에만 있어요(10/30 QA·디자인 회의).
    expect(free.cards[0]!.overview!.show).toEqual({ date: '2026-10-26', onlyFree: true });
    expect(fifth.cards[0]!.overview!.show).toEqual({ date: '2026-10-26', onlyFree: true, floor: '5층' });
    expect((await chat(me, '대회의실 현황')).cards[0]!.overview!.show).toEqual({ date: '2026-10-26', onlyFree: false, roomId: 'r-5c' });
    expect(mine.cards.some((c) => c.overview)).toBe(false);

    const room = await chat(me, '5A 장비 뭐 있어?');
    expect(room.cards[0]!.fields).toEqual(
      expect.arrayContaining([
        { name: '설비', value: '없음' },
        { name: '점검 중', value: '화상회의' },
      ]),
    );
    const all = await chat(me, '회의실 장비 현황 알려 줘');
    expect(all.cards[0]!.fields).toEqual(expect.arrayContaining([{ name: '회의실 5A · 5층', value: '화상회의(점검 중)' }]));
    expect(all.cards[1]!.fields).toEqual(expect.arrayContaining([{ name: '노트북', value: '3대 남음 · 전체 3대' }]));
    expect((await t.db.query('select 1 from plans')).rows.length).toBe(before);
  });

  // 10/30 QA·디자인 회의: 대화 현황은 회의실마다 누를 수 있는 한 줄(variant)이에요. 누르면 회의실 자세히, 예약은 거기서 확인 시트를 거쳐요.
  it('현황 카드는 한 줄 목록이고, 내 층 먼저·층 번호·이름 순이에요. 날짜는 "10월 26일(월)"로 쓰고 근거에 기준 시각이 있어요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const out = await chat(me, '회의실 현황 보여 줘');
    expect(out.reply).toBe('오늘 10월 26일(월) 회의실 현황이에요');
    const card = out.cards[0]!;
    expect(card).toMatchObject({ variant: 'rooms-overview', label: '안내', headline: '오늘 10월 26일(월) 회의실 10곳 현황이에요' });
    expect(card.evidence.text).toMatch(/^현황 \d\d:\d\d 기준$/);
    const rows = card.overview!.rows;
    expect(rows).toHaveLength(10);
    expect(rows.slice(0, 3).every((r) => r.floor === '3층' && r.mine)).toBe(true);
    const order = rows.map((r) => `${r.floor}|${r.name}`);
    const rest = rows.filter((r) => !r.mine).map((r) => `${r.floor}|${r.name}`);
    expect(rest).toEqual([...rest].sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b)));
    expect(order.length).toBe(new Set(order).size);
    // 글 칸도 같은 내용이에요(따로 그리지 못하는 화면용).
    expect(card.fields[0]).toEqual({ name: `${rows[0]!.name} · ${rows[0]!.floor}`, value: expect.stringMatching(/^지금 비어 있어요|^사용 중/) });
    expect(card.tail).toBe('회의실을 누르면 그날 일정을 보고, 확인 한 번으로 예약해요');
  });

  it('다른 날은 그날 기준이에요: "내일 현황"은 예약 수, "내일 빈 회의실"은 그날 예약 없는 곳만이에요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    await chat(me, '내일 3시 6명 회의실 잡아 줘');
    const day = await chat(me, '내일 회의실 현황');
    expect(day.reply).toBe('10월 27일(화) 회의실 현황이에요');
    expect(day.cards[0]!.overview).toMatchObject({ date: '2026-10-27', today: '2026-10-26' });
    expect(day.cards[0]!.overview!.rows.every((r) => r.status.kind === 'day')).toBe(true);
    const booked = day.cards[0]!.overview!.rows.filter((r) => r.status.kind === 'day' && r.status.bookings > 0).length;
    expect(booked).toBeGreaterThan(0);

    const free = await chat(me, '내일 빈 회의실 있어?');
    expect(free.reply).toBe('10월 27일(화) 예약 없는 회의실이에요');
    const rows = free.cards[0]!.overview!.rows;
    expect(rows.length).toBe(10 - booked);
    expect(rows.every((r) => r.status.kind === 'day' && r.status.bookings === 0)).toBe(true);
    expect(free.cards[0]!.headline).toBe(`10월 27일(화) 예약 없는 회의실 ${10 - booked}곳이에요`);
    expect(free.cards[0]!.overview!.show).toEqual({ date: '2026-10-27', onlyFree: true });
  });

  it('없는 층은 빈 카드 대신 "없어요"라고 해요. 응답에 예약자·회의 제목·가명 ID가 없고, 묻기만으로는 아무것도 쓰지 않아요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    await chat(me, '오늘 4시 6명 회의실 잡아 줘');
    const before = { plans: (await t.db.query('select 1 from plans')).rows.length, res: (await appReservations(t)).length };
    const none = await chat(me, '9층 회의실 현황');
    expect(none.cards[0]!.headline).toBe('9층 회의실이 없어요');
    expect(none.cards[0]!.overview!.rows).toEqual([]);

    const other = await t.loginAs(MOCK.dev);
    const out = await chat(other, '지금 빈 회의실 잡아 줘');
    const json = JSON.stringify(out);
    for (const secret of ['pseudonym', 'subject', 'title', MOCK.staff, '하늘']) expect(json).not.toContain(secret);
    expect((await t.db.query('select 1 from plans')).rows.length).toBe(before.plans);
    expect(await appReservations(t)).toHaveLength(before.res);
  });

  it('회의실 쓰기가 꺼지면 현황 꼬리에 "잡아 줘" 대신 그룹웨어 안내가 붙어요(QA D-C03)', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/flag', { flag: 'roomsWrite', value: false })).status).toBe(200);
    const me = await t.loginAs(MOCK.staff);
    const out = await chat(me, '회의실 현황 보여 줘');
    expect(out.cards[0]!.tail).toBe('회의실을 누르면 그날 일정을 봐요. 예약은 그룹웨어에서 해요');
    expect(out.cards[0]!.tail).not.toContain('잡아 줘');
    expect(out.cards[0]!.actions).toEqual({ secondary: [] });
  });

  it('점검 중인 설비는 찾기 조건에 맞지 않고, 총무만 상태를 바꿔요', async () => {
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const list = (await staff.call('GET', '/api/rooms/list?date=2026-10-27')).body as RoomListResponse;
    expect(list.rooms.find((r) => r.id === 'r-5a')).toMatchObject({ equipment: [], repairs: ['화상회의'] });

    const found = await t.ctx.services.rooms!.findFree({ date: '2026-10-27', start: '15:00', minutes: 60, people: 2, equipment: ['화상회의'] });
    expect([...found.candidates, ...found.alternatives].map((c) => c.roomId)).not.toContain('r-5a');

    expect((await staff.call('PUT', '/api/rooms/r-5a/facilities', { facility: '화상회의', status: 'ok' })).status).toBe(403);
    const fm = await t.loginAs(MOCK.facilities);
    expect((await fm.call('PUT', '/api/rooms/r-5a/facilities', { facility: '화이트보드', status: 'repair' })).status).toBe(400);
    expect((await fm.call('PUT', '/api/rooms/r-5a/facilities', { facility: '화상회의', status: 'ok' })).status).toBe(200);
    const after = (await staff.call('GET', '/api/rooms/list?date=2026-10-27')).body as RoomListResponse;
    expect(after.rooms.find((r) => r.id === 'r-5a')).toMatchObject({ equipment: ['화상회의'], repairs: [] });

    // 다시 시드해도 총무가 바꾼 값은 그대로예요.
    await t.modules.find((m) => m.kind === 'rooms')!.seed!();
    const again = (await staff.call('GET', '/api/rooms/list?date=2026-10-27')).body as RoomListResponse;
    expect(again.rooms.find((r) => r.id === 'r-5a')!.repairs).toEqual([]);
  });

  it('입력 검사에 걸리면 내용 없이 422예요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    const res = await me.call('POST', '/api/rooms/chat', { text: '내일 3시 6명 잡아 줘 비밀번호: hunter2zz', requestId: newRequestId() });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain('hunter2zz');
    expect((await t.ctx.audit.recent(1))[0]).toMatchObject({ channel: 'ask', action: 'chat', result: 'locked' });
  });
});

describe('알아들은 것(11/5 시험, AI 보완 2번)', () => {
  it('모델 없이(낱말 규칙) 돌면 알아들은 것만 붙여요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.staff);
    expect((await chat(me, '지금 빈 회의실 있어?')).read).toEqual({ understood: '예약 현황 보기' });
  });

  it('AI가 낱말 규칙과 다르게 보면 규칙이 본 것도 같이, 같으면 알아들은 것만 붙여요', async () => {
    const provider = new ScriptedProvider();
    const t = await createTestApp({ provider });
    opened.push(t);
    await t.modules.find((m) => m.kind === 'rooms')!.seed!();
    t.ctx.gateway = new AiGateway(provider, true, t.db);
    const me = await t.loginAs(MOCK.staff);
    provider.reply = { intent: 'help', command: false, kinds: [] };
    expect((await chat(me, '회의실 쓰는 법 알려 줘')).read).toEqual({ understood: '도움말', ruleSaid: '회의실 찾기·예약' });
    provider.reply = undefined;
    expect((await chat(me, '노트북 몇 대 남았어?')).read).toEqual({ understood: '장비 현황 보기 · 노트북' });
  });

  it('모델이 장비 이름을 줄여 보내도("프로젝터", "빔 프로젝터") 목록 값으로 맞추고 AI 해석이 실패하지 않아요(11/5)', async () => {
    const provider = new ScriptedProvider();
    const t = await createTestApp({ provider });
    opened.push(t);
    await t.modules.find((m) => m.kind === 'rooms')!.seed!();
    t.ctx.gateway = new AiGateway(provider, true, t.db);
    const me = await t.loginAs(MOCK.staff);
    for (const said of [['프로젝터'], ['빔 프로젝터'], ['빔프로젝터', '없는 장비']]) {
      provider.reply = { intent: 'equipment', command: false, kinds: said };
      const out = await chat(me, '빔프로젝터 남았어?');
      expect(out.aiParsed, said.join(',')).toBe(true);
      expect(out.read, said.join(',')).toEqual({ understood: '장비 현황 보기 · 빔프로젝터' });
    }
    expect((await t.ctx.gateway.usageByModule()).find((u) => u.module === 'rooms')?.failures ?? 0).toBe(0);
  });
});

describe('11/5 처음 쓰는 직원 점검: 후보 바꾸기·길이 안내·매주 반복', () => {
  it('반복 횟수: 매주·주마다가 있어야 하고, 4주·6번·한 달·두 달을 읽고 2~8번으로 맞춰요', () => {
    expect(repeatWeeksOf('내일 3시 회의실 잡아 줘')).toBeNull();
    expect(repeatWeeksOf('매주 화요일 3시 잡아 줘')).toBe(4);
    expect(repeatWeeksOf('매주 화요일 3시 6번 잡아 줘')).toBe(6);
    expect(repeatWeeksOf('주마다 월요일 10시 한 달 동안')).toBe(4);
    expect(repeatWeeksOf('매주 수요일 두 달')).toBe(8);
    expect(repeatWeeksOf('매주 금요일 20주')).toBe(8);
    expect(repeatWeeksOf('2주 뒤부터 매주 목요일')).toBe(4);
  });

  it('바로 잡은 뒤 같은 시간 다른 빈 회의실로 바꾸기 버튼이 붙고, 누르면 같은 예약이 그 회의실로 옮겨요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const out = await chat(me, '내일 3시 4명 회의실 잡아 줘');
    expect(out.reply).toContain('다른 빈 회의실');
    // 길이를 말하지 않으면 기본 길이로 봤다고 알려요.
    expect(out.reply).toContain('길이를 말하지 않아 1시간으로 봤어요');
    const other = out.cards.find((c) => c.id.startsWith('rooms-other-'))!;
    expect(other).toMatchObject({ label: '제안', headline: '다른 빈 회의실로 바꿀 수 있어요' });
    expect(other.actions.secondary.length).toBeGreaterThan(0);
    const move = other.actions.secondary[0]!;
    if (move.type !== 'fixed') throw new Error('바꾸기 버튼이 고정 버튼이 아니에요');
    expect(move.confirm?.confirmLabel).toBe('바꾸기');
    const before = await appReservations(t);
    expect(before).toHaveLength(1);
    expect((await me.call(move.method, move.path, move.body)).status).toBe(200);
    const after = await appReservations(t);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.room_id).toBe((move.body as { roomId: string }).roomId);
    // 길이를 말하면 안내가 없어요. 회의실을 말하면 바꾸기 카드가 없어요.
    const said = await chat(me, '모레 3시 4명 2시간 회의실 잡아 줘');
    expect(said.reply).not.toContain('길이를 말하지 않아');
  });

  it('매주 반복은 바로 잡지 않고 카드에서 고르면 잡을 날을 확인 시트로 보여 주고, 이미 예약된 주는 빼고 잡아요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const out = await chat(me, '매주 화요일 3시 4명 회의실 4주 잡아 줘');
    expect(out.changed).toBe(false);
    expect(out.reply).toContain('매주 4번 잡을 회의실이에요');
    expect(await appReservations(t)).toHaveLength(0);
    const card = out.cards.find((c) => c.actions.primary?.type === 'propose')!;
    expect(card.fields).toContainEqual({ name: '반복', value: '매주 같은 시간 4번 · 이미 예약된 주는 빼고 잡아요' });
    const action = card.actions.primary as Extract<CardAction, { type: 'propose' }>;
    const sheet = (await me.call('POST', '/api/plans', { proposalToken: action.proposalToken })).body as PlanCreateResponse;
    if (sheet.status !== 'sheet') throw new Error('확인 시트가 아니에요');
    expect(sheet.sheet.lines).toContainEqual('매주 같은 시간 4번: 10월 27일(화) · 11월 3일(화) · 11월 10일(화) · 11월 17일(화) · 이미 예약된 주는 빼고 잡아요');
    // 셋째 주는 다른 사람이 먼저 같은 회의실을 잡았어요.
    const roomId = (card.id.match(/^rooms-slot-(.+)-\d+$/) ?? [])[1]!;
    const other = await t.loginAs(MOCK.staff);
    const third = await chat(other, `11월 10일 3시 4명 ${(await listRooms(t.db)).find((r) => r.id === roomId)!.name} 잡아 줘`);
    expect(third.changed).toBe(true);
    const done = (await me.call('POST', `/api/plans/${sheet.planId}/confirm`)).body as PlanConfirmResponse;
    expect(done.status).toBe('done');
    if (done.status !== 'done') return;
    expect(done.card.headline).toBe('매주 3번 예약했어요');
    expect(done.card.fields.find((f) => f.name === '반복')?.value).toBe('10월 27일(화) · 11월 3일(화) · 11월 17일(화) · 이미 예약돼 있어 뺀 날: 11월 10일(화)');
    const mine = (
      await t.db.query<{ series_no: number }>('select series_no from room_reservations where plan_id = $1 order by series_no', [sheet.planId])
    ).rows.map((r) => r.series_no);
    expect(mine).toEqual([0, 1, 3]);
    // 같은 plan을 다시 확인해도 더 생기지 않아요.
    await me.call('POST', `/api/plans/${sheet.planId}/confirm`);
    expect((await t.db.query('select 1 from room_reservations where plan_id = $1', [sheet.planId])).rows).toHaveLength(3);
  });
});
