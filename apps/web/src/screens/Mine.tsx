// S6 내 것
import { type ModuleKind, type ModuleSwitch, ROLE_LABEL } from '@one-line-desk/shared';
import { useState } from 'react';
import { api, type Me } from '../api';
import { ConfirmSheet } from '../components/ActionHost';
import { webModules } from '../modules/registry';

// 내 예약·요청, 내 역할 진입점, 연결된 AI 앱, 저장하는 것 안내, 모든 기기 로그아웃이 있어요.
// "무엇을 남기나요"(L-42, QA-8). 켜진 기능의 줄만 보여요. 문장은 docs/화면설계.md "보안이 보이는 문구" 표와 같아요.
// 90일·30일 지우기는 서버가 화면을 열지 않아도 한 시간마다 해요(L-33).
function retentionLines(s: { modules: Record<ModuleKind, ModuleSwitch>; roomsWrite: boolean; mcp: boolean }) {
  const invites = s.modules.rooms === 'on' && s.roomsWrite;
  const keep = [
    s.modules.navi === 'on' && '담당 팀에 보낸 문의·사유와 내 이름·부서. 받는 팀이 보고, 90일 뒤 지워져요.',
    '앱 안 알림. 내용 없이 무슨 일인지만 남고, 30일 뒤 지워져요.',
    invites && '예약 기록과 회의 초대(부른 사람·참석자·답). 예약을 취소하면 초대도 같이 지워져요.',
    s.modules.pantry !== 'off' && '내가 올린 품목 이름과 표. 누가 표를 줬는지는 화면 어디에도 안 보여요.',
    s.modules.navi === 'on' && '"틀렸어요"에서 고른 결과. 누가 골랐는지는 남지 않아요.',
    s.mcp && '연결한 AI 앱(앱 이름·연결한 날). 끊으면 지워져요.',
    '감사 기록(가명 ID·시각·동작 종류·결과). 내용은 남지 않아요.',
  ].filter((line): line is string => Boolean(line));
  const outside = [
    invites && '회의 초대를 그룹웨어 캘린더·Slack으로 보내면 부른 사람 이름·방·시간이 그 서비스에 남아요. 그쪽 보관 설정을 따라요.',
    s.mcp && '연결한 AI 앱으로 간 찾기 결과는 그 앱 기록에 남을 수 있어요.',
  ].filter((line): line is string => Boolean(line));
  return { keep, outside };
}

export function Mine({
  me,
  switches,
  onLoggedOut,
  onOpen,
}: {
  me: Me;
  switches: { modules: Record<ModuleKind, ModuleSwitch>; roomsWrite: boolean; mcp: boolean };
  onLoggedOut: () => void;
  onOpen: (to: 'ops' | 'chart') => void;
}) {
  const { modules } = switches;
  const retention = retentionLines(switches);
  const [confirmAll, setConfirmAll] = useState(false);
  const { MyReservations, MyRequests, ConnectedApps, InvitedMeetings, DemoInbox } = webModules;

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

      <section className='card profile'>
        <span className='avatar' aria-hidden='true'>
          {me.displayName.split(' ').at(-1)?.charAt(0)}
        </span>
        <div>
          <h2>{me.displayName}</h2>
          <p className='hint'>
            {me.department} · {me.floor}
          </p>
        </div>
      </section>

      <MyReservations />
      <InvitedMeetings />
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

      <DemoInbox />

      <section className='card retention' id='retention'>
        <h2>무엇을 남기나요</h2>
        <h3>남기는 것</h3>
        <ul>
          {retention.keep.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <h3>바깥으로 가는 것</h3>
        {retention.outside.length ? (
          <ul>
            {retention.outside.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p>지금은 없어요.</p>
        )}
        <h3>남기지 않는 것</h3>
        <ul>
          <li>담당 찾기·회의실·공지 입력 칸에 쓴 문장</li>
        </ul>
      </section>

      <div className='actions'>
        <button type='button' className='neutral' onClick={() => logout(false)}>
          로그아웃
        </button>
        <button type='button' className='link' onClick={() => setConfirmAll(true)}>
          모든 기기에서 로그아웃
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
