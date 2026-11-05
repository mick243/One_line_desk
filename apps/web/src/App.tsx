import { APP_DESTINATIONS, type AppDestination, type Kind, type RoomShowQuery } from '@one-line-desk/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  IDLE_ENDED_MESSAGE,
  type Me,
  onSessionEnded,
  type PublicConfig,
  RESTARTED_MESSAGE,
  SESSION_ENDED_MESSAGE,
  sessionEndedByIdle,
  sessionEndedByRestart,
} from './api';
import { ActionHost } from './components/ActionHost';
import { DemoBand } from './components/DemoBand';
import { VersionBand } from './components/VersionBand';
import { NotificationBell } from './components/NotificationBell';
import { TabBar, type Tab, visibleTabs } from './components/TabBar';
import { webModules } from './modules/registry';
import { FEATURES, featureFor, pageOfKind } from './screens/features';
import { FeaturePage } from './screens/FeaturePage';
import { Home } from './screens/Home';
import { Login } from './screens/Login';
import { AiEvalScreen } from './screens/AiEval';
import { LeaveStart } from './screens/LeaveStart';
import { Mine } from './screens/Mine';

type View = AppDestination;

/** 바깥에서 들어오는 길(M3·M4): 연결 동의 시트, 앱 확인 링크. 로그인 뒤에 열려요. */
function entryFromPath(): { kind: 'consent' } | { kind: 'link'; token: string } | null {
  const path = window.location.pathname;
  if (path.startsWith('/oauth/consent')) return { kind: 'consent' };
  const link = path.match(/^\/r\/([A-Za-z0-9_.-]+)$/);
  return link ? { kind: 'link', token: link[1]! } : null;
}

