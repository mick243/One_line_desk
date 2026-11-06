import type { PlanCreateResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../testing';
import { pseudonymize } from './pseudonym';

// 카운터 기기의 카페 판 전용 세션(11/6 3묶음, 사용자 결정, ADR-20 예외·ADR-29, PRD F4-4 완료 기준).
// - [카페 판으로 로그인]은 바리스타(역할 cafe)만이고, 카페가 '켬'일 때만이에요. 아니면 세션을 만들지 않아요.
// - 판 세션은 허용 목록(core/board-session.ts)의 카페 판 경로만 열려요. 새 경로도 목록에 없으면 403이에요(기본 거부).
// - 쉬는 시간(3시간)으로 끊지 않고 로그인부터 운영 값 cafeBoardSessionHours(기본 13시간) 뒤 끊겨요. 보통 세션은 그대로 3시간이에요.
// - 재직·역할 재확인(ADR-13)은 그대로예요. 판 로그인·로그아웃은 접속기록에 따로 남아요.
// 시계는 2026-10-26(월) 09:00(한국)이에요.

const MIN = 60_000;
const HOUR = 60 * MIN;
type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

const NEW_ROUTE = '/api/test/new-feature';

async function setup(o: { on?: boolean } = {}) {
  const t = await createTestApp();
  opened.push(t);
  // 허용 목록에 없는 새 경로(로그인한 사람이면 누구나 부를 수 있어요). 판 세션으로는 기본 거부여야 해요.
  t.app.get(NEW_ROUTE, { preHandler: t.ctx.guards.user }, async () => ({ ok: true }));
  await t.modules.find((m) => m.kind === 'cafeteria')!.seed!();
  if (o.on ?? true) await t.ctx.ops.setModule('p_test-operator', 'cafeteria', 'on');
  return t;
}

/** [카페 판으로 로그인](모의 로그인 + 판 전용 표시) */
async function boardLogin(t: TestApp, subject: string = MOCK.barista) {
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { idpSubject: subject, board: true } });
  const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0]!;
  return { res, cookie };
}

/** 판 세션으로 API를 불러요. 판 새로 읽기처럼 사람이 누르지 않는 요청은 background예요. */
async function boardSession(t: TestApp) {
  const { res, cookie } = await boardLogin(t);
  expect(res.statusCode).toBe(200);
  const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  expect(me.statusCode).toBe(200);
  const csrf = me.json().csrfToken as string;
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, background = false) => {
    const r = await t.app.inject({
      method,
      url,
      headers: { cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }), ...(background ? { 'x-desk-background': '1' } : {}) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: r.statusCode, body: r.body ? r.json() : undefined };
  };
  return { cookie, me: me.json(), call, poll: () => call('GET', '/api/cafe/board', undefined, true) };
}

async function accessRows(t: TestApp) {
  const { rows } = await t.db.query<{ action: string; pseudonym_id: string }>('select action, pseudonym_id from access_log order by id');
  return rows;
}

describe('[ADR-20 시험] 카페 판 전용 로그인', () => {
  it('[F4-4] 바리스타가 아니면 [카페 판으로 로그인]으로 세션이 생기지 않아요. 카페가 꺼져 있으면 바리스타도 0이에요', async () => {
    const t = await setup();
    for (const subject of [MOCK.staff, MOCK.facilities, MOCK.operator]) {
      const { res } = await boardLogin(t, subject);
      expect(res.statusCode, subject).toBe(403);
      expect(res.json()).toEqual({ error: 'not-barista', message: '바리스타만 카페 판으로 로그인할 수 있어요' });
      expect(String(res.headers['set-cookie'] ?? '')).not.toContain('desk_sid=');
    }
    expect(t.ctx.sessions.size).toBe(0);
    expect((await t.ctx.audit.recent(1))[0]).toMatchObject({ channel: 'auth', action: 'login', result: 'not-barista' });

    await t.ctx.ops.setModule('p_test-operator', 'cafeteria', 'off');
    const off = await boardLogin(t);
    expect(off.res.statusCode).toBe(409);
    expect(t.ctx.sessions.size).toBe(0);
    // 막힌 로그인은 접속기록에 로그인으로 남지 않아요.
    expect(await accessRows(t)).toEqual([]);
  });

  it('[ADR-20 시험] 판 세션의 내 정보는 판 세션이라는 것·남은 시간·CSRF 토큰뿐이고 역할은 cafe만 실려요', async () => {
    const t = await setup();
    const board = await boardSession(t);
    expect(board.me).toEqual({ displayName: '', department: '', floor: '', roles: ['cafe'], csrfToken: expect.any(String), board: { leftMs: 13 * HOUR } });
  });
});

