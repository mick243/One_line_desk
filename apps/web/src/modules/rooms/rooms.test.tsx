// @vitest-environment happy-dom
import type { MyReservationsResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionHost } from '../../components/ActionHost';
import { button, cleanup, click, fakeServer, hasButton, mount, openSheet } from '../../testing/dom';
import { MyReservations } from './index';
import { InviteSheet } from './InviteSheet';

// 회의실 "내 예약" 칸(F2, ADR-03·17). 그려지는지와 버튼 흐름을 봐요(11/23 웹 시험 보강).

const list: MyReservationsResponse = {
  enabled: true,
  items: [
    {
      id: 'r-1',
      roomName: '가상 회의실 A',
      floor: '5층',
      start: '2026-11-24T15:00:00+09:00',
      end: '2026-11-24T16:00:00+09:00',
      when: '11월 24일(화) 15:00~16:00',
      cancel: {
        type: 'fixed',
        text: '취소',
        method: 'DELETE',
        path: '/api/rooms/reservations/r-1',
        confirm: { title: '예약을 취소할까요?', lines: ['가상 회의실 A · 11월 24일(화) 15:00~16:00'], confirmLabel: '취소하기' },
      },
      invite: { type: 'invite', text: '참석자 초대', reservationId: 'r-1', roomName: '가상 회의실 A', when: '11월 24일(화) 15:00~16:00' },
      attendees: [{ name: '가상 서준', response: 'declined', reason: '외근이에요' }],
      icsPath: '/api/rooms/reservations/r-1/ics',
      loans: ['빔프로젝터'],
    },
  ] as MyReservationsResponse['items'],
};

const page = (compact = false) => (
  <ActionHost onNavigate={() => undefined} inviteChannels={{ calendar: null, slack: null }} InviteSheet={InviteSheet}>
    <MyReservations compact={compact} />
  </ActionHost>
);

afterEach(cleanup);

describe('내 예약', () => {
  it('회의실·시간·빌린 장비·부른 사람 답과 버튼을 그려요', async () => {
    fakeServer((req) => (req.url === '/api/rooms/my-reservations' ? { body: list } : undefined));
    const el = await mount(page());
    expect(el.textContent).toContain('가상 회의실 A · 5층');
    expect(el.textContent).toContain('11월 24일(화) 15:00~16:00 · 내 예약');
    expect(el.textContent).toContain('같이 빌린 장비: 빔프로젝터');
    expect(el.textContent).toContain('서준 못 가는 사유: 외근이에요');
    for (const b of ['참석자 초대', '취소']) expect(hasButton(b, el)).toBe(true);
    expect(el.querySelector('a[download]')?.getAttribute('href')).toBe('/api/rooms/reservations/r-1/ics');
  });

  it('[취소]는 확인 시트를 거쳐서만 지우고, 지운 뒤 목록을 다시 불러요', async () => {
    const srv = fakeServer((req) => {
      if (req.url === '/api/rooms/my-reservations') return { body: list };
      if (req.method === 'DELETE') return { body: { ok: true } };
      return undefined;
    });
    await mount(page());
    await click(button('취소'));
    expect(srv.writes()).toHaveLength(0);
    expect(openSheet()!.textContent).toContain('예약을 취소할까요?');

    await click(button('취소하기', openSheet()!));
    expect(srv.writes().map((r) => [r.method, r.url])).toEqual([['DELETE', '/api/rooms/reservations/r-1']]);
    expect(srv.sent.filter((r) => r.url === '/api/rooms/my-reservations')).toHaveLength(2);
  });

  it('[참석자 초대]는 고르기 시트를 열기만 해요', async () => {
    const srv = fakeServer((req) => (req.url === '/api/rooms/my-reservations' ? { body: list } : undefined));
    await mount(page());
    await click(button('참석자 초대'));
    expect(openSheet()!.getAttribute('aria-label')).toBe('참석자 초대');
    expect(srv.writes()).toHaveLength(0);
  });

  it('홈 짧은 목록은 [취소]만 두고, 불러오지 못하면 [다시 불러오기]가 있어요', async () => {
    let fail = true;
    fakeServer((req) => (req.url === '/api/rooms/my-reservations' ? (fail ? { status: 500, body: { error: 'error' } } : { body: list }) : undefined));
    const el = await mount(page(true));
    expect(el.textContent).toContain('내 예약을 불러오지 못했어요.');

    fail = false;
    await click(button('다시 불러오기'));
    expect(el.textContent).toContain('가상 회의실 A');
    expect(hasButton('취소', el)).toBe(true);
    expect(hasButton('참석자 초대', el)).toBe(false);
  });

  it('회의실이 꺼져 있으면 칸을 그리지 않아요', async () => {
    fakeServer((req) => (req.url === '/api/rooms/my-reservations' ? { body: { enabled: false, items: [] } } : undefined));
    const el = await mount(page());
    expect(el.textContent).toBe('');
  });
});
