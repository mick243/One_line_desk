// 카운터 기기의 카페 판 전용 화면(S8, 11/6 3묶음, 사용자 결정, ADR-20 예외·ADR-29).
// [카페 판으로 로그인]으로 들어온 세션은 카페 판 권한만 있어서, 탭·알림·다른 페이지 없이 카페 판만 전체 화면으로 그려요.
// 서버도 허용 목록 밖 경로는 403이에요(core/board-session.ts). 쉬어도 끊기지 않고 로그인부터 정해진 시간(기본 13시간) 뒤 끊겨요.
// 끝나기 10분 전부터 "곧 로그인이 끝나요. 다시 로그인해 주세요" 띠를 보여요. 끊기면(401) 앱이 로그인 화면으로 돌아가요.
import { CAFE_LIMITS, CAFE_TEXT } from '@one-line-desk/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../api';
import { webModules } from '../modules/registry';

/** 띠를 보일 때인지: 끝나는 때까지 10분 이하로 남았어요. */
export function boardEnding(deadline: number, now: number): boolean {
  return deadline - now <= CAFE_LIMITS.boardWarnMs;
}

const TICK_MS = 30_000;

export function BoardOnly({ leftMs, onLoggedOut }: { leftMs: number; onLoggedOut: () => void }) {
  // 서버가 준 남은 시간으로 끝나는 때를 셈해요(브라우저 시계가 서버와 달라도 맞아요).
  const [deadline] = useState(() => Date.now() + leftMs);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  async function logout() {
    await api.logout(false);
    onLoggedOut();
  }

  return (
    <BoardOnlyView ending={boardEnding(deadline, now)} onLogout={() => void logout()}>
      <webModules.CafeBoard />
    </BoardOnlyView>
  );
}

/** 판 전용 화면 틀(시험이 바로 그려요): 위 막대(이름·[로그아웃]) → 끝나기 전 띠 → 카페 판 */
export function BoardOnlyView({ ending, onLogout, children }: { ending: boolean; onLogout: () => void; children: ReactNode }) {
  return (
    <>
      <div className='app-bar'>
        <span className='brand'>한 줄 데스크 · 카페 판</span>
        <button type='button' className='neutral small' onClick={onLogout}>
          로그아웃
        </button>
      </div>
      {ending && (
        <p className='notice-line' role='alert'>
          {CAFE_TEXT.boardEnding}
        </p>
      )}
      <main className='screen board-only'>{children}</main>
    </>
  );
}
