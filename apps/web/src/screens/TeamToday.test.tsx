import { TEAM_TODAY_TEXT, type TeamTodayResponse } from '@one-line-desk/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { personText, TeamTodayView, teamTodayLine } from './TeamToday';

// 오늘 우리 팀 한 줄(11/25): 접힌 상태에서는 수만, 펼치면 이름(성 빼고)과 하루/오전/오후·자리비움만 그려요.

const base: TeamTodayResponse = { enabled: true, team: '개발팀', leave: 2, away: 1, small: false, leaveConnected: true };
const view = (o: Partial<Parameters<typeof TeamTodayView>[0]> = {}) =>
  renderToStaticMarkup(<TeamTodayView today={base} people={null} busy={false} error={null} onOpen={() => undefined} onClose={() => undefined} {...o} />);

describe('오늘 우리 팀 한 줄', () => {
  it('접힌 상태에서는 수와 [누구인지 보기]만 있고 이름은 없어요', () => {
    const html = view();
    expect(html).toContain('휴가 2명 · 자리비움 1명');
    expect(html).toContain(TEAM_TODAY_TEXT.open);
    expect(html).toContain(TEAM_TODAY_TEXT.tail);
    expect(html).not.toContain('서준');
  });

  it('펼치면 이름과 하루/오전/오후·자리비움이 보이고 버튼이 [접기]로 바뀌어요', () => {
    const html = view({
      people: [
        { name: '가상 직원 서준', date: '2026-10-26', what: 'leave', part: 'full' },
        { name: '가상 직원 주원', date: '2026-10-26', what: 'away', start: '14:00', end: '18:00', allDay: false, away: 'outside' },
      ],
    });
    expect(html).toContain('서준 · 하루 휴가');
    expect(html).toContain('주원 · 14:00–18:00');
    expect(html).toContain(TEAM_TODAY_TEXT.close);
  });

  it('빠지는 사람이 없으면 그렇다고만 보이고 [누구인지 보기]가 없어요', () => {
    const none = view({ today: { ...base, leave: 0, away: 0 } });
    expect(none).toContain(TEAM_TODAY_TEXT.none);
    expect(none).not.toContain(TEAM_TODAY_TEXT.open);
  });

  it('수 줄과 사람 줄 글', () => {
    expect(teamTodayLine({ leave: 0, away: 3 })).toBe('자리비움 3명');
    expect(personText({ name: 'x', date: '2026-10-26', what: 'leave', part: 'pm' })).toBe('오후 휴가');
  });
});
