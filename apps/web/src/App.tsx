import type { AppDestination, Kind } from '@one-line-desk/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type Me, type PublicConfig } from './api';
import { ActionHost } from './components/ActionHost';
import { DemoBand } from './components/DemoBand';
import { NotificationBell } from './components/NotificationBell';
import { TabBar, type Tab, visibleTabs } from './components/TabBar';
import { webModules } from './modules/registry';
import { FEATURES, pageOfKind } from './screens/features';
import { FeaturePage } from './screens/FeaturePage';
import { Home } from './screens/Home';
import { Login } from './screens/Login';
import { Mine } from './screens/Mine';

type View = AppDestination;

/** 바깥에서 들어오는 길(M3·M4): 연결 동의 시트, 앱 확인 링크. 로그인 뒤에 열려요. */
function entryFromPath(): { kind: 'consent' } | { kind: 'link'; token: string } | null {
  const path = window.location.pathname;
  if (path.startsWith('/oauth/consent')) return { kind: 'consent' };
  const link = path.match(/^\/r\/([A-Za-z0-9_.-]+)$/);
  return link ? { kind: 'link', token: link[1]! } : null;
}

/** 운영(S4)은 같이 채워요 탭, 분장표 수정 제안함(S5)은 담당 찾기 탭 아래에 있어요. */
function tabOf(view: View): Tab {
  if (view === 'ops') return 'board';
  if (view === 'chart') return 'navi';
  return view;
}

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<View>('home');
  const [entry, setEntry] = useState(entryFromPath);
  const [offline, setOffline] = useState(false);
  // 다른 페이지로 옮겨 가는 문장(예시 문장, "종류가 달라요", [담당 찾기로 옮기기]). 앱 메모리에만 둬요(R13).
  // auto: 다른 기능에서 옮겨 온 문장이면 그 페이지에서 바로 찾아요. 홈 예시 문장은 채우기만 해요.
  const [handoff, setHandoff] = useState<{ to: View; text: string; at: number; auto: boolean } | null>(null);

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

  const go = useCallback((to: View, text?: string, auto = false) => {
    setEntry(null);
    window.history.replaceState(null, '', '/');
    setHandoff(text ? { to, text, at: Date.now(), auto } : null);
    setView(to);
    // 다른 페이지로 가면 맨 위부터 보여요.
    window.scrollTo(0, 0);
  }, []);
  const navigate = useCallback((to: AppDestination) => go(to), [go]);
  const move = useCallback((kind: Kind, text: string) => go(pageOfKind(kind), text, true), [go]);

  if (offline) {
    return (
      <div className='loading'>
        <p>지금 서버에 연결할 수 없어요.</p>
        <button type='button' className='secondary small' onClick={() => void load()}>
          다시 연결하기
        </button>
      </div>
    );
  }
  if (me === undefined || !config) return <div className='loading'>불러오는 중…</div>;

  // 꺼진 모듈의 페이지에 있으면 홈으로 돌려요(ADR-12).
  const tabs = visibleTabs(config.modules);
  const current: View = tabs.includes(tabOf(view)) ? view : 'home';
  const initial = handoff?.to === current ? handoff.text : '';
  const autoRun = handoff?.to === current && handoff.auto;
  const pageKey = `${current}-${handoff?.to === current ? handoff.at : 0}`;
  const feature = FEATURES.find((f) => f.page === current);
  const { BoardScreen, OpsScreen, ChartScreen, ConsentScreen, LinkEntry, MyReservations, RoomDirectory, InquiryInbox, MyInquiries } = webModules;
  const isChartOwner = me?.roles.includes('chart-owner') ?? false;

  return (
    <div className='app'>
      <DemoBand items={config.demoData} />
      {me === null ? (
        <Login onLoggedIn={refreshMe} />
      ) : (
        <ActionHost onNavigate={navigate}>
          <div className='app-bar'>
            <span className='brand'>한 줄 데스크</span>
            <NotificationBell onNavigate={navigate} />
          </div>
          <main className='screen'>
            {entry?.kind === 'consent' && <ConsentScreen me={me} />}
            {entry?.kind === 'link' && <LinkEntry me={me} token={entry.token} />}
            {!entry && current === 'home' && <Home me={me} modules={config.modules} onOpen={go} />}
            {!entry && feature && current !== 'board' && (
              <FeaturePage key={pageKey} feature={feature} initialText={initial} autoRun={autoRun} onMove={move}>
                {current === 'rooms' && (
                  <>
                    <RoomDirectory me={me} />
                    <MyReservations />
                  </>
                )}
                {current === 'navi' && (
                  <>
                    <InquiryInbox />
                    <MyInquiries />
                  </>
                )}
                {current === 'navi' && isChartOwner && (
                  <section className='card'>
                    <h2>분장표 주인이에요</h2>
                    <p className='hint'>"틀렸어요" 기록 묶음을 보고, 우리 부서 분장표를 고쳐 올릴 수 있어요.</p>
                    <button type='button' className='secondary' onClick={() => go('chart')}>
                      수정 제안함 열기
                    </button>
                  </section>
                )}
              </FeaturePage>
            )}
            {!entry && current === 'board' && (
              <BoardScreen
                key={pageKey}
                me={me}
                head={FEATURES.find((f) => f.page === 'board')!}
                initialText={initial}
                onOpenOps={() => go('ops')}
                onMoveToNavi={(text) => go('navi', text, true)}
              />
            )}
            {!entry && current === 'ops' && <OpsScreen me={me} />}
            {!entry && current === 'chart' && <ChartScreen me={me} />}
            {!entry && current === 'mine' && <Mine me={me} modules={config.modules} onLoggedOut={() => setMe(null)} onOpen={(to) => go(to)} />}
          </main>
          <TabBar current={tabOf(current)} onChange={(t) => go(t)} modules={config.modules} />
        </ActionHost>
      )}
    </div>
  );
}
