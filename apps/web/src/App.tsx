import type { AppDestination } from '@one-line-desk/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type Me, type PublicConfig } from './api';
import { ActionHost } from './components/ActionHost';
import { DemoBand } from './components/DemoBand';
import { TabBar, type Tab } from './components/TabBar';
import { webModules } from './modules/registry';
import { Ask } from './screens/Ask';
import { Login } from './screens/Login';
import { Mine } from './screens/Mine';

type View = Tab | 'ops' | 'chart';

/** 바깥에서 들어오는 길(M3·M4): 연결 동의 시트, 앱 확인 링크. 로그인 뒤에 열려요. */
function entryFromPath(): { kind: 'consent' } | { kind: 'link'; token: string } | null {
  const path = window.location.pathname;
  if (path.startsWith('/oauth/consent')) return { kind: 'consent' };
  const link = path.match(/^\/r\/([A-Za-z0-9_.-]+)$/);
  return link ? { kind: 'link', token: link[1]! } : null;
}

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<View>('ask');
  const [entry, setEntry] = useState(entryFromPath);
  const [offline, setOffline] = useState(false);
  // 판에서 [묻기로 옮기기]로 넘어온 글. 앱 메모리에만 둬요(F3-4, R13).
  const [handoff, setHandoff] = useState('');

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

  const navigate = useCallback((to: AppDestination) => {
    setEntry(null);
    window.history.replaceState(null, '', '/');
    setView(to);
  }, []);

  if (offline) {
    return (
      <div className='loading'>
        <p>서버에 연결하지 못했어요.</p>
        <button type='button' className='secondary small' onClick={() => void load()}>
          다시 시도
        </button>
      </div>
    );
  }
  if (me === undefined || !config) return <div className='loading'>불러오는 중…</div>;

  // "같이 채워요 단독" 모드에서는 묻기 탭을 숨기고 같이 채워요가 첫 화면이에요.
  const current: View = config.standalone && view === 'ask' ? 'board' : view;
  const tab: Tab = current === 'ops' ? 'board' : current === 'chart' ? 'mine' : current;
  const { BoardScreen, OpsScreen, ChartScreen, ConsentScreen, LinkEntry } = webModules;

  return (
    <div className='app'>
      <DemoBand items={config.demoData} />
      {me === null ? (
        <Login onLoggedIn={refreshMe} />
      ) : (
        <ActionHost onNavigate={navigate}>
          <main className='screen'>
            {entry?.kind === 'consent' && <ConsentScreen me={me} />}
            {entry?.kind === 'link' && <LinkEntry me={me} token={entry.token} />}
            {!entry && current === 'ask' && <Ask modules={config.modules} initialText={handoff} onShowRetention={() => setView('mine')} />}
            {!entry && current === 'board' && (
              <BoardScreen
                me={me}
                onOpenOps={() => setView('ops')}
                onMoveToAsk={(text) => {
                  setHandoff(text);
                  setView('ask');
                }}
              />
            )}
            {!entry && current === 'ops' && <OpsScreen me={me} />}
            {!entry && current === 'chart' && <ChartScreen me={me} />}
            {!entry && current === 'mine' && <Mine me={me} modules={config.modules} onLoggedOut={() => setMe(null)} onOpen={setView} />}
          </main>
          <TabBar current={tab} onChange={(t) => navigate(t)} hideAsk={config.standalone} />
        </ActionHost>
      )}
    </div>
  );
}
