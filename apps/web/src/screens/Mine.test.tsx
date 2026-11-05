import { DEFAULT_OPS_SETTINGS, mineMovedNote } from '@one-line-desk/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Me } from '../api';
import { ActionHost } from '../components/ActionHost';
import { Mine } from './Mine';

// 11/5 사용자 결정(ADR-27 보강): 홈 채팅이 켜져 있으면 마이 페이지의 내 예약·내 요청·나에게 온 요청·자리비움 칸을 빼고 안내만 둬요.
const me = { displayName: '가상 직원 하늘', department: '재무팀', floor: '3층', roles: ['employee'] } as unknown as Me;
const base = { modules: DEFAULT_OPS_SETTINGS.modules, roomsWrite: true, mcp: false, teamSchedule: true };
const draw = (switches: typeof base & { homeAsk: boolean }) =>
  renderToStaticMarkup(
    <ActionHost onNavigate={() => undefined} inviteChannels={{ calendar: null, slack: null }}>
      <Mine me={me} switches={switches} onLoggedOut={() => undefined} onOpen={() => undefined} />
    </ActionHost>,
  );

describe('마이 페이지(11/5)', () => {
  it('홈 채팅이 켜져 있으면 옮긴 칸 대신 안내 문구와 홈 채팅 바로 찾기 버튼을 그려요', () => {
    const html = draw({ ...base, homeAsk: true });
    expect(html).toContain(mineMovedNote(true));
    for (const t of ['내 예약 보기', '내 요청 보기', '나에게 온 요청 보기', '자리비움 알리기']) expect(html).toContain(t);
    expect(html).not.toContain('aria-label="자리비움 알리기"');
  });

  it('같은 팀 일정이 꺼져 있으면 자리비움 버튼은 없어요', () => {
    const html = draw({ ...base, teamSchedule: false, homeAsk: true });
    expect(html).toContain('내 예약 보기');
    expect(html).toContain(mineMovedNote(false));
    expect(html).not.toContain('자리비움 알리기');
  });

  it('홈 채팅을 끈 회사는 안내 없이 칸을 그대로 둬요(갈 곳이 없어지지 않게)', () => {
    const html = draw({ ...base, homeAsk: false });
    expect(html).not.toContain('홈 채팅에서 해요');
  });
});
