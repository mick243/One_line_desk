// @vitest-environment happy-dom
import { SHEET_DISCARD_TEXT } from '../../components/Sheet';
import { afterEach, describe, expect, it } from 'vitest';
import { button, cleanup, click, fakeServer, host, mount, openSheet, type, wait } from '../../testing/dom';
import { InviteSheet } from './InviteSheet';

// 회의 참석자 고르기(ADR-17). 고른 사람이 있으면 닫기 전에 묻고, [알리기]는 확인 시트 뒤에만 보내요(11/23 웹 시험 보강).

const action = { type: 'invite', text: '참석자 초대', reservationId: 'r-1', roomName: '가상 회의실 A', when: '11월 24일(화) 15:00~16:00' } as const;

function server() {
  return fakeServer((req) => {
    if (req.url === '/api/people/search') return { body: { items: [{ ref: 'p-1', name: '가상 서준', department: '개발팀', floor: '5층' }] } };
    if (req.url === '/api/rooms/reservations/r-1/invites') return { body: { ok: true } };
    return undefined;
  });
}

async function open() {
  let closed = 0;
  await mount(host(<InviteSheet action={action} channels={{ calendar: null, slack: null }} onClose={() => closed++} />));
  return { closed: () => closed };
}

async function pickOne() {
  await type(openSheet()!.querySelector('input.text-input')!, '서준');
  await wait(300);
  await click(button('추가', openSheet()!));
}

const backdrop = () => document.querySelector('.sheet-backdrop')!;

afterEach(cleanup);

describe('참석자 초대 시트', () => {
  it('아무도 고르지 않았으면 바깥을 누를 때 바로 닫혀요', async () => {
    server();
    const sheet = await open();
    await click(backdrop());
    expect(sheet.closed()).toBe(1);
  });

  it('고른 사람이 있으면 바깥을 눌러도 먼저 물어요. [계속 쓰기]면 고른 사람이 그대로예요', async () => {
    const srv = server();
    const sheet = await open();
    await pickOne();
    expect(srv.sent.find((r) => r.url === '/api/people/search')).toMatchObject({ method: 'POST', body: { query: '서준' } });

    await click(backdrop());
    expect(sheet.closed()).toBe(0);
    expect(document.body.textContent).toContain(SHEET_DISCARD_TEXT.ask);

    await click(button(SHEET_DISCARD_TEXT.keep));
    expect(button('가상 서준 ✕')).toBeTruthy();

    await click(backdrop());
    await click(button(SHEET_DISCARD_TEXT.discard));
    expect(sheet.closed()).toBe(1);
  });

  it('[알리기]는 확인 시트를 거쳐야 보내요', async () => {
    const srv = server();
    await open();
    await pickOne();
    await click(button('1명에게 알리기'));
    expect(srv.writes().filter((r) => r.url.endsWith('/invites'))).toHaveLength(0);
    expect(openSheet()!.textContent).toContain('1명에게 알릴까요?');

    await click(button('알리기', openSheet()!));
    expect(srv.writes().filter((r) => r.url.endsWith('/invites'))).toMatchObject([{ body: { people: ['p-1'], calendar: false, slack: false } }]);
  });
});
