// S6 내 것
import { type ModuleKind, type ModuleSwitch, ROLE_LABEL } from '@one-line-desk/shared';
import { useState } from 'react';
import { api, type Me } from '../api';
import { ConfirmSheet } from '../components/ActionHost';
import { webModules } from '../modules/registry';

// 내 예약·요청, 내 역할 진입점, 연결된 AI 앱, 저장하는 것 안내, 모든 기기 로그아웃이 있어요.
export function Mine({
  me,
  modules,
  onLoggedOut,
  onOpen,
}: {
  me: Me;
  modules: Record<ModuleKind, ModuleSwitch>;
  onLoggedOut: () => void;
  onOpen: (to: 'ops' | 'chart') => void;
}) {
  const [confirmAll, setConfirmAll] = useState(false);
  const { MyReservations, MyRequests, ConnectedApps } = webModules;

  async function logout(all: boolean) {
    await api.logout(all);
    onLoggedOut();
  }

  // 꺼진 모듈의 화면(S4·S5)으로 가는 버튼은 숨겨요(ADR-12).
  const hasFacilities = me.roles.includes('facilities') && modules.pantry !== 'off';
  const hasChart = me.roles.includes('chart-owner') && modules.navi !== 'off';

  return (
    <div className='mine'>
      <header className='screen-head'>
        <h1>내 것</h1>
      </header>

      <section className='card'>
        <h2>{me.displayName}</h2>
        <p className='hint'>
          {me.department} · {me.floor}
        </p>
      </section>

      <MyReservations />
      <MyRequests />

      {(hasFacilities || hasChart) && (
        <section className='card'>
          <h2>내 역할</h2>
          <div className='actions'>
            {hasFacilities && (
              <button type='button' className='secondary' onClick={() => onOpen('ops')}>
                {ROLE_LABEL.facilities} · 운영
              </button>
            )}
            {hasChart && (
              <button type='button' className='secondary' onClick={() => onOpen('chart')}>
                {ROLE_LABEL['chart-owner']} · 수정 제안함
              </button>
            )}
          </div>
        </section>
      )}

      <ConnectedApps />

      <section className='card' id='retention'>
        <h2>무엇을 남기나요</h2>
        <p>
          남기는 것: 예약 기록, 내가 올린 품목 이름과 표, "틀렸어요"에서 고른 결과(누가 골랐는지는 안 남아요), 감사 기록(가명 ID · 시각 · 동작 종류 · 결과, 내용
          없음).
        </p>
        <p>남기지 않는 것: 묻기에 쓴 문장</p>
      </section>

      <div className='actions'>
        <button type='button' className='secondary' onClick={() => setConfirmAll(true)}>
          모든 기기 로그아웃
        </button>
        <button type='button' className='secondary' onClick={() => logout(false)}>
          로그아웃
        </button>
      </div>

      {confirmAll && (
        <ConfirmSheet
          sheet={{
            title: '모든 기기 로그아웃',
            lines: ['모든 기기에서 로그아웃되고, 연결된 AI 앱도 모두 끊겨요. 다시 쓰려면 회사 계정으로 로그인해요.'],
            confirmLabel: '모두 로그아웃하기',
          }}
          onCancel={() => setConfirmAll(false)}
          onConfirm={() => logout(true)}
        />
      )}
    </div>
  );
}
