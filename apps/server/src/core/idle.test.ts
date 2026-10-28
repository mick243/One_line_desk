import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../testing';

// 쉬는 시간 자동 끊기(ADR-20, 개인정보의 안전성 확보조치 기준 제6조④). 기본 3시간, 운영 값 idleTimeoutMinutes(5~180분)로 바꿔요.
// 점심(1시간)으로는 끊기지 않고, 점심을 넣은 정규 업무시간(9시간)에 다시 인증은 많아야 3번이에요(10/28 사용자 결정).
// 알림 폴링·판 자동 새로 고침 같은 배경 요청은 쉬는 시간을 늘리지 않아요.

const MIN = 60_000;
type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  return { t, me: await t.loginAs(MOCK.staff) };
}

describe('쉬는 시간 자동 끊기(C-1)', () => {
  it('점심 1시간·2시간 59분 쉬면 그대로, 3시간 넘게 쉬면 끊기고 이유를 알려 줘요', async () => {
    const { t, me } = await setup();
    t.advance(60 * MIN);
    expect((await me.call('GET', '/api/me')).status).toBe(200);
    t.advance(179 * MIN);
    expect((await me.call('GET', '/api/me')).status).toBe(200);
    t.advance(181 * MIN);
    const ended = await me.call('GET', '/api/me');
    expect(ended).toEqual({ status: 401, body: { error: 'login-required', reason: 'idle', message: '오래 쉬어서 보안을 위해 다시 로그인해 주세요' } });
    expect((await t.ctx.audit.recent(1))[0]).toMatchObject({ channel: 'auth', action: 'idle', result: 'ended' });
    // 한 번 끊긴 세션은 다시 살아나지 않아요.
    expect((await me.call('GET', '/api/me')).body).toMatchObject({ error: 'login-required' });
  });

  it('알림 폴링만 오는 동안에도 시간은 흘러서 끊겨요', async () => {
    const { t, me } = await setup();
    for (let i = 0; i < 6; i += 1) {
      t.advance(30 * MIN);
      expect((await me.call('GET', '/api/notifications')).status).toBe(200);
    }
    t.advance(1 * MIN);
    expect((await me.call('GET', '/api/notifications')).body).toMatchObject({ reason: 'idle' });
  });

  it('웹이 배경 머리를 붙인 판 새로 고침도 시간을 늘리지 않아요. 사람이 부른 요청은 늘려요', async () => {
    const { t, me } = await setup();
    const bg = { cookie: me.cookie, 'x-desk-background': '1' };
    t.advance(170 * MIN);
    expect((await t.app.inject({ method: 'GET', url: '/api/pantry/board', headers: bg })).statusCode).not.toBe(401);
    t.advance(11 * MIN);
    expect((await t.app.inject({ method: 'GET', url: '/api/pantry/board', headers: bg })).statusCode).toBe(401);

    const again = await t.loginAs(MOCK.staff);
    t.advance(170 * MIN);
    expect((await again.call('GET', '/api/pantry/board')).status).toBe(200);
    t.advance(170 * MIN);
    expect((await again.call('POST', '/api/notifications/read', {})).status).toBe(200);
    t.advance(100 * MIN);
    expect((await again.call('GET', '/api/me')).status).toBe(200);
  });

  it('정규 업무시간(09~18시, 점심 포함) 내내 쉬기만 해도 다시 인증은 3번이에요', async () => {
    const { t } = await setup();
    let logins = 1; // 09:00 첫 로그인
    let me = await t.loginAs(MOCK.staff);
    // 매시간 화면을 보지 않고 알림 폴링만 와요. 끊기면 그 자리에서 다시 로그인해요.
    for (let hour = 1; hour < 9; hour += 1) {
      t.advance(60 * MIN);
      if ((await me.call('GET', '/api/notifications')).status === 401) {
        me = await t.loginAs(MOCK.staff);
        logins += 1;
      }
    }
    expect(logins).toBe(3);
  });

  it('운영 값으로 시간을 바꿔요(5~180분)', async () => {
    const { t, me } = await setup();
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/values', { idleTimeoutMinutes: 10 })).status).toBe(200);
    expect((await op.call('PUT', '/api/ops/values', { idleTimeoutMinutes: 181 })).status).toBe(400);
    t.advance(11 * MIN);
    expect((await me.call('GET', '/api/me')).body).toMatchObject({ reason: 'idle' });
  });
});
