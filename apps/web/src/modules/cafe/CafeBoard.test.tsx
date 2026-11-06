import { CAFE_TEXT, type CafeBoardResponse } from '@one-line-desk/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BoardView } from './CafeBoard';

// S8 카페 판(11/6, ADR-29). 번호·메뉴·옵션·잔 수·픽업 칸·상태 버튼만 그리고, 이름·금액은 그리지 않아요.

const data: CafeBoardResponse = {
  open: true,
  orders: [
    {
      id: '7',
      pickupNo: 3,
      lines: [{ name: '아메리카노', options: ['아이스', '샷 추가'], qty: 2 }],
      pickupLabel: '09:10–09:20',
      status: 'waiting',
      orderedAt: '09:01',
    },
    { id: '8', pickupNo: 4, lines: [{ name: '카페라테', options: [], qty: 1 }], pickupLabel: '09:20–09:30', status: 'making', orderedAt: '09:02' },
    { id: '9', pickupNo: 5, lines: [{ name: '녹차라테', options: ['핫'], qty: 1 }], pickupLabel: '09:20–09:30', status: 'ready', orderedAt: '09:03' },
  ],
  menu: [
    { id: 'americano', name: '아메리카노', soldOut: false },
    { id: 'latte', name: '카페라테', soldOut: true },
  ],
};

const draw = (d: CafeBoardResponse, open = d.open) =>
  renderToStaticMarkup(
    <BoardView
      data={{ ...d, open }}
      fresh={new Set(['7'])}
      busy={null}
      error={null}
      soundOn={false}
      onOpen={() => undefined}
      onClose={() => undefined}
      onSound={() => undefined}
      onAdvance={() => undefined}
      onSoldOut={() => undefined}
    />,
  );

describe('카페 판 그리기', () => {
  it('번호·메뉴·옵션·잔 수·픽업 칸과 다음 상태 버튼([받기]·[다 됐어요]·[가져갔어요])을 그리고, 판 머리 문구가 있어요', () => {
    const html = draw(data);
    expect(html).toContain(CAFE_TEXT.boardHead);
    for (const text of [
      '아메리카노',
      '아이스·샷 추가',
      '× 2',
      '09:10–09:20',
      '받기',
      '다 됐어요',
      '가져갔어요',
      '영업 중',
      '영업 끝',
      '다시 팔기',
      '품절로 바꾸기',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('aria-label="픽업 번호 3"');
    expect(html).toContain('fresh');
    expect(draw(data, false)).toContain('영업 시작');
  });

  it('[F4 완료 기준] 응답에 이름·금액이 섞여 와도 판에는 이름·가명 ID·금액이 나오지 않아요', () => {
    const leaky = {
      ...data,
      orders: data.orders.map((o) => ({ ...o, displayName: '가상 직원 하늘', pseudonymId: 'p_secret', totalWon: 4000, priceWon: 2000 })),
      menu: data.menu.map((m) => ({ ...m, priceWon: 2000 })),
    } as unknown as CafeBoardResponse;
    const html = draw(leaky);
    for (const secret of ['가상 직원', '하늘', 'p_secret', '4000', '4,000', '2000', '2,000', '원']) expect(html).not.toContain(secret);
  });
});
