import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit';
import { SESSION_MAX_AGE_MS, SessionStore } from './session';

// 보관 회차가 한 시간마다 부르는 메모리 정리(sweep). 같은 쿠키·같은 동작이 다시 오지 않아도 지워져요.

const MIN = 60_000;

describe('세션 정리', () => {
  it('8시간 최대 수명이 지난 세션만 지우고, 쉬는 시간을 넘긴 세션은 돌아왔을 때 안내하도록 남겨요', () => {
    let now = 1_000_000;
    const store = new SessionStore(() => now);
    const old = store.create('sub-old', 'p-old');
    now += 2 * 60 * MIN;
    const resting = store.create('sub-rest', 'p-rest');
    now += 60 * MIN;
    const active = store.create('sub-active', 'p-active');
    // old는 사람이 계속 써서 쉬지 않았어요.
    old.lastActiveAt = now;

    now = old.createdAt + SESSION_MAX_AGE_MS + 1;
    active.lastActiveAt = now - 10 * MIN;
    // resting은 5시간 넘게 쉬었지만 8시간은 안 지났어요.
    expect(store.sweep(now)).toBe(1);
    expect(store.size).toBe(2);
    expect(store.get(active.id)).toBe(active);
    void resting;
  });

  it('8시간 경계와 같으면 남겨요(get()과 같은 기준)', () => {
    let now = 0;
    const store = new SessionStore(() => now);
    store.create('sub', 'p');
    now = SESSION_MAX_AGE_MS;
    expect(store.sweep(now)).toBe(0);
    expect(store.sweep(now + 1)).toBe(1);
    expect(store.size).toBe(0);
  });
});

describe('횟수 정리', () => {
  it('1분 창이 지난 횟수만 지우고, 지운 뒤에는 처음부터 세요', () => {
    let now = 0;
    const limiter = new RateLimiter(
      () => now,
      () => 2,
    );
    limiter.hit('p1', 'ask');
    limiter.hit('p1', 'ask');
    now = 30_000;
    limiter.hit('p2', 'ask');
    now = 60_000;
    expect(limiter.sweep(now)).toBe(1);
    expect(limiter.size).toBe(1);
    // p2 창은 아직 1분이 안 지나 남아 있어요.
    limiter.hit('p2', 'ask');
    expect(limiter.hit('p2', 'ask')).toBe(false);
    expect(limiter.hit('p1', 'ask')).toBe(true);
  });
});
