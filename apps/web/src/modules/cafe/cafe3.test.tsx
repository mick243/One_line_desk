import { CAFE_TEXT, type CafeMyOrder, type CafeSettleResponse, DEFAULT_OPS_SETTINGS, type HomeAskResponse } from '@one-line-desk/shared';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionHost } from '../../components/ActionHost';
import { BoardOnlyView, boardEnding } from '../../screens/BoardOnly';
import { HomeAnswer } from '../../screens/HomeAnswer';
import { BOARD_LOGIN_HINT, Login } from '../../screens/Login';
import { Mine } from '../../screens/Mine';
import { MISSED_SHEET, MyOrders } from './CafePage';
import { LEFT_HINT, MISSED_HINT, SettleView } from './CafeSettle';

// 사내 카페 3묶음(11/6, ADR-20 예외·ADR-29, PRD F4-1·4·5·13·14). 화면 문구는 docs/화면설계.md "보안이 보이는 문구" 표 그대로예요.

const host = (children: ReactNode) =>
  renderToStaticMarkup(
    <ActionHost onNavigate={() => undefined} inviteChannels={{ calendar: null, slack: null }}>
      {children}
    </ActionHost>,
  );

describe('[ADR-20] 카운터 기기의 카페 판 전용 로그인·화면', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[F4-4] 카페가 켜져 있을 때만 로그인 화면에 [카페 판으로 로그인]이 보여요', () => {
    vi.stubGlobal('window', { location: { search: '', pathname: '/' } });
    const draw = (cafeBoard: boolean, kind: 'mock' | 'oidc') =>
      renderToStaticMarkup(<Login onLoggedIn={() => undefined} login={kind === 'mock' ? { kind } : { kind, label: '회사 계정' }} cafeBoard={cafeBoard} />);
    for (const kind of ['mock', 'oidc'] as const) {
      expect(draw(true, kind)).toContain('카페 판으로 로그인');
      expect(draw(true, kind)).toContain(BOARD_LOGIN_HINT);
      expect(draw(false, kind)).not.toContain('카페 판으로 로그인');
    }
  });

  it('[F4-4] 판 전용 화면은 탭·알림 없이 카페 판과 [로그아웃]만 그리고, 끝나기 10분 전부터 "곧 로그인이 끝나요" 띠를 보여요', () => {
    const html = renderToStaticMarkup(
      <BoardOnlyView ending onLogout={() => undefined}>
        <p>카페 판 자리</p>
      </BoardOnlyView>,
    );
    expect(html).toContain('곧 로그인이 끝나요. 다시 로그인해 주세요');
    expect(html).toContain('카페 판 자리');
    expect(html).toContain('로그아웃');
    expect(html).not.toMatch(/tabbar|알림|마이 페이지|회의실/);
    expect(
      renderToStaticMarkup(
        <BoardOnlyView ending={false} onLogout={() => undefined}>
          <p>카페 판 자리</p>
        </BoardOnlyView>,
      ),
    ).not.toContain(CAFE_TEXT.boardEnding);
    const end = Date.parse('2026-10-26T22:00:00+09:00');
    expect(boardEnding(end, end - 10 * 60_000 - 1)).toBe(false);
    expect(boardEnding(end, end - 10 * 60_000)).toBe(true);
  });
});

const order = (o: Partial<CafeMyOrder>): CafeMyOrder => ({
  id: '7',
  pickupNo: 3,
  lines: [{ name: '아메리카노', options: ['아이스'], qty: 1 }],
  pickupLabel: '14:00–14:10',
  status: 'ready',
  totalWon: 2000,
  cancellable: false,
  missed: null,
  canReportMissed: true,
  ...o,
});

