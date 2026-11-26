// @vitest-environment happy-dom
import { CAFE_LIMITS } from '@one-line-desk/shared';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CafeBoard } from './modules/cafe/CafeBoard';
import { CafePage } from './modules/cafe/CafePage';
import { BoardScreen } from './modules/pantry/BoardScreen';
import { cleanup, fakeServer, host, mount, settle, type SentRequest } from './testing/dom';

// 사람이 누르지 않는 반복 요청(폴링)은 배경 요청 머리(x-desk-background)를 붙여서 세션 쉬는 시간을 늘리지 않아요(ADR-20, 11/23 웹 시험 보강).
// 서버 쪽 쉬는 시간 계산은 apps/server/src/core/idle.test.ts가 봐요.

const failing = () => fakeServer(() => ({ status: 500, body: { error: 'error', message: '시험용 실패' } }));
const isBackground = (r: SentRequest) => r.headers['x-desk-background'] === '1';

/** 처음 그린 뒤의 요청만 보려고, 시간을 ms만큼 돌린 뒤 새로 나간 GET을 돌려줘요. */
async function afterPolling(srv: ReturnType<typeof failing>, ms: number): Promise<SentRequest[]> {
  const before = srv.sent.length;
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await settle();
  return srv.sent.slice(before).filter((r) => r.method === 'GET');
}

beforeEach(() => {
  // 반복 타이머만 가짜로 돌려요. 요청이 끝나기를 기다리는 setTimeout은 진짜로 둬요.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
});

describe('폴링은 배경 요청이에요', () => {
  it('카페 판(바리스타, 3초)', async () => {
    const srv = failing();
    await mount(host(<CafeBoard />));
    const polled = await afterPolling(srv, CAFE_LIMITS.boardPollMs);
    expect(polled.map((r) => r.url)).toContain('/api/cafe/board');
    expect(polled.every(isBackground)).toBe(true);
  });

  it('카페 페이지(30초 새로 고침)', async () => {
    const srv = failing();
    await mount(host(<CafePage />));
    const first = srv.sent.find((r) => r.url === '/api/cafe');
    expect(first && isBackground(first)).toBe(false);
    const polled = await afterPolling(srv, 30_000);
    expect(polled.map((r) => r.url)).toContain('/api/cafe');
    expect(polled.every(isBackground)).toBe(true);
  });

  it('같이 채워요 판(15초)', async () => {
    const srv = failing();
    const me = { displayName: '가상 직원', department: '개발팀', floor: '5층', roles: ['employee'], csrfToken: 't' } as const;
    const head = { question: '무엇이 필요해요?', summary: '같이 채워요', placeholder: '예) 3층 A4 용지', submit: '올리기' };
    await mount(host(<BoardScreen me={{ ...me, roles: [...me.roles] }} onOpenOps={() => undefined} onMoveToNavi={() => undefined} head={head} />));
    const polled = await afterPolling(srv, 15_000);
    expect(polled.length).toBeGreaterThan(0);
    expect(polled.every(isBackground)).toBe(true);
  });
});

describe('폴링 규칙(코드 읽기)', () => {
  // 새 화면이 setInterval로 서버를 다시 부르면 background를 같이 적어야 해요. 서버를 부르지 않는 시계·서버가 경로에 표시한 곳만 빼요.
  const EXEMPT: Record<string, string> = {
    './screens/BoardOnly.tsx': '남은 시간 시계만 돌려요(서버를 부르지 않아요)',
    './components/NotificationBell.tsx': '서버 경로가 config: { background: true }예요(apps/server/src/routes/notifications.ts)',
  };
  const sources = import.meta.glob<string>(['./**/*.ts', './**/*.tsx', '!./**/*.test.*', '!./testing/**'], { query: '?raw', import: 'default', eager: true });

  it('setInterval을 쓰는 화면은 배경 요청을 표시해요', () => {
    const bad = Object.entries(sources)
      .filter(([path, code]) => /setInterval\(/.test(code) && !(path in EXEMPT))
      .filter(([, code]) => !/background/.test(code))
      .map(([path]) => path);
    expect(bad).toEqual([]);
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });
});
