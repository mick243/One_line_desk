import type { ModuleKind, ModuleSwitch, Role } from '@one-line-desk/shared';
import { Icon, type IconName } from './Icon';

export type Tab = 'home' | 'navi' | 'rooms' | 'notices' | 'board' | 'cafe' | 'mine';

// 기능마다 페이지가 따로 있어요. 꺼진 모듈의 탭은 숨겨요(ADR-12, R4).
// 카페(11/6, ADR-29): 같이 채워요 뒤·마이 페이지 앞이에요. 카페가 꺼져 있으면 숨어요.
const TABS: { id: Tab; label: string; icon: IconName; module?: ModuleKind }[] = [
  { id: 'home', label: '홈', icon: 'home' },
  { id: 'navi', label: '문의함', icon: 'navi', module: 'navi' },
  { id: 'rooms', label: '회의실', icon: 'rooms', module: 'rooms' },
  { id: 'notices', label: '공지', icon: 'notices', module: 'notices' },
  { id: 'board', label: '같이 채워요', icon: 'pantry', module: 'pantry' },
  { id: 'cafe', label: '카페', icon: 'cafe', module: 'cafeteria' },
  { id: 'mine', label: '마이 페이지', icon: 'mine' },
];

/**
 * 바리스타 메뉴(11/6 사용자 결정, ADR-29): 등록된 바리스타(역할 cafe)이고 카페가 켜져 있으면 홈(= 카페 판)·문의함·같이 채워요·마이 페이지 넷이에요.
 * 회의실·공지·카페 탭은 숨겨요. 카페가 켬이 아니면 바리스타도 다른 직원과 같은 메뉴예요.
 */
const BARISTA_TABS: readonly Tab[] = ['home', 'navi', 'board', 'mine'];

/** 바리스타 메뉴로 그리는지. 이때 홈은 카페 판이에요. */
export function isBaristaMenu(modules: Record<ModuleKind, ModuleSwitch>, roles: readonly Role[] = []): boolean {
  return roles.includes('cafe') && modules.cafeteria === 'on';
}

/** 탭 이름(앱 바의 "지금 있는 곳" 표시가 같이 써요). */
export function tabLabel(id: Tab): string {
  return TABS.find((t) => t.id === id)?.label ?? '';
}

/** PC 왼쪽 메뉴와 모바일 아래 탭이 같이 쓰는 목록이에요. */
export function visibleTabs(modules: Record<ModuleKind, ModuleSwitch>, roles: readonly Role[] = []): Tab[] {
  const barista = isBaristaMenu(modules, roles);
  return TABS.filter((t) => (!barista || BARISTA_TABS.includes(t.id)) && (!t.module || modules[t.module] !== 'off')).map((t) => t.id);
}

export function TabBar({
  current,
  onChange,
  modules,
  roles,
}: {
  current: Tab;
  onChange: (t: Tab) => void;
  modules: Record<ModuleKind, ModuleSwitch>;
  roles?: readonly Role[];
}) {
  const visible = visibleTabs(modules, roles);
  return (
    <nav className='tabbar' aria-label='아래 탭'>
      {TABS.filter((t) => visible.includes(t.id)).map((t) => (
        <button
          key={t.id}
          type='button'
          className={t.id === current ? 'tab active' : 'tab'}
          aria-current={t.id === current ? 'page' : undefined}
          onClick={() => onChange(t.id)}
        >
          <Icon name={t.icon} />
          {t.label}
        </button>
      ))}
    </nav>
  );
}
