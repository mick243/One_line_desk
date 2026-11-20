import { describe, expect, it } from 'vitest';
import { createSheetHistory, type HistoryLike } from './sheet-history';

// 뒤로 가기로 맨 위 시트만 닫기(11/11 QA P1·U1). 브라우저 기록을 흉내 낸 가짜로 봐요.

/** 기록 줄과 지금 자리. go는 바로 옮기고 popstate를 쌓아 둬요(브라우저처럼 나중에 알려요). */
function fakeHistory() {
  const list: unknown[] = [{ deskView: 'rooms' }];
  let at = 0;
  const pops: { state: unknown }[] = [];
  const history: HistoryLike = {
    get state() {
      return list[at];
    },
    pushState(data) {
      list.splice(at + 1);
      list.push(data);
      at = list.length - 1;
    },
    go(delta) {
      at = Math.max(0, Math.min(list.length - 1, at + delta));
      pops.push({ state: list[at] });
    },
  };
  /** 사람이 뒤로 가기를 눌렀어요 */
  const back = () => history.go(-1);
  return { history, list, back, pops, at: () => at };
}

function setup() {
  const h = fakeHistory();
  const tasks: (() => void)[] = [];
  const sheets = createSheetHistory({ history: () => h.history, href: () => '/', defer: (fn) => tasks.push(fn) });
  /** 미뤄 둔 기록 맞추기와 쌓인 popstate를 차례로 처리해요. 처리하지 않은(페이지로 간) popstate를 돌려줘요. */
  const flush = () => {
    const toPage: unknown[] = [];
    for (let guard = 0; guard < 20 && (tasks.length || h.pops.length); guard++) {
      while (tasks.length) tasks.shift()!();
      while (h.pops.length) {
        const e = h.pops.shift()!;
        sheets.onPop(e);
        if (!sheets.handled(e)) toPage.push(e.state);
      }
    }
    return toPage;
  };
  return { h, sheets, flush };
}

describe('시트 방문 기록', () => {
  it('시트를 열면 기록이 하나 늘고, 뒤로 가기 한 번이면 시트만 닫히고 페이지는 그대로예요', () => {
    const { h, sheets, flush } = setup();
    let closed = 0;
    let left = () => {};
    left = sheets.opened({ requestClose: () => (closed++, left()) });
    flush();
    expect(h.list).toHaveLength(2);
    expect(h.history.state).toEqual({ deskView: 'rooms', deskSheet: 1 });
    h.back();
    expect(flush()).toEqual([]);
    expect(closed).toBe(1);
    expect(h.history.state).toEqual({ deskView: 'rooms' });
  });

  it('[닫기]로 닫으면 더한 기록 줄을 거둬서, 다음 뒤로 가기는 앞 페이지로 가요', () => {
    const { h, sheets, flush } = setup();
    const left = sheets.opened({ requestClose: () => {} });
    flush();
    left();
    expect(flush()).toEqual([]);
    expect(h.history.state).toEqual({ deskView: 'rooms' });
    expect(h.at()).toBe(0);
  });

  it('시트 위 시트: 뒤로 가기는 맨 위 시트만 닫아요', () => {
    const { sheets, h, flush } = setup();
    const closed: string[] = [];
    const lower = { requestClose: () => (closed.push('아래'), leftLower()) };
    const leftLower = sheets.opened(lower);
    const upper = { requestClose: () => (closed.push('위'), leftUpper()) };
    const leftUpper = sheets.opened(upper);
    flush();
    expect(h.history.state).toMatchObject({ deskSheet: 2 });
    h.back();
    flush();
    expect(closed).toEqual(['위']);
    h.back();
    flush();
    expect(closed).toEqual(['위', '아래']);
    expect(h.history.state).toEqual({ deskView: 'rooms' });
  });

  it('쓴 글을 물어 닫지 않으면(또는 실행 중이면) 기록 줄을 다시 더해서 다음 뒤로 가기도 시트가 받아요', () => {
    const { sheets, h, flush } = setup();
    let asked = 0;
    sheets.opened({ requestClose: () => asked++ });
    flush();
    h.back();
    expect(flush()).toEqual([]);
    expect(asked).toBe(1);
    expect(h.history.state).toMatchObject({ deskSheet: 1 });
    h.back();
    expect(flush()).toEqual([]);
    expect(asked).toBe(2);
  });

  it('확인 시트가 닫히고 바로 결과 시트가 열리면 기록 줄 하나를 그대로 써요', () => {
    const { sheets, h, flush } = setup();
    const leftConfirm = sheets.opened({ requestClose: () => {} });
    flush();
    leftConfirm();
    sheets.opened({ requestClose: () => {} });
    expect(flush()).toEqual([]);
    expect(h.list).toHaveLength(2);
    expect(h.history.state).toMatchObject({ deskSheet: 1 });
  });

  it('시트가 없을 때 뒤로 가기는 페이지가 받아요', () => {
    const { sheets, h, flush } = setup();
    h.history.pushState({ deskView: 'navi' }, '', '/');
    h.back();
    expect(flush()).toEqual([{ deskView: 'rooms' }]);
    expect(sheets.atSheetEntry()).toBe(false);
  });
});