describe('[F4-5] [못 받았어요]', () => {
  it('[F4-5] 나왔어요·가져감인 오늘 주문에만 [못 받았어요]가 있고, 신고하면 상태 칩으로 바뀌어요', () => {
    const html = host(<MyOrders orders={[order({})]} />);
    expect(html).toContain('>못 받았어요</button>');
    const reported = host(<MyOrders orders={[order({ missed: 'reported', canReportMissed: false })]} />);
    expect(reported).toContain('못 받음 신고함');
    expect(reported).not.toContain('>못 받았어요</button>');
    expect(host(<MyOrders orders={[order({ missed: 'removed', canReportMissed: false })]} />)).toContain('청구에서 뺐어요');
    expect(host(<MyOrders orders={[order({ status: 'waiting', cancellable: true, canReportMissed: false })]} />)).not.toContain('못 받았어요');
    // 확인 시트 문구에는 사유 칸이 없어요.
    expect(MISSED_SHEET.note).toContain('사유는 적지 않아요');
  });

  const settle: CafeSettleResponse = {
    month: '2026-10',
    monthLabel: '10월',
    months: [{ month: '2026-10', label: '10월' }],
    bills: [
      { id: '2', name: '가상 직원 도윤', totalWon: 2000, count: 1, code: 'K7Q4X', dueLabel: '11월 7일(토)', status: 'overdue', paidLabel: null, active: false },
    ],
    summary: { count: 1, totalWon: 2000, paidWon: 0, overdue: 1 },
    requests: [],
    missed: [
      {
        id: '11',
        dayLabel: '11월 6일(금)',
        pickupNo: 4,
        lines: [{ name: '카페라테', options: ['아이스'], qty: 2 }],
        pickupLabel: '14:00–14:10',
        name: '가상 직원 하늘',
        totalWon: 5000,
        status: 'reported',
        reportedLabel: '11월 6일(금) 14:20',
      },
      {
        id: '10',
        dayLabel: '11월 5일(목)',
        pickupNo: 2,
        lines: [{ name: '아메리카노', options: [], qty: 1 }],
        pickupLabel: '10:00–10:10',
        name: '가상 직원 수아',
        totalWon: 2000,
        status: 'removed',
        reportedLabel: '11월 5일(목) 10:30',
      },
    ],
    menu: [],
    salesMonth: '2026-10',
    salesMonthLabel: '10월',
  };

  it('[F4-5] S9 "못 받았어요 확인" 칸: 픽업 번호·메뉴·픽업 칸·이름이 있고, 기다리는 신고에만 [청구에서 빼기]·[그대로 두기]가 있어요', () => {
    const html = host(<SettleView data={settle} onMonth={() => undefined} />);
    for (const t of [
      '못 받았어요 확인',
      MISSED_HINT,
      '가상 직원 하늘 · 11월 6일(금) 픽업 번호 4',
      '카페라테(아이스) × 2',
      '픽업 14:00–14:10',
      '청구에서 뺐어요',
    ])
      expect(html).toContain(t);
    expect(html.match(/>청구에서 빼기<\/button>/g)).toHaveLength(1);
    expect(html.match(/>그대로 두기<\/button>/g)).toHaveLength(1);
  });

  it('[F4-14] 재직 확인에서 빠진 사람의 미납은 "재직 확인 안 됨"과 직접 연락 안내를 보여요(급여·퇴직금 공제 없음)', () => {
    const html = host(<SettleView data={settle} onMonth={() => undefined} />);
    expect(html).toContain('재직 확인 안 됨');
    expect(html).toContain(LEFT_HINT);
    expect(host(<SettleView data={{ ...settle, bills: [{ ...settle.bills[0]!, active: true }] }} onMonth={() => undefined} />)).not.toContain(LEFT_HINT);
  });
});

describe('[F4-13] 홈 채팅 "이번 달 커피값"', () => {
  it('[F4-13] 카드만 있는 내 일 답에는 "해 볼 수 있는 일"을 붙이지 않아요', () => {
    const spend: HomeAskResponse = {
      intent: 'mine',
      period: 'recent',
      kinds: ['cafe'],
      by: 'rule',
      headline: '이번 달 카페 값은 지금까지 5,000원이에요',
      items: [],
      links: [],
      cards: [
        {
          id: 'cafe-spend',
          kind: 'cafeteria',
          label: '안내',
          headline: '이번 달 카페 값은 지금까지 5,000원이에요',
          fields: [],
          evidence: { text: '내 주문 기록과 청구서로 서버가 계산했어요', aiSummarized: false },
          actions: { secondary: [] },
          tail: CAFE_TEXT.spendTail,
        },
      ],
      team: null,
    };
    const html = renderToStaticMarkup(<HomeAnswer answer={spend} onOpen={() => undefined} emptyHint={<p>해 볼 일 자리</p>} cards={<p>카드 자리</p>} />);
    expect(html).toContain('이번 달 카페 값은 지금까지 5,000원이에요');
    expect(html).toContain('카드 자리');
    expect(html).not.toContain('해 볼 일 자리');
  });
});

describe('마이 페이지 "무엇을 남기나요" 카페 줄', () => {
  const draw = (cafeteria: 'on' | 'off') =>
    host(
      <Mine
        me={{ displayName: '가상 직원 하늘', department: '재무팀', floor: '3층', roles: ['employee'], csrfToken: '' }}
        switches={{ modules: { ...DEFAULT_OPS_SETTINGS.modules, cafeteria }, roomsWrite: true, mcp: false, teamSchedule: true, homeAsk: true }}
        onLoggedOut={() => undefined}
        onOpen={() => undefined}
      />,
    );

  it('[ADR-29] 카페가 켜져 있을 때만 화면설계 문구 그대로 보여요', () => {
    expect(CAFE_TEXT.retention).toBe(
      '카페 주문·청구: 취소한 주문과 못 받아 청구에서 뺀 주문은 7일, 나머지는 입금 확인 7일 뒤 지워요. 내 카페 값은 나만 보고, 총무는 입금을 확인할 때만 봐요.',
    );
    expect(draw('on')).toContain(CAFE_TEXT.retention);
    expect(draw('off')).not.toContain('카페 주문·청구');
  });
});
