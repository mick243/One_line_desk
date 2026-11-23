// @vitest-environment happy-dom
import type { CardAction } from '@one-line-desk/shared';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, cleanup, click, fakeServer, host, mount, openSheet } from '../testing/dom';
import { useActions } from './ActionHost';

// 쓰기는 사람이 확인 시트에서 한 번 누른 뒤에만 나가요(ADR-03, R2). 웹 쪽 지킴이에요. 서버 쪽은 plans 시험이 봐요(11/23 웹 시험 보강).

function Trigger({ action }: { action: CardAction }) {
  const actions = useActions();
  return (
    <button type='button' onClick={() => void actions.run(action)}>
      시작
    </button>
  );
}

const sheet = { title: '예약할까요?', lines: ['가상 회의실 A · 15:00~16:00'], confirmLabel: '예약하기' };

function server() {
  return fakeServer((req) => {
    if (req.url === '/api/plans') return { body: { status: 'sheet', planId: 'p-1', sheet, expiresAt: '2026-11-23T10:00:00+09:00' } };
    if (req.method === 'POST') return { body: { ok: true } };
    return undefined;
  });
}

/** 실제로 무엇을 바꾸는 요청. plan 만들기(/api/plans)는 확인 시트를 받는 것이라 빼요. */
const executed = (srv: ReturnType<typeof server>) => srv.writes().filter((r) => r.url !== '/api/plans');

afterEach(cleanup);

describe('확인 시트(ActionHost)', () => {
  it('propose: plan을 만들어 시트만 띄우고, [확인] 전에는 실행 요청이 0건이에요', async () => {
    const srv = server();
    await mount(host(<Trigger action={{ type: 'propose', text: '예약', proposalToken: 'tok' }} />));
    await click(button('시작'));

    expect(srv.writes().map((r) => r.url)).toEqual(['/api/plans']);
    expect(executed(srv)).toHaveLength(0);
    expect(openSheet()!.textContent).toContain('가상 회의실 A · 15:00~16:00');

    await click(button('예약하기', openSheet()!));
    expect(executed(srv).map((r) => r.url)).toEqual(['/api/plans/p-1/confirm']);
  });

  it('fixed + confirm: 시트를 닫으면 아무 요청도 나가지 않아요', async () => {
    const srv = server();
    const action: CardAction = {
      type: 'fixed',
      text: '취소',
      method: 'POST',
      path: '/api/rooms/reservations/r-1/cancel',
      confirm: { ...sheet, confirmLabel: '취소하기' },
    };
    await mount(host(<Trigger action={action} />));
    await click(button('시작'));
    expect(srv.writes()).toHaveLength(0);

    await click(document.querySelector('.sheet-backdrop')!);
    expect(openSheet()).toBeNull();
    expect(srv.writes()).toHaveLength(0);
  });

  it('fixed + confirm: [확인]을 두 번 눌러도 한 번만 보내요', async () => {
    const srv = server();
    const action: CardAction = {
      type: 'fixed',
      text: '취소',
      method: 'POST',
      path: '/api/rooms/reservations/r-1/cancel',
      confirm: { ...sheet, confirmLabel: '취소하기' },
    };
    await mount(host(<Trigger action={action} />));
    await click(button('시작'));

    // 브라우저처럼 누를 때마다 화면을 다시 그려요. 첫 번째로 버튼이 잠겨서 두 번째는 닿지 않아요.
    const confirm = button('취소하기', openSheet()!);
    await act(async () => confirm.click());
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe('취소하는 중');
    await act(async () => confirm.click());
    await click(document.body);
    expect(srv.writes().map((r) => r.url)).toEqual(['/api/rooms/reservations/r-1/cancel']);
  });
});