describe('[ADR-20 시험] 판 전용 세션은 허용 목록의 카페 판 경로만 열려요', () => {
  it('[F4 완료 기준] 카페 판 읽기·영업·주문 상태·품절은 되고, 직원·총무·홈·문의·알림·운영 경로와 허용 목록 밖 새 경로는 403이에요', async () => {
    const t = await setup();
    const board = await boardSession(t);
    // 카페 판(허용 목록)
    expect((await board.call('POST', '/api/cafe/board/open')).status).toBe(200);
    expect((await board.poll()).status).toBe(200);
    expect((await board.call('PUT', '/api/cafe/menu/latte/sold-out', { soldOut: true })).status).toBe(200);
    expect((await board.call('PUT', '/api/cafe/menu/latte/sold-out', { soldOut: false })).status).toBe(200);
    const staff = await t.loginAs(MOCK.staff);
    const slot = (await staff.call('GET', '/api/cafe')).body.slots[0].start as string;
    const proposed = await staff.call('POST', '/api/cafe/order/propose', { lines: [{ menuId: 'americano', qty: 1, options: [] }], pickupSlot: slot });
    const sheet = (await staff.call('POST', '/api/plans', { proposalToken: proposed.body.proposalToken })).body as Extract<
      PlanCreateResponse,
      { status: 'sheet' }
    >;
    const done = (await staff.call('POST', `/api/plans/${sheet.planId}/confirm`)).body;
    const orderId = done.card.id.replace('cafe-order-', '') as string;
    expect((await board.call('POST', `/api/cafe/orders/${orderId}/status`, { to: 'making' })).status).toBe(200);

    // 허용 목록 밖: 판 세션으로는 직원·총무·홈·문의·알림·운영 기능을 쓸 수 없어요.
    const denied: [method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown][] = [
      ['GET', '/api/cafe'],
      ['POST', '/api/cafe/order/propose', { lines: [{ menuId: 'americano', qty: 1, options: [] }], pickupSlot: slot }],
      ['POST', `/api/cafe/orders/${orderId}/cancel`],
      ['POST', `/api/cafe/orders/${orderId}/missed`],
      ['POST', '/api/cafe/limit/request', { amountWon: 600_000 }],
      ['GET', '/api/cafe/settle'],
      ['POST', '/api/plans', { proposalToken: proposed.body.proposalToken }],
      ['POST', '/api/home/ask', { text: '이번 주 내 일정 뭐 있어?' }],
      ['POST', '/api/ask', { text: '법인카드 분실 신고는 어디서 해?' }],
      ['GET', '/api/notifications'],
      ['GET', '/api/navi/inquiries/inbox'],
      ['GET', '/api/rooms/my-reservations'],
      ['GET', '/api/ops/settings'],
      ['POST', '/api/auth/logout-all'],
      ['GET', NEW_ROUTE],
    ];
    for (const [method, url, payload] of denied) {
      const res = await board.call(method, url, payload);
      expect(res, `${method} ${url}`).toEqual({ status: 403, body: { error: 'board-only', message: '카페 판 로그인으로는 이 기능을 쓸 수 없어요' } });
    }
    // 같은 바리스타가 자기 폰으로 보통 로그인하면 지금처럼 다른 기능이 열려요.
    const own = await t.loginAs(MOCK.barista);
    expect((await own.call('GET', NEW_ROUTE)).status).toBe(200);
    expect((await own.call('GET', '/api/notifications')).status).toBe(200);
    expect(own.me.roles).toEqual(['employee', 'cafe']);
  });
});

