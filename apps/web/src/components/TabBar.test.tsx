import { DEFAULT_OPS_SETTINGS, type ModuleKind, type ModuleSwitch } from '@one-line-desk/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isBaristaMenu, TabBar, visibleTabs } from './TabBar';

// 탭 목록(PC 왼쪽 메뉴·모바일 아래 탭이 같이 써요). 사내 카페(11/6, ADR-29)와 바리스타 메뉴.

const modules = (cafeteria: ModuleSwitch, more: Partial<Record<ModuleKind, ModuleSwitch>> = {}) => ({ ...DEFAULT_OPS_SETTINGS.modules, cafeteria, ...more });
const BARISTA = ['employee', 'cafe'] as const;
const STAFF = ['employee'] as const;

describe('탭 목록과 바리스타 메뉴', () => {
  it('[F4 완료 기준] 바리스타이고 카페가 켜져 있으면 메뉴는 홈(= 카페 판)·문의함·같이 채워요·마이 페이지 넷이에요', () => {
    expect(isBaristaMenu(modules('on'), BARISTA)).toBe(true);
    expect(visibleTabs(modules('on'), BARISTA)).toEqual(['home', 'navi', 'board', 'mine']);
    // 바리스타 메뉴에서도 꺼진 모듈 탭은 지금처럼 숨어요.
    expect(visibleTabs(modules('on', { pantry: 'off' }), BARISTA)).toEqual(['home', 'navi', 'mine']);
  });

  it('카페가 켬이 아니면(끔·링크만) 바리스타도 일반 직원과 같은 메뉴예요', () => {
    for (const cafe of ['off', 'link'] as const) {
      expect(isBaristaMenu(modules(cafe), BARISTA)).toBe(false);
      expect(visibleTabs(modules(cafe), BARISTA)).toEqual(visibleTabs(modules(cafe), STAFF));
    }
  });

  it('일반 직원은 카페가 끔(출시 기본)이면 카페 탭이 없고, 켬·링크만이면 같이 채워요 뒤·마이 페이지 앞에 카페 탭이 보여요', () => {
    expect(DEFAULT_OPS_SETTINGS.modules.cafeteria).toBe('off');
    expect(visibleTabs(DEFAULT_OPS_SETTINGS.modules, STAFF)).toEqual(['home', 'navi', 'rooms', 'notices', 'board', 'mine']);
    expect(visibleTabs(modules('on'), STAFF)).toEqual(['home', 'navi', 'rooms', 'notices', 'board', 'cafe', 'mine']);
    expect(visibleTabs(modules('link'), STAFF)).toEqual(['home', 'navi', 'rooms', 'notices', 'board', 'cafe', 'mine']);
    expect(visibleTabs(modules('on'))).toEqual(visibleTabs(modules('on'), STAFF));
  });

  it('탭 막대는 같은 목록을 그려요(바리스타는 회의실·공지·카페 탭이 없어요)', () => {
    const barista = renderToStaticMarkup(<TabBar current='home' onChange={() => undefined} modules={modules('on')} roles={BARISTA} />);
    for (const label of ['홈', '문의함', '같이 채워요', '마이 페이지']) expect(barista).toContain(label);
    for (const label of ['회의실', '공지', '카페']) expect(barista).not.toContain(`</svg>${label}<`);
    const staff = renderToStaticMarkup(<TabBar current='cafe' onChange={() => undefined} modules={modules('on')} roles={STAFF} />);
    expect(staff).toContain('</svg>카페</button>');
    expect(staff).toContain('aria-current="page"');
  });
});
