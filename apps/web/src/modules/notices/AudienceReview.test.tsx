// @vitest-environment happy-dom
import type { NoticeAudienceItem, NoticeAudienceListResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { button, cleanup, click, fakeServer, mount, openSheet, host } from '../../testing/dom';
import { NoticeAudienceReview } from './AudienceReview';

// 새 공지 알림 대상 확인(총무, ADR-09 개정). [알리기]는 확인 시트 뒤에만 보내고, 칩 고치기는 다른 공지를 처리해도 남아요(11/23 웹 시험 보강).

const base: NoticeAudienceItem = {
  id: '7',
  notice: { id: 'GB-1', title: '개발팀 노트북 보안 점검 안내', postedOn: '2026-11-06', url: 'https://groupware.example.com/7', board: '전사 공지' },
  audience: { everyone: false, departments: ['개발팀'], floors: [], roles: [] },
  count: 6,
  evidence: ['개발팀은'],
  byModel: true,
  state: 'pending',
  auto: false,
  createdAt: '11월 6일(금) 10:02',
};

const list: NoticeAudienceListResponse = {
  items: [
    base,
    { ...base, id: '8', notice: { ...base.notice, id: 'GB-2', title: '5층 소독 안내' }, audience: { ...base.audience, departments: [], floors: ['5층'] } },
  ],
  options: { departments: ['개발팀', '재무팀'], floors: ['3층', '5층'], roles: [{ code: 'team-lead', label: '팀장' }] },
  autoSend: false,
};

function server() {
  return fakeServer((req) => {
    if (req.method === 'GET' && req.url === '/api/notices/audience') return { body: list };
    if (req.url === '/api/notices/audience/count') return { body: { count: 9 } };
    if (req.method === 'POST' && req.url.endsWith('/send')) return { body: { ok: true } };
    return undefined;
  });
}

const item = (title: string) => document.querySelector<HTMLElement>(`[aria-label="공지 제안 ${title}"]`)!;
const sends = (srv: ReturnType<typeof server>) => srv.writes().filter((r) => r.url.endsWith('/send'));

afterEach(cleanup);

describe('새 공지 알림 대상 확인', () => {
  it('[알리기]는 확인 시트를 먼저 띄우고, 시트에서 누를 때만 보내요', async () => {
    const srv = server();
    await mount(host(<NoticeAudienceReview />));

    await click(button('알리기', item('개발팀 노트북 보안 점검 안내')));
    expect(sends(srv)).toHaveLength(0);
    const sheet = openSheet()!;
    expect(sheet.textContent).toContain('대상: 개발팀 · 6명');

    await click(button('알리기', sheet));
    expect(sends(srv).map((r) => [r.url, r.body])).toEqual([['/api/notices/audience/7/send', {}]]);
  });

  it('칩을 고치면 수를 다시 세고, 고친 대상을 함께 보내요', async () => {
    const srv = server();
    await mount(host(<NoticeAudienceReview />));
    const card = item('개발팀 노트북 보안 점검 안내');

    await click(button('대상 바꾸기', card));
    await click(button('재무팀', card));
    expect(srv.sent.at(-1)).toMatchObject({ url: '/api/notices/audience/count', body: { audience: { departments: ['개발팀', '재무팀'] } } });
    expect(card.textContent).toContain('9명 · 이름은 보이지 않아요');

    await click(button('알리기', card));
    await click(button('알리기', openSheet()!));
    expect(sends(srv)[0]!.body).toEqual({ audience: { everyone: false, departments: ['개발팀', '재무팀'], floors: [], roles: [] } });
  });

  it('다른 공지를 알려도 고치던 칩은 그대로예요', async () => {
    const srv = server();
    await mount(host(<NoticeAudienceReview />));
    const editing = item('개발팀 노트북 보안 점검 안내');

    await click(button('대상 바꾸기', editing));
    await click(button('재무팀', editing));

    await click(button('알리기', item('5층 소독 안내')));
    await click(button('알리기', openSheet()!));
    expect(sends(srv).map((r) => r.url)).toEqual(['/api/notices/audience/8/send']);

    const still = item('개발팀 노트북 보안 점검 안내');
    expect(button('재무팀', still).getAttribute('aria-pressed')).toBe('true');
    expect(still.textContent).toContain('제안대로 돌리기');
  });
});