describe('[ADR-20 시험] 판 전용 세션의 길이', () => {
  it('[F4 완료 기준] 판 세션은 3시간 넘게 쉬어도 남고 로그인 13시간 뒤 끊겨요. 보통 세션(바리스타 개인 로그인 포함)은 지금처럼 3시간이에요', async () => {
    const t = await setup();
    const board = await boardSession(t);
    const own = await t.loginAs(MOCK.barista);
    const staff = await t.loginAs(MOCK.staff);
    expect((await board.call('POST', '/api/cafe/board/open')).status).toBe(200);

    // 판은 3초마다 배경 요청으로만 읽어요(사람이 누른 요청 없음). 3시간 1분이 지나도 판 세션은 그대로예요.
    t.advance(3 * HOUR + MIN);
    expect((await board.poll()).status).toBe(200);
    expect((await own.call('GET', '/api/me')).body).toMatchObject({ error: 'login-required', reason: 'idle' });
    expect((await staff.call('GET', '/api/me')).body).toMatchObject({ reason: 'idle' });

    // 한 시간마다 읽어도(재직 재확인은 그대로 돌아요) 13시간 직전까지 남아요.
    for (let h = 4; h <= 12; h += 1) {
      t.advance(HOUR);
      expect((await board.poll()).status, `${h}시간`).toBe(200);
    }
    t.advance(59 * MIN - MIN); // 로그인 12시간 59분
    expect((await board.poll()).status).toBe(200);
    expect((await board.call('GET', '/api/me')).body.board.leftMs).toBe(MIN);
    t.advance(MIN + 1000); // 13시간 1초
    expect(await board.poll()).toEqual({ status: 401, body: { error: 'login-required', message: '보안을 위해 다시 로그인해 주세요' } });
    expect(t.ctx.sessions.size).toBe(0);
  });

  it('[ADR-20 시험] 판 세션 길이는 운영 값 cafeBoardSessionHours(1~13시간)이고, 줄이면 열린 판 세션에도 바로 적용돼요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/values', { cafeBoardSessionHours: 14 })).status).toBe(400);
    expect((await op.call('PUT', '/api/ops/values', { cafeBoardSessionHours: 0 })).status).toBe(400);
    const board = await boardSession(t);
    expect((await op.call('PUT', '/api/ops/values', { cafeBoardSessionHours: 2 })).status).toBe(200);
    expect((await board.call('GET', '/api/me')).body.board.leftMs).toBe(2 * HOUR);
    t.advance(2 * HOUR - MIN);
    expect((await board.poll()).status).toBe(200);
    t.advance(2 * MIN);
    expect((await board.poll()).status).toBe(401);
  });

  it('[ADR-20 시험] 한 시간 회차 정리에서 보통 세션은 8시간에, 판 세션은 운영 값 시간에 지워져요', async () => {
    const t = await setup();
    await boardSession(t);
    await t.loginAs(MOCK.staff);
    expect(t.ctx.sessions.size).toBe(2);
    expect(t.ctx.sessions.sweep(t.now() + 8 * HOUR + MIN)).toBe(1);
    expect(t.ctx.sessions.size).toBe(1);
    expect(t.ctx.sessions.sweep(t.now() + 13 * HOUR + MIN)).toBe(1);
    expect(t.ctx.sessions.size).toBe(0);
  });
});

describe('[ADR-20·ADR-13 시험] 판 전용 세션의 재직·역할 재확인', () => {
  it('[F4 완료 기준] 바리스타 역할(cafe)이 빠지면 다음 요청에서 판 세션이 끊겨요. 같은 사람의 보통 세션은 남아요', async () => {
    const t = await setup();
    const board = await boardSession(t);
    const own = await t.loginAs(MOCK.barista);
    expect((await board.poll()).status).toBe(200);
    t.adapters.employees.setGroups(MOCK.barista, []);
    expect((await board.poll()).status).toBe(401);
    expect((await board.poll()).status).toBe(401);
    expect((await t.ctx.audit.recent(5)).map((a) => [a.action, a.result])).toContainEqual(['board.recheck', 'ended']);
    // 보통 세션은 역할만 바뀌어요(바리스타 메뉴가 아니게 돼요).
    const me = await own.call('GET', '/api/me');
    expect(me.status).toBe(200);
    expect(me.body.roles).toEqual(['employee']);
    // 역할이 빠진 채로는 다시 판 로그인도 안 돼요.
    expect((await boardLogin(t)).res.statusCode).toBe(403);
  });

  it('[ADR-20·ADR-13 시험] 퇴사하면 재확인 간격 뒤 첫 요청에서 판 세션도 끊겨요', async () => {
    const t = await setup();
    const board = await boardSession(t);
    t.adapters.employees.setActive(MOCK.barista, false);
    t.advance(5 * MIN);
    expect((await board.poll()).status).toBe(401);
    expect((await t.ctx.audit.recent(1))[0]).toMatchObject({ action: 'employment.recheck', result: 'ended' });
  });
});

describe('[ADR-20 시험] 접속기록', () => {
  it('[ADR-20 시험] 판 로그인·로그아웃은 보통 로그인·로그아웃과 구분돼 접속기록에 가명 ID로 남아요', async () => {
    const t = await setup();
    const barista = pseudonymize(t.ctx.config.pseudonymSecret, MOCK.barista);
    const board = await boardSession(t);
    const own = await t.loginAs(MOCK.barista);
    expect((await board.call('POST', '/api/auth/logout')).status).toBe(200);
    expect((await own.call('POST', '/api/auth/logout')).status).toBe(200);
    expect(await accessRows(t)).toEqual([
      { action: 'cafe-board.login', pseudonym_id: barista },
      { action: 'login', pseudonym_id: barista },
      { action: 'cafe-board.logout', pseudonym_id: barista },
      { action: 'logout', pseudonym_id: barista },
    ]);
    const audit = (await t.ctx.audit.recent(4)).reverse().map((a) => [a.action, a.result]);
    expect(audit).toEqual([
      ['login', 'ok-board'],
      ['login', 'ok'],
      ['logout', 'ok-board'],
      ['logout', 'ok'],
    ]);
    // 로그아웃한 판 세션은 다시 쓸 수 없어요.
    expect((await board.poll()).status).toBe(401);
  });
});
