// @vitest-environment happy-dom
import type { HomeAskResponse } from '@one-line-desk/shared';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fakeServer, host, mount, settle, type } from '../testing/dom';
import { HomeAsk } from './HomeAsk';

// 홈 AI 채팅(ADR-27). 묻는 글은 POST 본문으로만 가고, 주소·방문 기록·브라우저 저장소에 남지 않아요(R13, ADR-10).
// 규칙 시험([R13], apps/server/src/core/conventions.test.ts)은 코드에 저장소 낱말이 없는지 보고, 이 시험은 실제로 물어본 뒤를 봐요(11/23 웹 시험 보강).

const QUESTION = '다음 주 화요일 출장 일정 뭐 있어?';

const answer: HomeAskResponse = {
  intent: 'mine',
  period: 'this-week',
  kinds: ['reservations'],
  by: 'rule',
  headline: '이번 주 나에게 해당하는 일이 없어요',
  items: [],
  links: [],
  cards: [],
  team: null,
};

afterEach(cleanup);

describe('홈 AI 채팅 원문', () => {
  it('묻는 글은 POST 본문으로만 가고, 주소·방문 기록·브라우저 저장소에는 남지 않아요', async () => {
    const srv = fakeServer((req) => (req.url === '/api/home/ask' ? { body: answer } : undefined));
    await mount(host(<HomeAsk onOpen={() => undefined} />));

    await type(document.querySelector<HTMLInputElement>('input[aria-label="나에게 해당하는 일 찾기"]')!, QUESTION);
    await act(async () => document.querySelector<HTMLFormElement>('form.checked-input')!.requestSubmit());
    await settle();

    const asks = srv.sent.filter((r) => r.url === '/api/home/ask');
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ method: 'POST', body: { text: QUESTION } });
    expect(document.body.textContent).toContain('이번 주 나에게 해당하는 일이 없어요');

    for (const r of srv.sent) {
      expect(r.url).not.toContain(encodeURIComponent(QUESTION));
      expect(r.url).not.toContain(QUESTION);
      expect(JSON.stringify(r.headers)).not.toContain(QUESTION);
    }
    expect(decodeURIComponent(window.location.href)).not.toContain(QUESTION);
    expect(JSON.stringify(window.history.state ?? null)).not.toContain(QUESTION);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain(encodeURIComponent(QUESTION));
  });
});
