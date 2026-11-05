import { describe, expect, it } from 'vitest';
import { homeReadLabel, sameHomeRead } from './home';

// 알아들은 것 라벨(11/5 시험, AI 보완 2번). 해석 값만 말로 바꾸고 질문 글은 없어요.

describe('홈 "알아들은 것" 라벨', () => {
  it('뜻마다 짧은 한 줄이에요', () => {
    expect(homeReadLabel({ intent: 'mine', period: 'this-week', kinds: ['reservations', 'invites'], moveTo: null })).toBe(
      '이번 주 · 내 일(내 예약·초대받은 회의)',
    );
    expect(homeReadLabel({ intent: 'mine', period: 'recent', kinds: [], moveTo: null })).toBe('요즘 · 내 일(전부)');
    expect(homeReadLabel({ intent: 'move', period: 'recent', kinds: [], moveTo: 'board' })).toBe('하려는 일 · 같이 채워요에서 해요');
    expect(homeReadLabel({ intent: 'team-schedule', period: 'today', kinds: [], moveTo: null })).toBe('오늘 · 같은 팀 일정');
    expect(homeReadLabel({ intent: 'unknown', period: 'recent', kinds: [], moveTo: null })).toBe('모르는 말');
  });

  it('종류 순서만 다르면 같은 해석이에요', () => {
    const a = { intent: 'mine', period: 'today', kinds: ['leave', 'reservations'], moveTo: null } as const;
    const b = { intent: 'mine', period: 'today', kinds: ['reservations', 'leave'], moveTo: null } as const;
    expect(sameHomeRead(a, b)).toBe(true);
    expect(sameHomeRead(a, { ...b, period: 'tomorrow' })).toBe(false);
  });
});
