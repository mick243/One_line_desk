import { CAFE_TEXT, type CafeMyBilling, type CafeSettleResponse, DEFAULT_OPS_SETTINGS } from '@one-line-desk/shared';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Me } from '../../api';
import { ActionHost } from '../../components/ActionHost';
import { Mine } from '../../screens/Mine';
import { MyBilling } from './CafePage';
import { CafeSettle, SettleView } from './CafeSettle';

// S7 내 청구 · S9 카페 정산(11/6 2묶음, ADR-29). 화면 문구는 docs/화면설계.md "보안이 보이는 문구" 표 그대로예요.

const host = (children: ReactNode) =>
  renderToStaticMarkup(
    <ActionHost onNavigate={() => undefined} inviteChannels={{ calendar: null, slack: null }}>
      {children}
    </ActionHost>,
  );

const settle: CafeSettleResponse = {
  month: '2026-10',
  monthLabel: '10월',
  months: [
    { month: '2026-11', label: '11월' },
    { month: '2026-10', label: '10월' },
  ],
  bills: [
    { id: '2', name: '가상 직원 도윤', totalWon: 2000, count: 1, code: 'K7Q4X', dueLabel: '11월 7일(토)', status: 'overdue', paidLabel: null, active: true },
    {
      id: '1',
      name: '가상 직원 하늘',
      totalWon: 8000,
      count: 2,
      code: 'M3P9A',
      dueLabel: '11월 7일(토)',
      status: 'paid',
      paidLabel: '11월 3일(화) 10:00',
      active: true,
    },
  ],
  summary: { count: 2, totalWon: 10_000, paidWon: 8000, overdue: 1 },
  requests: [
    {
      id: '5',
      name: '가상 직원 하늘',
      monthLabel: '11월',
      amountWon: 600_000,
      limitWon: 500_000,
      status: 'pending',
      createdLabel: '11월 8일(일) 09:00',
      current: true,
    },
    {
      id: '4',
      name: '가상 직원 도윤',
      monthLabel: '10월',
      amountWon: 650_000,
      limitWon: 500_000,
      status: 'pending',
      createdLabel: '10월 31일(토) 09:00',
      current: false,
    },
  ],
  missed: [],
  menu: [{ id: 'latte', name: '카페라테', priceWon: 2500, options: ['아이스', '핫'], soldOut: false, active: true }],
  salesMonth: '2026-10',
  salesMonthLabel: '10월',
};

describe('S9 카페 정산(총무)', () => {
  it('머리 문구로 접속기록에 남는다고 알려요', () => {
    expect(host(<CafeSettle onBack={() => undefined} />)).toContain(CAFE_TEXT.settleHead);
  });

  it('청구 목록(이름·청구액·입금 코드·상태)과 미납 줄에만 [입금 확인], 이번 달 대기 요청에만 [늘려 주기]가 있어요', () => {
    const html = host(<SettleView data={settle} onMonth={() => undefined} />);
    for (const t of ['가상 직원 도윤', '가상 직원 하늘', 'K7Q4X', 'M3P9A', '2,000원', '8,000원', '기한 지남', '입금 확인']) expect(html).toContain(t);
    expect(html.match(/>입금 확인<\/button>/g)).toHaveLength(1);
    expect(html.match(/>늘려 주기<\/button>/g)).toHaveLength(1);
    expect(html.match(/>안 돼요<\/button>/g)).toHaveLength(2);
    expect(html).toContain('지난달 요청이라 늘릴 수 없어요');
  });

  it('[지난달 매출 합계 내려받기]와 7일 안에 내려받으라는 안내가 있고, 메뉴·직원가를 고칠 수 있어요', () => {
    const html = host(<SettleView data={settle} onMonth={() => undefined} />);
    expect(html).toContain('지난달 매출 합계 내려받기');
    expect(html).toContain('href="/api/cafe/sales.csv?month=2026-10"');
    expect(html).toContain(CAFE_TEXT.salesNote);
    expect(html).toContain('value="카페라테"');
    expect(html).toContain('value="아이스, 핫"');
    expect(html).toContain('메뉴 더하기');
  });
});

const billing: CafeMyBilling = {
  limitWon: 500_000,
  leftWon: 495_000,
  blocked: false,
  bills: [
    {
      id: '1',
      month: '2026-10',
      monthLabel: '10월',
      totalWon: 8000,
      count: 2,
      code: 'M3P9A',
      dueLabel: '11월 7일(토)',
      status: 'unpaid',
      orders: [
        { dayLabel: '10월 26일(월)', lines: [{ name: '카페라테', options: [], qty: 2 }], totalWon: 5000 },
        { dayLabel: '10월 26일(월)', lines: [{ name: '바닐라라테', options: ['샷 추가'], qty: 1 }], totalWon: 3000 },
      ],
    },
  ],
  account: '계좌는 총무에게 물어봐 주세요',
  dueDays: 7,
  request: null,
};

describe('S7 내 청구(본인만)', () => {
  it('내 청구 문구, 이번 달 지금까지·남은 한도, 청구서(합계·입금 코드·기한·계좌 안내·건별 내역)를 보여 줘요', () => {
    const html = host(<MyBilling monthTotalWon={5000} billing={billing} onAsk={() => undefined} />);
    for (const t of [
      CAFE_TEXT.myBill,
      '이번 달 지금까지 5,000원',
      '남은 한도 495,000원',
      '10월 카페 값 8,000원',
      'M3P9A',
      '11월 7일(토)까지',
      '계좌는 총무에게 물어봐 주세요',
      '건별 내역 2건',
      '바닐라라테(샷 추가) × 1',
      '입금 전',
      '한도 늘려 달라고 하기',
    ])
      expect(html).toContain(t);
  });

  it('한도 요청을 기다리는 동안에는 [한도 늘려 달라고 하기]를 다시 보이지 않아요', () => {
    const html = host(<MyBilling monthTotalWon={5000} billing={{ ...billing, request: { amountWon: 600_000, status: 'pending' } }} onAsk={() => undefined} />);
    expect(html).toContain('이번 달 한도를 600,000원으로 늘려 달라고 했어요');
    expect(html).not.toContain('한도 늘려 달라고 하기</button>');
  });
});

describe('마이 페이지 > 내 역할 > [카페 정산]', () => {
  const draw = (roles: Me['roles'], cafeteria: 'on' | 'off') =>
    host(
      <Mine
        me={{ displayName: '가상 총무 서연', department: '총무팀', floor: '2층', roles, csrfToken: '' }}
        switches={{ modules: { ...DEFAULT_OPS_SETTINGS.modules, cafeteria }, roomsWrite: true, mcp: false, teamSchedule: true, homeAsk: true }}
        onLoggedOut={() => undefined}
        onOpen={() => undefined}
      />,
    );

  it('총무이고 카페가 켜져 있을 때만 보여요', () => {
    expect(draw(['employee', 'facilities'], 'on')).toContain('총무 · 카페 정산');
    expect(draw(['employee', 'facilities'], 'off')).not.toContain('카페 정산');
    expect(draw(['employee'], 'on')).not.toContain('카페 정산');
  });
});
