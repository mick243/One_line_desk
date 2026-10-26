import { type Role, ROLE_LABEL } from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { api, type MockUser } from '../api';
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

// 1일 차 끝 기준이 "로그인 화면"이에요. 지금은 모의 OIDC로 가상 직원을 골라요.
export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [users, setUsers] = useState<MockUser[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void api.mockUsers().then(setUsers);
  }, []);

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
    </main>
  );
}
