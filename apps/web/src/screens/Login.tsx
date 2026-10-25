import { useEffect, useState } from 'react';
import { api, type MockUser } from '../api';

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
    else setError('로그인하지 못했어요. 다시 골라 주세요.');
  }

  return (
    <main className="screen login">
      <h1>한 줄 데스크</h1>
      <p className="lead">회의실 잡기, 탕비실 채우기, 누구한테 물을지. 한 줄 쓰면 확인 카드로 돌려줘요.</p>
      <section className="card">
        <h2>회사 계정으로 로그인</h2>
        <p className="hint">모의 로그인이에요. 실제 사내 로그인은 IdP 앱 등록이 끝나면 바꿔요.</p>
        <ul className="choices">
          {users.map((u) => (
            <li key={u.idpSubject}>
              <button type="button" onClick={() => choose(u.idpSubject)}>
                <strong>{u.displayName}</strong>
                <span>
                  {u.department} · {u.floor}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="lock-line">{error}</p>}
      </section>
    </main>
  );
}
