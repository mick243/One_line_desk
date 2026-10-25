import { useCallback, useEffect, useState } from 'react';
import { api, type Me, type PublicConfig } from './api';
import { DemoBand } from './components/DemoBand';
import { TabBar, type Tab } from './components/TabBar';
import { Ask } from './screens/Ask';
import { Board } from './screens/Board';
import { Login } from './screens/Login';
import { Mine } from './screens/Mine';

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('ask');
  const [offline, setOffline] = useState(false);

  const refreshMe = useCallback(async () => setMe(await api.me()), []);

  const load = useCallback(async () => {
    setOffline(false);
    try {
      setConfig(await api.publicConfig());
      await refreshMe();
    } catch {
      setOffline(true);
    }
  }, [refreshMe]);

  useEffect(() => {
    void load();
  }, [load]);

  // "같이 채워요 단독" 모드에서는 묻기 탭을 숨기고 같이 채워요가 첫 화면이에요.
  const standalone = config?.standalone ?? false;
  const current: Tab = standalone && tab === 'ask' ? 'board' : tab;

  if (offline) {
    return (
      <div className="loading">
        <p>서버에 연결하지 못했어요.</p>
        <button type="button" className="secondary small" onClick={() => void load()}>
          다시 시도
        </button>
      </div>
    );
  }
  if (me === undefined || !config) return <div className="loading">불러오는 중…</div>;

  return (
    <div className="app">
      <DemoBand items={config.demoData} />
      {me === null ? (
        <Login onLoggedIn={refreshMe} />
      ) : (
        <>
          <main className="screen">
            {current === 'ask' && <Ask onShowRetention={() => setTab('mine')} />}
            {current === 'board' && <Board me={me} />}
            {current === 'mine' && <Mine me={me} onLoggedOut={() => setMe(null)} />}
          </main>
          <TabBar current={current} onChange={setTab} hideAsk={standalone} />
        </>
      )}
    </div>
  );
}
