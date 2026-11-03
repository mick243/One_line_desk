import type { HomeAskResponse } from '@one-line-desk/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { HOME_TURNS_MAX, HomeAnswer, type HomeTurn, pushTurn } from './HomeAnswer';

// 홈 AI 채팅 "나에게 해당하는 일"(ADR-27). 답 그리기와, 질문 글이 POST 본문으로만 가는지 봐요.
// 브라우저 저장소를 쓰지 않는 것은 규칙 시험(apps/server/src/core/conventions.test.ts [R13])이 웹 코드 전체에서 막아요.

const mine: HomeAskResponse = {
  intent: 'mine',
  period: 'this-week',
  kinds: ['reservations', 'leave'],
  by: 'rule',
  headline: '이번 주 나에게 해당하는 일이 1개 있어요',
  items: [
    {
      id: 'reservations-0',
      kind: 'reservations',
      title: '회의실 예약 · 가상 회의실 A',
      when: '10월 27일(화) 15:00~16:00',
      detail: null,
      open: { text: '회의실에서 보기', to: 'rooms' },
    },
  ],
  links: [{ text: '남은 연차 보기', to: 'navi', handoff: '내 남은 연차 알려 줘', auto: true }],
  cards: [],
  team: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('홈 답 그리기(ADR-27)', () => {
  it('[ADR-27 시험] 내 일 목록과 그 기능 페이지로 가는 버튼만 그려요. 규칙 해석이면 "AI 정리"가 없어요', () => {
    const html = renderToStaticMarkup(<HomeAnswer answer={mine} onOpen={() => undefined} />);
    expect(html).toContain('이번 주 나에게 해당하는 일이 1개 있어요');
    expect(html).toContain('회의실 예약 · 가상 회의실 A');
    expect(html).toContain('10월 27일(화) 15:00~16:00');
    expect(html).toContain('회의실에서 보기');
    expect(html).toContain('남은 연차 보기');
    expect(html).not.toContain('AI 정리');
    expect(html).not.toMatch(/예약하기|신청하기|취소/);
  });

  it('[ADR-27 시험] 실제 모델이 해석했을 때만 "AI 정리"가 붙어요', () => {
    const html = renderToStaticMarkup(<HomeAnswer answer={{ ...mine, by: 'ai' }} onOpen={() => undefined} />);
    expect(html).toContain('AI 정리');
  });

  it('옮기기 답은 한 줄 말풍선 없이 카드 자리만 그려요', () => {
    const move: HomeAskResponse = { ...mine, intent: 'move', items: [], links: [], headline: '회의실에서 찾아볼게요' };
    const html = renderToStaticMarkup(<HomeAnswer answer={move} onOpen={() => undefined} cards={<p>카드 자리</p>} />);
    expect(html).not.toContain('회의실에서 찾아볼게요');
    expect(html).toContain('카드 자리');
  });

  it('[팀 일정 시험] 같은 팀 일정은 이름·날과 휴가(하루/오전/오후)·회의(시간·회의실)·자리비움만 그리고, 버튼·휴가 종류·참석자는 없어요', () => {
    const week: HomeAskResponse = {
      ...mine,
      intent: 'team-schedule',
      kinds: [],
      items: [],
      links: [],
      headline: '이번 주 개발팀 일정 3건이에요',
      team: {
        shown: true,
        team: '개발팀',
        person: null,
        leaveConnected: true,
        entries: [
          { name: '가상 직원 서준', date: '2026-10-27', what: 'leave', part: 'full' },
          { name: '가상 직원 하은', date: '2026-10-28', what: 'meeting', start: '10:00', end: '11:00', room: '가상 회의실 A' },
          { name: '가상 직원 하은', date: '2026-10-28', what: 'away', start: '14:00', end: '18:00', allDay: false, away: 'outside' },
        ],
      },
    };
    const html = renderToStaticMarkup(<HomeAnswer answer={week} onOpen={() => undefined} />);
    expect(html).toContain('이번 주 개발팀 일정 3건이에요');
    expect(html).toContain('10월 27일(화) · 하루 부재');
    expect(html).toContain('10월 28일(수) · 10:00–11:00 회의(가상 회의실 A)');
    expect(html).toContain('10월 28일(수) · 14:00–18:00 외근');
    expect(html).toContain('같은 팀에게만 보여요. 휴가 종류·사유, 회의 참석자는 보이지 않아요');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/연차|병가|공가|참석자:/);

    const refused: HomeAskResponse = {
      ...week,
      headline: '다른 팀의 일정은 볼 수 없어요. 그룹웨어 팀 일정에서 확인해 주세요',
      team: { shown: false, team: '개발팀', person: null, leaveConnected: true, entries: [] },
    };
    const refusedHtml = renderToStaticMarkup(<HomeAnswer answer={refused} onOpen={() => undefined} />);
    expect(refusedHtml).toContain('다른 팀의 일정은 볼 수 없어요');
    expect(refusedHtml).not.toContain('같은 팀에게만 보여요');
  });

  it('대화는 최근 몇 개만, 새 것이 위예요(이 창 메모리)', () => {
    let list: HomeTurn[] = [];
    for (let i = 1; i <= HOME_TURNS_MAX + 2; i += 1) list = pushTurn(list, { id: i, text: `질문 ${i}` });
    expect(list).toHaveLength(HOME_TURNS_MAX);
    expect(list[0]!.id).toBe(HOME_TURNS_MAX + 2);
  });
});

describe('홈 질문 보내기(R13)', () => {
  it('[ADR-10 시험] 질문 글은 POST 본문으로만 가고, 주소에는 남지 않아요', async () => {
    const canary = '홈카나리WEB7';
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(mine), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const result = await api.homeAsk(`이번 주 내 일정 ${canary}`);
    expect(result).toEqual({ status: 'ok', response: mine });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/home/ask');
    expect(calls[0]!.url).not.toContain(canary);
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: `이번 주 내 일정 ${canary}` });
  });

  it('잠긴 질문은 잠김 줄로 돌려줘요', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'locked', message: '잠겼어요', locks: [{ kind: 'key-token', message: '키 같은 글자가 있어요' }] }), {
            status: 422,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    expect(await api.homeAsk('키 AKIA…')).toEqual({ status: 'locked', locks: [{ kind: 'key-token', message: '키 같은 글자가 있어요' }] });
  });
});
