import { CAFE_TEXT, type Role, ROLE_LABEL } from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { api, type MockUser, type PublicConfig } from '../api';
import { Icon } from '../components/Icon';

// 고르면 무엇을 더 볼 수 있는지 한 줄로 알려 줘요.
const ROLE_HINT: Partial<Record<Role, string>> = {
  facilities: '같이 채워요 운영(합치기·주문안)',
  'chart-owner': '분장표 수정 제안함',
  operator: '운영 설정',
  // 11/5: 빠져 있어서 "팀장 — 도 볼 수 있어요"처럼 글자가 비었어요(처음 쓰는 직원 점검).
  'team-lead': '여러 팀 회의 참석자 고르기·팀 회의 담당자',
  // 11/6: 바리스타는 홈이 카페 판이에요(카페가 켜져 있을 때).
  cafe: '카페 판',
};

/** 역할 이름과 더 볼 수 있는 화면. 로그인 줄에서는 두 줄로 나눠 보여요(11/8 리디자인, 줄표 없이). */
export function roleParts(roles: Role[] = []): { labels: string; more: string | null } {
  const extra = roles.filter((r) => r !== 'employee');
  if (extra.length === 0) return { labels: '직원 화면', more: null };
  const labels = extra.map((r) => ROLE_LABEL[r]).join('·');
  const hints = extra.map((r) => ROLE_HINT[r]).filter(Boolean);
  // 설명이 없는 역할만 있으면 역할 이름만 보여요(빈 "도 볼 수 있어요"가 나오지 않게).
  return { labels, more: hints.length ? `${hints.join(', ')}도 볼 수 있어요` : null };
}

/** 한 줄로 쓸 때(역할 이름 — 볼 수 있는 화면) */
export function roleLine(roles: Role[] = []): string {
  const { labels, more } = roleParts(roles);
  return more ? `${labels} — ${more}` : labels;
}

/** 로그인 줄의 역할 두 줄: 역할 이름, 그 아래 더 볼 수 있는 화면 */
function RoleLines({ roles }: { roles?: Role[] }) {
  const { labels, more } = roleParts(roles);
  return (
    <>
      <small className='role-line'>{labels}</small>
      {more && <small className='role-more'>{more}</small>}
    </>
  );
}

/** 동그라미 안 글자: 이름 마지막 낱말의 첫 글자("가상 직원 도윤" → "도") */
function initial(name: string): string {
  return name.split(' ').at(-1)?.charAt(0) ?? '?';
}

/** IdP에서 돌아왔는데 로그인하지 못했을 때 주소에 붙는 이유(서버 routes/auth.ts loginErrorReason) → 화면 문구 */
const LOGIN_FAILED: Record<string, string> = {
  failed: '로그인하지 못했어요. 한 번 더 해 주세요.',
  denied: '로그인을 취소했거나 회사 로그인이 허락하지 않았어요. 다시 하려면 아래 버튼을 눌러 주세요.',
  'mfa-required': '추가 인증(MFA)을 마쳐야 들어올 수 있어요. 회사 로그인에서 추가 인증을 한 뒤 다시 해 주세요.',
  'idp-unreachable': '지금 회사 로그인에 닿지 못했어요. 잠시 뒤에 다시 해 주세요. 계속 안 되면 IT 창구에 알려 주세요.',
  // [카페 판으로 로그인](11/6 3묶음): 바리스타가 아니면 세션을 만들지 않아요.
  'not-barista': `${CAFE_TEXT.notBarista}.`,
  'board-off': '지금은 카페 판을 쓰지 않아요.',
};

/** 카운터 기기 안내(11/6 3묶음, ADR-20 예외) */
export const BOARD_LOGIN_HINT =
  '카운터 기기에서 카페 판만 여는 로그인이에요. 바리스타만 들어올 수 있고, 쉬어도 끊기지 않다가 로그인부터 정해진 시간(기본 13시간) 뒤 끊겨요.';

