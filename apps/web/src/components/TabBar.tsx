import type { ModuleKind, ModuleSwitch } from '@one-line-desk/shared';
import { Icon, type IconName } from './Icon';

export type Tab = 'home' | 'navi' | 'rooms' | 'notices' | 'board' | 'mine';

// 기능마다 페이지가 따로 있어요. 꺼진 모듈의 탭은 숨겨요(ADR-12, R4).
const TABS: { id: Tab; label: string; icon: IconName; module?: ModuleKind }[] = [
  { id: 'home', label: '홈', icon: 'home' },
  { id: 'navi', label: '담당 찾기', icon: 'navi', module: 'navi' },
  { id: 'rooms', label: '회의실', icon: 'rooms', module: 'rooms' },
  { id: 'notices', label: '공지', icon: 'notices', module: 'notices' },
  { id: 'board', label: '같이 채워요', icon: 'pantry', module: 'pantry' },
  { id: 'mine', label: '내 것', icon: 'mine' },
];

export function visibleTabs(modules: Record<ModuleKind, ModuleSwitch>): Tab[] {
  return TABS.filter((t) => !t.module || modules[t.module] !== 'off').map((t) => t.id);
}

export function TabBar({ current, onChange, modules }: { current: Tab; onChange: (t: Tab) => void; modules: Record<ModuleKind, ModuleSwitch> }) {
  const visible = visibleTabs(modules);
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
