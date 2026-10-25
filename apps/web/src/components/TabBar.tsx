export type Tab = 'ask' | 'board' | 'mine';

const TABS: { id: Tab; label: string }[] = [
  { id: 'ask', label: '묻기' },
  { id: 'board', label: '같이 채워요' },
  { id: 'mine', label: '내 것' },
];

export function TabBar({ current, onChange, hideAsk }: { current: Tab; onChange: (t: Tab) => void; hideAsk: boolean }) {
  return (
    <nav className="tabbar" aria-label="아래 탭">
      {TABS.filter((t) => !(hideAsk && t.id === 'ask')).map((t) => (
        <button key={t.id} type="button" className={t.id === current ? 'tab active' : 'tab'} aria-current={t.id === current ? 'page' : undefined} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