// 1일 차 끝 기준이 "로그인 화면"이에요. 지금은 모의 OIDC로 가상 직원을 골라요.
// reauth: 쉬는 시간이 지나 끊겼으면 회사 로그인에 다시 인증을 요청해요(ADR-20).
export function Login({
  onLoggedIn,
  login,
  notice,
  reauth = false,
  cafeBoard = false,
}: {
  onLoggedIn: () => void;
  login: PublicConfig['login'];
  notice?: string;
  reauth?: boolean;
  /** 사내 카페가 '켬'이면 [카페 판으로 로그인]을 보여요(11/6 3묶음). */
  cafeBoard?: boolean;
}) {
  const [users, setUsers] = useState<MockUser[]>([]);
  // 공개 주소에 올린 시연은 비밀번호를 받아요(10/30). 입력 값은 이 화면 상태에만 두고 저장하지 않아요.
  const needsPassword = login.kind === 'mock' && login.password === true;
  const [password, setPassword] = useState('');
  const [error, setError] = useState(() => {
    const reason = new URLSearchParams(window.location.search).get('login');
    // 표에 있는 이유만 받아요. "__proto__"·"constructor" 같은 값이 객체 원형을 꺼내 화면이 멈추지 않게 해요(QA D-A04).
    if (!reason) return '';
    return Object.hasOwn(LOGIN_FAILED, reason) ? LOGIN_FAILED[reason]! : LOGIN_FAILED.failed!;
  });

  useEffect(() => {
    if (login.kind === 'mock') void api.mockUsers().then(setUsers);
  }, [login.kind]);

  /** 회사 계정(IdP) 로그인: 지금 보던 주소로 돌아오게 해요(예: AI 앱 연결 동의 화면). */
  function startIdpLogin() {
    const back = window.location.pathname === '/' ? '/' : `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/api/auth/oidc/start?return=${encodeURIComponent(back)}${reauth ? '&reauth=idle' : ''}`);
  }

  /** [카페 판으로 로그인](IdP): 판 전용 표시를 실어 회사 로그인으로 가요. 돌아오면 서버가 바리스타인지 봐요. */
  function startBoardIdpLogin() {
    window.location.assign(`/api/auth/oidc/start?board=1&return=%2F${reauth ? '&reauth=idle' : ''}`);
  }

  async function choose(idpSubject: string, board = false) {
    setError('');
    if (needsPassword && !password) {
      setError('시연 비밀번호를 먼저 넣어 주세요.');
      return;
    }
    const result = await api.login(idpSubject, needsPassword ? password : undefined, board);
    if (result.ok) onLoggedIn();
    else setError(result.message ?? '로그인하지 못했어요. 한 번 더 골라 주세요.');
  }

  return (
    <main className='screen login'>
      <header className='page-head'>
        <span className='brand-mark' aria-hidden='true'>
          한
        </span>
        <h1>
          회사 일, 이제
          <br />한 줄이면 돼요
        </h1>
        <p className='lead'>회의실 잡기, 탕비실 채우기, 누구에게 물을지. 한 줄로 쓰면 확인 카드로 돌려줘요.</p>
      </header>
      {notice && (
        <p className='notice-line' role='alert'>
          <Icon name='lock' size={14} />
          {notice}
        </p>
      )}
      {login.kind === 'oidc' && (
        <section className='card'>
          <h2>{login.label}으로 들어가기</h2>
          <p className='hint'>회사 IdP 로그인 화면으로 갔다가 돌아와요. 이 앱은 비밀번호를 보지 않아요.</p>
          <button type='button' className='primary' onClick={startIdpLogin}>
            {login.label}으로 로그인
          </button>
          {error && <p className='lock-line'>{error}</p>}
        </section>
      )}
      {login.kind === 'mock' && (
        <section className='card'>
          <h2>가상 직원으로 들어가기</h2>
          <p className='hint'>시연용이에요. 한 사람을 고르면 그 사람으로 들어가요. 실제로는 회사 계정으로 로그인해요.</p>
          {/* 여러 사람이 같은 가상 직원을 같이 써요. 남이 쓴 글이 보여서 실제 정보를 쓰지 말라고 알려요(배포 준비 회의 D8). */}
          <p className='demo-warning'>
            여러 사람이 같은 가상 직원으로 들어와요. 보낸 문의·올린 품목·예약은 다른 사람도 볼 수 있어요. 진짜 이름·고민·연락처는 쓰지 마세요
          </p>
          {needsPassword && (
            <label className='demo-password'>
              <span>시연 비밀번호</span>
              <input
                type='password'
                autoComplete='current-password'
                maxLength={200}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder='안내받은 비밀번호'
              />
              <small className='hint'>시연을 안내받은 사람만 들어와요. 비밀번호는 안내한 사람에게 물어 주세요.</small>
            </label>
          )}
          <ul className='choices'>
            {users.map((u) => (
              <li key={u.idpSubject}>
                <button type='button' onClick={() => choose(u.idpSubject)}>
                  <span className='avatar' aria-hidden='true'>
                    {initial(u.displayName)}
                  </span>
                  <span className='choice-text'>
                    <strong>{u.displayName}</strong>
                    <span>
                      {u.department} · {u.floor}
                    </span>
                    <RoleLines roles={u.roles} />
                  </span>
                  <span className='chevron'>
                    <Icon name='chevron' size={20} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {error && <p className='lock-line'>{error}</p>}
        </section>
      )}
      {cafeBoard && (
        <BoardLogin
          kind={login.kind}
          baristas={users.filter((u) => u.roles?.includes('cafe'))}
          onIdp={startBoardIdpLogin}
          onChoose={(subject) => void choose(subject, true)}
        />
      )}
    </main>
  );
}

/**
 * [카페 판으로 로그인](S8, 11/6 3묶음). 카운터 기기가 카페 판만 여는 세션으로 들어와요.
 * 회사 로그인은 판 전용 표시를 실어 IdP로 가고, 시연(모의)은 바리스타 가상 직원을 골라요. 바리스타가 아니면 서버가 세션을 만들지 않아요.
 */
export function BoardLogin({
  kind,
  baristas,
  onIdp,
  onChoose,
}: {
  kind: PublicConfig['login']['kind'];
  baristas: MockUser[];
  onIdp: () => void;
  onChoose: (idpSubject: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className='card login-board' aria-label='카페 판으로 로그인'>
      <h2>카운터 기기</h2>
      <p className='hint'>{BOARD_LOGIN_HINT}</p>
      <button
        type='button'
        className='secondary'
        aria-expanded={kind === 'mock' ? open : undefined}
        onClick={kind === 'oidc' ? onIdp : () => setOpen((v) => !v)}
      >
        카페 판으로 로그인
      </button>
      {kind === 'mock' && open && (
        <ul className='choices'>
          {baristas.length === 0 && <li className='hint'>바리스타로 등록된 가상 직원이 없어요</li>}
          {baristas.map((u) => (
            <li key={u.idpSubject}>
              <button type='button' onClick={() => onChoose(u.idpSubject)}>
                <span className='avatar' aria-hidden='true'>
                  {initial(u.displayName)}
                </span>
                <span className='choice-text'>
                  <strong>{u.displayName}</strong>
                  <span>카페 판으로 들어가기</span>
                </span>
                <span className='chevron'>
                  <Icon name='chevron' size={20} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
