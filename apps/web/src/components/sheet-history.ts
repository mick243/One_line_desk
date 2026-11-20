// 바닥 시트와 방문 기록(11/11 QA P1·U1). 열린 시트마다 방문 기록을 하나 더해서, 휴대폰·브라우저 뒤로 가기가
// 아래 페이지를 바꾸지 않고 맨 위 시트만 닫게 해요(PRD 접근성 "뒤로 가기 한 번이면 닫혀요", 화면설계 S2).
// 기록에는 지금 기록 값(페이지 이름)과 시트 수만 넣어요. 쓰던 글은 넣지 않아요(R13).
//
// 시트 기록 줄 수(entries)를 열린 시트 수에 맞춰요. 시트가 닫히고 바로 다음 시트가 열리는 일(확인 시트 → 결과 시트)이 잦아서
// 열고 닫을 때마다 바로 기록을 바꾸지 않고, 한 번에 모아 맞춰요(뒤로 가기 history.go가 비동기라 섞이지 않게).

export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  go(delta: number): void;
}

interface OpenSheet {
  /** 사람이 닫으려 할 때(쓴 글이 있으면 먼저 물어요). 닫지 않을 수도 있어요. */
  requestClose: () => void;
}

export const isSheetEntry = (state: unknown): boolean => typeof (state as { deskSheet?: unknown } | null)?.deskSheet === 'number';

export function createSheetHistory(env: { history: () => HistoryLike; href: () => string; defer: (fn: () => void) => void }) {
  const open: OpenSheet[] = [];
  let entries = 0;
  /** 기록을 줄이려고 우리가 부른 뒤로 가기 수. 그 popstate는 시트·페이지 모두 무시해요. */
  let ignoring = 0;
  let scheduled = false;
  /** 시트가 처리한 popstate. App의 페이지 뒤로 가기가 같은 이벤트를 무시하려고 봐요. */
  let handled: unknown = null;

  function reconcile() {
    scheduled = false;
    const h = env.history();
    // 시트가 열린 채 다른 페이지로 옮겨 페이지 줄이 맨 위면, 묻힌 시트 줄은 두고 새로 세요.
    if (entries > 0 && !isSheetEntry(h.state)) entries = 0;
    if (entries < open.length) {
      for (; entries < open.length; entries++) h.pushState({ ...((h.state as object | null) ?? {}), deskSheet: entries + 1 }, '', env.href());
    } else if (entries > open.length) {
      const extra = entries - open.length;
      entries = open.length;
      ignoring++;
      h.go(-extra);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    env.defer(reconcile);
  }

  return {
    /** 시트가 열렸어요. 돌려준 함수는 시트가 닫혀 화면에서 빠질 때 불러요. */
    opened(sheet: OpenSheet): () => void {
      open.push(sheet);
      schedule();
      return () => {
        const i = open.indexOf(sheet);
        if (i >= 0) open.splice(i, 1);
        schedule();
      };
    },
    /** popstate. 시트 기록 줄을 지난 뒤로 가기면 맨 위 시트만 닫고(닫히지 않으면 다음 맞추기에서 줄을 다시 더해요) 처리했다고 적어요. */
    onPop(e: unknown): void {
      if (ignoring > 0) {
        ignoring--;
        handled = e;
        return;
      }
      if (entries === 0 || open.length === 0) return;
      entries--;
      handled = e;
      open.at(-1)!.requestClose();
      schedule();
    },
    handled: (e: unknown): boolean => handled === e,
    atSheetEntry: (): boolean => isSheetEntry(env.history().state),
  };
}
