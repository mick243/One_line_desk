import { type Role, ROLE_LABEL } from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { api, type MockUser, type PublicConfig } from '../api';
import { Icon } from '../components/Icon';

// 고르면 무엇을 더 볼 수 있는지 한 줄로 알려 줘요.
const ROLE_HINT: Partial<Record<Role, string>> = {
  facilities: '같이 채워요 운영(합치기·주문안)',
  'chart-owner': '분장표 수정 제안함',
  operator: '운영 설정',
};

function roleLine(roles: Role[] = []): string {
  const extra = roles.filter((r) => r !== 'employee');
  if (extra.length === 0) return '직원 화면';
  return `${extra.map((r) => ROLE_LABEL[r]).join('·')} — ${extra
    .map((r) => ROLE_HINT[r])
    .filter(Boolean)
    .join(', ')}도 볼 수 있어요`;
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
};

// 1일 차 끝 기준이 "로그인 화면"이에요. 지금은 모의 OIDC로 가상 직원을 골라요.
// reauth: 쉬는 시간이 지나 끊겼으면 회사 로그인에 다시 인증을 요청해요(ADR-20).
export function Login({
  onLoggedIn,
  login,
  notice,
  reauth = false,
}: {
  onLoggedIn: () => void;
  login: PublicConfig['login'];
  notice?: string;
  reauth?: boolean;
}) {
  const [users, setUsers] = useState<MockUser[]>([]);
  const [error, setError] = useState(() => {
    const reason = new URLSearchParams(window.location.search).get('login');
    return reason ? (LOGIN_FAILED[reason] ?? LOGIN_FAILED.failed!) : '';
  });

  useEffect(() => {
    if (login.kind === 'mock') void api.mockUsers().then(setUsers);
  }, [login.kind]);

  /** 회사 계정(IdP) 로그인: 지금 보던 주소로 돌아오게 해요(예: AI 앱 연결 동의 화면). */
  function startIdpLogin() {
    const back = window.location.pathname === '/' ? '/' : `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/api/auth/oidc/start?return=${encodeURIComponent(back)}${reauth ? '&reauth=idle' : ''}`);
  }

  async function choose(idpSubject: string) {
    setError('');
    if (await api.login(idpSubject)) onLoggedIn();
    else setError('로그인하지 못했어요. 한 번 더 골라 주세요.');
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
                    <small className='role-line'>{roleLine(u.roles)}</small>
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
    </main>
  );
}