/** 운영(S4)은 같이 채워요 탭, 분장표 수정 제안함(S5)은 문의하기 탭 아래에 있어요. */
function tabOf(view: View): Tab {
  if (view === 'ops') return 'board';
  // 관리자 AI 정답률(11/5 시험)은 마이 페이지 아래에 있어요.
  if (view === 'ai-eval') return 'mine';
  if (view === 'chart' || view === 'it-help' || view === 'onboarding') return 'navi';
  return view;
}

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<View>('home');
  const [entry, setEntry] = useState(entryFromPath);
  const [offline, setOffline] = useState(false);
  // 다른 페이지로 옮겨 가는 문장(예시 문장, "종류가 달라요", [문의하기로 옮기기]). 앱 메모리에만 둬요(R13).
  // auto: 다른 기능에서 옮겨 온 문장이면 그 페이지에서 바로 찾아요. 홈 예시 문장은 채우기만 해요.
  const [handoff, setHandoff] = useState<{ to: View; text: string; at: number; auto: boolean } | null>(null);
  // 회의실 입력 칸의 최근 쓴 문장(최대 5개). 이 창 메모리에만 있어요. 저장소·서버에는 두지 않아요(R13).
  const [roomRecent, setRoomRecent] = useState<string[]>([]);
  // 회의실 그림 카드는 대화 현황 카드의 [그림으로 모든 회의실 보기]를 눌렀을 때만 그 조건으로 펼쳐요(10/30 QA·디자인 회의).
  const [roomShow, setRoomShow] = useState<RoomShowQuery | null>(null);

  // 로그인이 풀리면 로그인 화면으로 돌려요. 알림 새로 불러오기 같은 반복 요청도 화면과 함께 멈춰요(L-46).
  const [ended, setEnded] = useState(false);
  const refreshMe = useCallback(async () => {
    const next = await api.me();
    setMe(next);
    if (next) setEnded(false);
    // 쉬는 시간이나 서버 재시작으로 끊긴 뒤 새로 고쳐도 왜 로그인 화면인지 알려 줘요(ADR-20, 배포 준비 회의 B3).
    else if (sessionEndedByIdle() || sessionEndedByRestart()) setEnded(true);
  }, []);
  useEffect(
    () =>
      onSessionEnded(() => {
        setEnded(true);
        setMe(null);
      }),
    [],
  );
  // 로그인이 풀리거나 로그아웃하면 보던 페이지와 옮기던 문장을 비워요. 같은 PC로 다음 사람이 들어와도
  // 앞사람 문장이 칸에 남거나 다음 사람 이름으로 찾아지지 않고, 홈에서 시작해요(QA D-A01·D-A05, R13).
  useEffect(() => {
    if (me !== null) return;
    setView('home');
    setHandoff(null);
    setRoomRecent([]);
  }, [me]);

  const load = useCallback(async () => {
    setOffline(false);
    try {
      // 공개 설정과 내 정보를 같이 불러서 첫 화면 왕복을 한 번 줄여요(배포 준비 회의 D3).
      const [loaded] = await Promise.all([api.publicConfig(), refreshMe()]);
      setConfig(loaded);
    } catch {
      setOffline(true);
    }
  }, [refreshMe]);

  useEffect(() => {
    void load();
  }, [load]);

  // 휴대폰·브라우저 뒤로 가기(10/31 QA H3): 페이지를 옮길 때 방문 기록에 페이지 이름만 남겨서, 뒤로 가기가 앱 밖으로 나가지 않고
  // 앞 페이지로 돌아가요. 주소는 늘 '/'이고 기록에는 페이지 이름(home·navi·it-help…)만 넣어요. 쓰던 글·옮기던 문장은 넣지 않아요(R13).
  const viewRef = useRef<View>('home');
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    if (window.location.pathname === '/') window.history.replaceState({ deskView: 'home' }, '', '/');
    const onPop = (e: PopStateEvent) => {
      const to = (e.state as { deskView?: unknown } | null)?.deskView;
      if (typeof to !== 'string' || !(APP_DESTINATIONS as readonly string[]).includes(to)) return;
      setEntry(null);
      setHandoff(null);
      setView(to as View);
      window.scrollTo(0, 0);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((to: View, text?: string, auto = false) => {
    setEntry(null);
    // 바깥에서 들어온 주소(/r/…·/oauth/consent)는 기록에서 바꿔 치우고, 앱 안 이동은 기록을 하나 더해요.
    if (window.location.pathname !== '/' || to === viewRef.current) window.history.replaceState({ deskView: to }, '', '/');
    else window.history.pushState({ deskView: to }, '', '/');
    setHandoff(text ? { to, text, at: Date.now(), auto } : null);
    setView(to);
    // 다른 페이지로 가면 맨 위부터 보여요.
    window.scrollTo(0, 0);
  }, []);
  const navigate = useCallback((to: AppDestination) => go(to), [go]);
  const move = useCallback((kind: Kind, text: string) => go(pageOfKind(kind), text, true), [go]);
  // 회의실 채팅에 넘기는 함수는 렌더마다 새로 만들지 않아요(채팅 안 useMemo가 깨지지 않게).
  const showRooms = useCallback((show: RoomShowQuery | null) => setRoomShow(show ?? null), []);
  const addRecent = useCallback((text: string) => setRoomRecent((list) => [text, ...list.filter((x) => x !== text)].slice(0, 5)), []);
  const removeRecent = useCallback((text: string) => setRoomRecent((list) => list.filter((x) => x !== text)), []);

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
  const found = FEATURES.find((f) => f.page === current);
  const feature = found && featureFor(found, config);
  const {
    BoardScreen,
    OpsScreen,
    ChartScreen,
    ItHelpScreen,
    OnboardingScreen,
    ConsentScreen,
    LinkEntry,
    MyReservations,
    MyLoans,
    RoomChat,
    RoomDirectory,
    InquiryInbox,
    MyInquiries,
    InvitedMeetings,
    JointRequests,
  } = webModules;
  const isChartOwner = me?.roles.includes('chart-owner') ?? false;

  return (
    <div className='app'>
      <DemoBand items={config.demoData} />
      <VersionBand />
      {me === null ? (
        <Login
          onLoggedIn={refreshMe}
          login={config.login}
          notice={ended ? (sessionEndedByIdle() ? IDLE_ENDED_MESSAGE : sessionEndedByRestart() ? RESTARTED_MESSAGE : SESSION_ENDED_MESSAGE) : undefined}
          reauth={ended && sessionEndedByIdle()}
        />
      ) : (
        <ActionHost onNavigate={navigate} InviteSheet={webModules.InviteSheet} inviteChannels={config.inviteChannels}>
          <div className='app-bar'>
            <span className='brand'>한 줄 데스크</span>
            <NotificationBell onNavigate={navigate} />
          </div>
          <main className='screen'>
            {entry?.kind === 'consent' && <ConsentScreen me={me} />}
            {entry?.kind === 'link' && (
              <LinkEntry me={me} token={entry.token} InquirySheet={webModules.InquirySheet} LeaveRequestSheet={webModules.LeaveRequestSheet} />
            )}
            {!entry && current === 'home' && <Home key={pageKey} me={me} switches={config} onOpen={go} initialText={initial} autoRun={autoRun} />}
            {!entry && feature && current !== 'board' && (
              <FeaturePage
                key={pageKey}
                feature={feature}
                initialText={initial}
                autoRun={autoRun}
                onMove={move}
                // 회의실이 켜져 있으면 빈 회의실 찾기와 회의실 채팅을 한 입력 칸으로 써요(10/28 통합 개편). 링크만이면 공통 입력이 링크 카드를 줘요.
                input={
                  current === 'rooms' && config.modules.rooms === 'on'
                    ? (p) => (
                        <RoomChat
                          auto={config.autoActions && config.roomsWrite}
                          write={config.roomsWrite}
                          recent={roomRecent}
                          onShowRooms={showRooms}
                          canEditFacilities={me.roles.includes('facilities')}
                          onSent={addRecent}
                          onRemoveRecent={removeRecent}
                          {...p}
                        />
                      )
                    : undefined
                }
              >
                {current === 'rooms' && (
                  <>
                    {/* 여러 팀 회의 참석자 고르기 요청(ADR-28): 11/5 마이 페이지에서 옮겼어요. 알림도 여기로 와요. */}
                    {config.roomsWrite && <JointRequests />}
                    <InvitedMeetings />
                    <RoomDirectory me={me} show={roomShow} />
                    <MyReservations />
                    <MyLoans />
                  </>
                )}
                {current === 'navi' && (
                  <>
                    {/* 11/2: "이런 것도 찾아 줘요" 묶음을 뺐어요. IT 오류·첫 2주 화면은 맞는 질문의 카드 버튼(withGuides)으로 들어가요. */}
                    {/* 11/5: 휴가 신청은 찾지 않아도 바로 열 수 있게 칸을 둬요. */}
                    <LeaveStart variant='card' />
                    <InquiryInbox />
                    <MyInquiries />
                  </>
                )}
                {current === 'navi' && isChartOwner && (
                  <section className='card'>
                    <h2>분장표 주인이에요</h2>
                    <p className='hint'>받는 곳을 바꿔 보낸 기록 묶음을 보고, 우리 부서 분장표를 고쳐 올릴 수 있어요.</p>
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
            {!entry && current === 'it-help' && <ItHelpScreen onBack={() => go('navi')} />}
            {!entry && current === 'onboarding' && <OnboardingScreen onBack={() => go('navi')} />}
            {!entry && current === 'mine' && <Mine me={me} switches={config} onLoggedOut={() => setMe(null)} onOpen={(to, text, auto) => go(to, text, auto)} />}
            {/* 관리자 AI 정답률(11/5 시험): 운영자만 그려요. 서버도 운영자가 아니면 403이에요. */}
            {!entry &&
              current === 'ai-eval' &&
              (me.roles.includes('operator') ? <AiEvalScreen onBack={() => go('mine')} /> : <p className='empty'>운영자만 볼 수 있어요.</p>)}
          </main>
          <TabBar current={tabOf(current)} onChange={(t) => go(t)} modules={config.modules} />
        </ActionHost>
      )}
    </div>
  );
}
