import { ROLE_LABEL } from '@one-line-desk/shared';
import { useState } from 'react';
import { api, type Me } from '../api';
import { Sheet } from '../components/Sheet';

// S6 내 것. 저장하는 것 안내와 모든 기기 로그아웃이 있어요.
export function Mine({ me, onLoggedOut }: { me: Me; onLoggedOut: () => void }) {
  const [confirmAll, setConfirmAll] = useState(false);
  const extraRoles = me.roles.filter((r) => r !== 'employee');

  async function logout(all: boolean) {
    await api.logout(all);
    onLoggedOut();
  }

  return (
    <div className="mine">
      <header className="screen-head">
        <h1>내 것</h1>
      </header>

      <section className="card">
        <h2>{me.displayName}</h2>
        <p className="hint">
          {me.department} · {me.floor}
        </p>
      </section>

      <section className="card">
        <h2>내 예약·요청</h2>
        <p className="empty">아직 예약·요청이 없어요.</p>
      </section>

      {extraRoles.length > 0 && (
        <section className="card">
          <h2>내 역할</h2>
          <ul className="plain">
            {extraRoles.map((r) => (
              <li key={r}>
                {ROLE_LABEL[r]}
                {r === 'facilities' && <span className="hint"> · 운영(S4)은 8~9일 차</span>}
                {r === 'chart-owner' && <span className="hint"> · 수정 제안함(S5)은 5일 차</span>}
                {r === 'operator' && <span className="hint"> · 운영 설정은 화면 없이 따로 봐요</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>연결된 AI 앱</h2>
        <p className="empty">연결된 AI 앱이 없어요. AI 앱에서 연결하면 여기에 보여요.</p>
      </section>

      <section className="card" id="retention">
        <h2>무엇을 남기나요</h2>
        <p>
          남기는 것: 예약 기록, 내가 올린 품목 이름과 표, "틀렸어요"에서 고른 결과(누가 골랐는지는 안 남아요), 감사 기록(가명 ID · 시각 · 동작 종류 · 결과, 내용
          없음).
        </p>
        <p>남기지 않는 것: 묻기에 쓴 문장</p>
      </section>

      <div className="actions">
        <button type="button" className="secondary" onClick={() => setConfirmAll(true)}>
          모든 기기 로그아웃
        </button>
        <button type="button" className="secondary" onClick={() => logout(false)}>
          로그아웃
        </button>
      </div>

      {confirmAll && (
        <Sheet title="모든 기기 로그아웃" onClose={() => setConfirmAll(false)}>
          <p>모든 기기에서 로그아웃되고, 연결된 AI 앱도 모두 끊겨요. 다시 쓰려면 회사 계정으로 로그인해요.</p>
          <button type="button" className="primary" onClick={() => logout(true)}>
            모두 로그아웃하기
          </button>
        </Sheet>
      )}
    </div>
  );
}
