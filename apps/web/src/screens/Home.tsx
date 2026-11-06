// 홈: 무엇을 할 수 있는지 목록 하나로 보여 줘요(10/26 화면 구조 변경, 10/26 디자인 정리).
// 한 줄을 누르면 그 기능 페이지가 열려요. 아래에는 다가오는 내 예약·내 요청이 있어요.
// 11/3(ADR-27, D8 해제): 맨 위에 "나에게 해당하는 일" 채팅 칸과 "오늘·이번 주 내 일" 카드가 있어요. 켜져 있으면
// 겹치는 작은 카드(내 예약·내 문의 요약)는 빼고, 그 카드에 없는 같이 채워요 내 요청만 남겨요.
// 11/4(홈 메뉴 회의, docs/홈메뉴회의_2026-11-03.md): 홈 채팅이 켜져 있으면 "할 수 있는 일" 목록도 숨겨요. 아래 탭과
// 같은 기능을 같은 조건으로 보여 줘서 겹치기 때문이에요. 채팅을 끈 회사에서는 홈이 비지 않게 목록을 그대로 보여 줘요.
// 11/4 사용자 결정: 같이 채워요 내 요청도 채팅("내가 보낸 요청")과 겹쳐서 채팅이 켜져 있으면 숨겨요.
import type { AppDestination, ModuleKind, ModuleSwitch } from '@one-line-desk/shared';
import type { Me } from '../api';
import { Icon } from '../components/Icon';
import { webModules } from '../modules/registry';
import { FEATURES, featureFor } from './features';
import { HomeAsk } from './HomeAsk';
import { LeaveStart } from './LeaveStart';

const ICON = { navi: 'navi', rooms: 'rooms', notices: 'notices', pantry: 'pantry' } as const;

export function Home({
  me,
  switches,
  onOpen,
  initialText,
  autoRun,
}: {
  me: Me;
  switches: {
    modules: Record<ModuleKind, ModuleSwitch>;
    roomsWrite: boolean;
    autoActions: boolean;
    homeAsk?: boolean;
    teamSchedule?: boolean;
    /** 앱 안 휴가 결재(11/6 A안 전 흐름). 거짓이면 [휴가 신청하기]가 신청 전 카드를 펼쳐요. */
    leaveInApp?: boolean;
  };
  onOpen: (page: AppDestination, text?: string, auto?: boolean) => void;
  /** 마이 페이지 안내 버튼이 넘긴 문장(11/5). autoRun이면 홈 채팅이 바로 찾아요. */
  initialText?: string;
  autoRun?: boolean;
}) {
  const { MyReservations, MyRequests, MyInquiries } = webModules;
  const { modules } = switches;
  const homeAsk = switches.homeAsk === true;
  const features = FEATURES.filter((f) => modules[f.module] !== 'off').map((f) => featureFor(f, switches));

  return (
    <div className='home'>
      <header className='page-head'>
        <p className='eyebrow'>
          {me.department} · {me.floor}
        </p>
        <h1>
          {me.displayName}님,
          <br />
          무엇을 할까요?
        </h1>
      </header>

      {homeAsk && <HomeAsk onOpen={onOpen} teamSchedule={switches.teamSchedule === true} modules={modules} initialText={initialText} autoRun={autoRun} />}

      {/* 바로 하기(11/5, 처음 쓰는 직원 점검: 휴가 신청 버튼이 앞에 보였으면): 문의함이 켜져 있으면 휴가 신청 양식을 바로 열어요. */}
      {modules.navi === 'on' && (
        <div className='home-quick' aria-label='바로 하기'>
          <LeaveStart inApp={switches.leaveInApp !== false} />
        </div>
      )}

      {!homeAsk && (
        <section className='card' aria-label='할 수 있는 일'>
          <ul className='menu-list'>
            {features.map((f) => (
              <li key={f.page}>
                <button type='button' className='menu-row' onClick={() => onOpen(f.page)}>
                  <span className={`menu-icon tint-${f.module}`}>
                    <Icon name={ICON[f.module]} />
                  </span>
                  <span className='menu-text'>
                    <strong>{f.title}</strong>
                    <span>{f.short}</span>
                  </span>
                  <span className='chevron'>
                    <Icon name='chevron' size={20} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!homeAsk && modules.rooms !== 'off' && <MyReservations compact />}
      {!homeAsk && modules.pantry !== 'off' && <MyRequests compact />}
      {!homeAsk && modules.navi === 'on' && <MyInquiries compact />}
    </div>
  );
}
