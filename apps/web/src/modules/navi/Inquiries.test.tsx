// @vitest-environment happy-dom
import type { InquiryItem, InquiryListResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { button, cleanup, click, fakeServer, hasButton, host, mount, type } from '../../testing/dom';
import { InquiryInbox } from './Inquiries';

// 받은 문의함(ADR-16). 한 줄에서 처리해도 다른 줄에 쓰던 답장이 남는지 봐요(11/23 사용성 검토: 다른 줄 처리에 쓰던 글이 사라짐).

const base: InquiryItem = {
  id: '1',
  task: '노트북 교체',
  team: 'IT지원팀',
  question: '노트북이 자주 꺼져요',
  reason: '배터리가 부풀었어요',
  state: 'new',
  createdAt: '2026-11-23T09:00:00+09:00',
  updatedAt: '2026-11-23T09:00:00+09:00',
  sender: { name: '가상 직원', department: '개발팀' },
  actions: [],
  kind: 'general',
  replies: [],
  canReply: true,
};

const items: InquiryItem[] = [
  { ...base, id: '1' },
  {
    ...base,
    id: '2',
    task: '모니터 신청',
    actions: [{ type: 'fixed', text: '확인했어요', method: 'POST', path: '/api/navi/inquiries/2/state', body: { state: 'seen' } }],
  },
];

function server() {
  return fakeServer((req) => {
    if (req.method === 'GET' && req.url === '/api/navi/inquiries/inbox') return { body: { enabled: true, items } satisfies InquiryListResponse };
    if (req.method === 'POST') return { body: { ok: true } };
    return undefined;
  });
}

const row = (task: string) => [...document.querySelectorAll('li')].find((li) => li.querySelector('strong')?.textContent?.includes(task))!;

afterEach(cleanup);

describe('받은 문의함 한 줄 양식', () => {
  it('다른 줄에서 [확인했어요]를 눌러도 쓰던 답장은 그대로예요', async () => {
    const srv = server();
    await mount(host(<InquiryInbox />));

    await click(button('답장하기', row('노트북 교체')));
    await type(row('노트북 교체').querySelector('textarea')!, '내일 새 노트북을 드릴게요');

    await click(button('확인했어요', row('모니터 신청')));
    expect(srv.writes().map((r) => r.url)).toEqual(['/api/navi/inquiries/2/state']);

    const box = row('노트북 교체').querySelector('textarea');
    expect(box?.value).toBe('내일 새 노트북을 드릴게요');
    expect(hasButton('답장 보내기', row('노트북 교체'))).toBe(true);
  });

  it('그 줄에서 답장을 보내면 그 줄 양식만 닫혀요', async () => {
    const srv = server();
    await mount(host(<InquiryInbox />));

    await click(button('답장하기', row('노트북 교체')));
    await type(row('노트북 교체').querySelector('textarea')!, '내일 새 노트북을 드릴게요');
    await click(button('답장하기', row('모니터 신청')));
    await type(row('모니터 신청').querySelector('textarea')!, '이번 주 안에 보내 드려요');

    await click(button('답장 보내기', row('노트북 교체')));
    const reply = srv.writes().at(-1)!;
    expect(reply.url).toBe('/api/navi/inquiries/1/reply');
    expect(reply.body).toMatchObject({ text: '내일 새 노트북을 드릴게요' });

    expect(row('노트북 교체').querySelector('textarea')).toBeNull();
    expect(row('모니터 신청').querySelector('textarea')?.value).toBe('이번 주 안에 보내 드려요');
  });
});
