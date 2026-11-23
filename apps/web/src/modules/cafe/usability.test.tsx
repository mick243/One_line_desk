// @vitest-environment happy-dom
import { CAFE_TEXT, type CafeBoardResponse, type CafeResponse } from '@one-line-desk/shared';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { button, cleanup, click, fakeServer, hasButton, host, mount, openSheet, settle } from '../../testing/dom';
import { CAFE_UNDO_MS, CafeBoard } from './CafeBoard';
import { CafePage } from './CafePage';

// 카페 사용성 보강(11/23): [주문하기]가 꺼진 까닭, 바리스타 상태 버튼 [되돌리기], [영업 끝] 확인.

const page: CafeResponse = {
  status: 'on',
  open: true,
  menu: [{ id: 'americano', name: '아메리카노', priceWon: 1500, options: [], soldOut: false }],
  slots: [{ start: '2026-11-23T14:10:00+09:00', label: '14:10', left: 5, full: false }],
  orders: [],
  monthTotalWon: 0,
  billing: { limitWon: 500000, leftWon: 500000, blocked: false, bills: [], account: '', dueDays: 7, request: null },
};

const board: CafeBoardResponse = {
  open: true,
  orders: [{ id: '7', pickupNo: 3, lines: [{ name: '아메리카노', options: [], qty: 1 }], pickupLabel: '09:10–09:20', status: 'making', orderedAt: '09:01' }],
  menu: [{ id: 'americano', name: '아메리카노', soldOut: false }],
};

afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
});

describe('[주문하기]가 꺼진 까닭', () => {
  it('메뉴·시간을 고르지 않았으면 버튼 아래에 빠진 것을 한 줄로 알려요', async () => {
    fakeServer((req) => (req.url === '/api/cafe' ? { body: page } : undefined));
    const el = await mount(host(<CafePage />));
    expect(button('주문하기').disabled).toBe(true);
    expect(el.textContent).toContain(CAFE_TEXT.pickBoth);

    await click(el.querySelector('[aria-label="아메리카노 한 잔 더하기"]')!);
    expect(el.textContent).toContain(CAFE_TEXT.pickSlot);

    await click(button('14:10'));
    expect(el.textContent).not.toContain(CAFE_TEXT.pickSlot);
    expect(button('주문하기').disabled).toBe(false);
  });
});

describe('카페 판(바리스타)', () => {
  function server() {
    return fakeServer((req) => {
      if (req.url === '/api/cafe/board') return { body: board };
      if (req.method === 'POST') return { body: { ok: true } };
      return undefined;
    });
  }
  const statusWrites = (srv: ReturnType<typeof server>) => srv.writes().filter((r) => r.url.includes('/status'));

  it('상태 버튼은 바로 보내지 않고, [되돌리기]를 누르면 아무것도 보내지 않아요', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const srv = server();
    await mount(<CafeBoard />);
    await click(button('다 됐어요'));
    expect(statusWrites(srv)).toHaveLength(0);
    expect(hasButton('되돌리기')).toBe(true);

    await click(button('되돌리기'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, CAFE_UNDO_MS + 200));
    });
    await settle();
    expect(statusWrites(srv)).toHaveLength(0);
    expect(hasButton('다 됐어요')).toBe(true);
  });

  it('되돌리지 않으면 잠시 뒤 한 번 보내요', async () => {
    const srv = server();
    await mount(<CafeBoard />);
    await click(button('다 됐어요'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, CAFE_UNDO_MS + 200));
    });
    await settle();
    expect(statusWrites(srv).map((r) => [r.url, r.body])).toEqual([['/api/cafe/orders/7/status', { to: 'ready' }]]);
  }, 15_000);

  it('[영업 끝]은 확인 시트를 거쳐서만 닫아요', async () => {
    const srv = server();
    await mount(<CafeBoard />);
    await click(button('영업 끝'));
    expect(srv.writes()).toHaveLength(0);
    expect(openSheet()!.textContent).toContain(CAFE_TEXT.closeLine);

    await click(document.querySelector('.sheet-backdrop')!);
    expect(srv.writes()).toHaveLength(0);

    await click(button('영업 끝'));
    await click(button('영업 끝내기', openSheet()!));
    expect(srv.writes().map((r) => r.url)).toEqual(['/api/cafe/board/close']);
  });
});
