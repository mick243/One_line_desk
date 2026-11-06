// S6 마이 페이지
import { MINE_MOVED_ASKS, mineMovedNote, type ModuleKind, type ModuleSwitch, RECORD_KEEP_DAYS, ROLE_LABEL } from '@one-line-desk/shared';
import { useState } from 'react';
import { api, type Me } from '../api';
import { ConfirmSheet } from '../components/ActionHost';
import { webModules } from '../modules/registry';

// 내 역할 진입점, 연결된 AI 앱, 저장하는 것 안내, 모든 기기 로그아웃이 있어요.
// 11/5 사용자 결정(ADR-27 보강): 홈 채팅이 켜져 있으면 내 예약·내 요청·나에게 온 요청·자리비움 알리기 칸을 빼고 홈 채팅에서 해요.
// 그 자리에 안내 문구와, 홈 채팅에 정해진 문장을 넣어 바로 찾는 버튼을 둬요. 홈 채팅을 끈 회사는 칸을 그대로 둬요(갈 곳이 없어지지 않게).
// 여러 팀 회의 참석자 고르기 요청은 회의실 페이지로 옮겼어요(알림도 회의실로 가요).
// "무엇을 남기나요"(L-42, QA-8). 켜진 기능의 줄만 보여요. 문장은 docs/화면설계.md "보안이 보이는 문구" 표와 같아요.
// 지우기는 서버가 화면을 열지 않아도 한 시간마다 해요(L-33). 10/28부터 접속기록(법정 1년) 말고는 모두 7일이에요.
function retentionLines(s: { modules: Record<ModuleKind, ModuleSwitch>; roomsWrite: boolean; mcp: boolean; teamSchedule?: boolean }) {
  const invites = s.modules.rooms === 'on' && s.roomsWrite;
  const keep = [
    s.modules.navi === 'on' && `담당 팀에 보낸 문의·사유와 내 이름·부서. 받는 팀이 보고, ${RECORD_KEEP_DAYS}일 뒤 지워져요.`,
    `앱 안 알림. 내용 없이 무슨 일인지만 남고, ${RECORD_KEEP_DAYS}일 뒤 지워져요.`,
    invites &&
      `예약·장비 대여 기록과 회의 초대(부른 사람·참석자·답). 끝나고 ${RECORD_KEEP_DAYS}일 뒤 지워져요. 예약을 취소하면 초대와 같이 빌린 장비도 함께 지워지고, 취소한 기록은 ${RECORD_KEEP_DAYS}일 뒤 지워져요.`,
    invites &&
      `회의 초대에 못 간다고 적은 사유와 대신 부탁한 사유. 부른 사람(과 부탁받은 사람)에게만 보이고, 알림에는 넣지 않아요. 회의가 끝나고 ${RECORD_KEEP_DAYS}일 뒤 지워져요.`,
    s.modules.pantry !== 'off' &&
      `내가 올린 품목 이름과 표. 올린 지 ${RECORD_KEEP_DAYS}일(주문에 들어갔으면 주문하고 ${RECORD_KEEP_DAYS}일) 뒤 지워져요. 누가 표를 줬는지는 화면 어디에도 안 보여요.`,
    s.modules.navi === 'on' && s.teamSchedule && `내가 알린 자리비움(종류·시간). 같은 팀 사람에게만 보이고, ${RECORD_KEEP_DAYS}일 뒤 지워져요.`,
    s.modules.navi === 'on' && `문의할 때 받는 곳을 바꿔 보낸 사실(고른 업무·바꾼 업무·날짜). 글과 보낸 사람은 남지 않고, ${RECORD_KEEP_DAYS}일 뒤 지워져요.`,
    s.mcp && '연결한 AI 앱(앱 이름·연결한 날·기기마다 하나). 끊으면 지워져요.',
    `감사 기록(가명 ID·시각·동작 종류·결과). 내용은 남지 않고, ${RECORD_KEEP_DAYS}일 뒤 지워져요.`,
    '접속기록(가명 ID·시각·접속한 곳의 IP·한 일·열어 본 문의 번호). 법에 따라 1년 두고 지워요. 글과 검색어는 남지 않아요.',
  ].filter((line): line is string => Boolean(line));
  const outside = [
    invites && '회의 초대를 그룹웨어 캘린더·Slack으로 보내면 부른 사람 이름·회의실·시간이 그 서비스에 남아요. 그쪽 보관 설정을 따라요.',
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
  switches: { modules: Record<ModuleKind, ModuleSwitch>; roomsWrite: boolean; mcp: boolean; teamSchedule?: boolean; homeAsk?: boolean };
  onLoggedOut: () => void;
  onOpen: (to: 'ops' | 'chart' | 'ai-eval' | 'cafe-settle' | 'home', text?: string, auto?: boolean) => void;
}) {
  const { modules } = switches;
  const retention = retentionLines(switches);
  const [confirmAll, setConfirmAll] = useState(false);
  const { MyReservations, MyRequests, MyInquiries, MyAway, ConnectedApps, InvitedMeetings, TeamDelegates, DemoInbox } = webModules;
  // 여러 팀 회의(ADR-28): 회의실 쓰기가 켜졌을 때만이에요.
  const joint = modules.rooms === 'on' && switches.roomsWrite;
  // 홈 채팅으로 옮긴 칸(11/5). 자리비움은 같은 팀 일정·문의하기가 켜졌을 때만 있어요(서버 awayOn과 같아요).
  const moved = switches.homeAsk === true;
  const awayShown = modules.navi === 'on' && switches.teamSchedule === true;
  const movedAsks = MINE_MOVED_ASKS.filter((a) => (a.text === '내 예약 보기' ? modules.rooms !== 'off' : a.text === '자리비움 알리기' ? awayShown : true));

  async function logout(all: boolean) {
    await api.logout(all);
    onLoggedOut();
  }

  // 꺼진 모듈의 화면(S4·S5)으로 가는 버튼은 숨겨요(ADR-12).
  const hasFacilities = me.roles.includes('facilities') && modules.pantry !== 'off';
  const hasChart = me.roles.includes('chart-owner') && modules.navi !== 'off';
  // 관리자(운영자)만 보는 AI 정답률 화면(11/5 시험, R7 예외)
  const isOperator = me.roles.includes('operator');
  // 카페 정산(S9, 11/6 ADR-29): 총무이고 사내 카페가 켜져 있을 때만이에요.
  const hasCafeSettle = me.roles.includes('facilities') && modules.cafeteria === 'on';

  return (
    <div className='mine'>
      <header className='screen-head'>
        <h1>마이 페이지</h1>
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

      {moved ? (
        <section className='card mine-moved' aria-label='홈 채팅에서 해요'>
          <h2>홈 채팅에서 해요</h2>
          <p className='hint'>{mineMovedNote(awayShown)}</p>
          <div className='actions'>
            {movedAsks.map((a) => (
              <button key={a.text} type='button' className='secondary' onClick={() => onOpen('home', a.ask, true)}>
                {a.text}
              </button>
            ))}
          </div>
        </section>
      ) : (
        <>
          <MyReservations />
          <InvitedMeetings />
          <MyRequests />
          {switches.modules.navi === 'on' && <MyInquiries />}
          {switches.modules.navi === 'on' && <MyAway />}
        </>
      )}
      {joint && <TeamDelegates />}

      {(hasFacilities || hasChart || isOperator || hasCafeSettle) && (
        <section className='card'>
          <h2>내 역할</h2>
          <div className='actions'>
            {hasFacilities && (
              <button type='button' className='secondary' onClick={() => onOpen('ops')}>
                {ROLE_LABEL.facilities} · 운영
              </button>
            )}
            {hasCafeSettle && (
              <button type='button' className='secondary' onClick={() => onOpen('cafe-settle')}>
                {ROLE_LABEL.facilities} · 카페 정산
              </button>
            )}
            {hasChart && (
              <button type='button' className='secondary' onClick={() => onOpen('chart')}>
                {ROLE_LABEL['chart-owner']} · 수정 제안함
              </button>
            )}
            {isOperator && (
              <button type='button' className='secondary' onClick={() => onOpen('ai-eval')}>
                {ROLE_LABEL.operator} · AI 정답률
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
          <li>문의함·회의실·공지 입력 칸과 회의실 채팅에 쓴 문장</li>
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
