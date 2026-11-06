import {
  CAFE_LIMITS,
  CAFE_STATUS_LABEL,
  CAFE_TEXT,
  type CafeMenuItem,
  type CafeMyOrder,
  type CafeProposeResponse,
  type CafeResponse,
  wonText,
} from '@one-line-desk/shared';
import { useEffect, useRef, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { useActions, useListVersion } from '../../components/ActionHost';
import { CardView } from '../../components/CardView';
import { linkSummary } from '../../screens/features';
import './cafe.css';

// S7 카페 주문(직원, F4 1묶음, ADR-29). 영업 띠 → 메뉴(옵션 칩·수량) → 픽업 칸 → [주문하기](확인 시트) → 오늘 내 주문 → 이번 달 지금까지.
// 금액은 서버가 메뉴 직원가로 계산해요. 화면은 메뉴 ID·잔 수·옵션 이름·픽업 칸만 보내요.
// 고른 것은 이 페이지 메모리에만 있어요(R13). 내 청구·한도는 다음 묶음이에요.

/** 바리스타가 영업을 시작했는지 등을 따라가려고 가끔 다시 불러요(사람이 누른 게 아니라 쉬는 시간을 늘리지 않아요, ADR-20). */
const REFRESH_MS = 30_000;

type Chosen = { qty: number; options: string[] };

/** 메뉴 한 줄 글 "아메리카노(아이스·연하게) × 2" */
const lineText = (l: { name: string; options: string[]; qty: number }) => `${l.name}${l.options.length ? `(${l.options.join('·')})` : ''} × ${l.qty}`;

export function CafePage() {
  const actions = useActions();
  const { version, background } = useListVersion();
  const [data, setData] = useState<CafeResponse | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [tick, setTick] = useState(0);
  const lastTick = useRef(0);
  const [picks, setPicks] = useState<Record<string, Chosen>>({});
  const [slot, setSlot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // 새 알림(폴링)으로 다시 부르거나 30초마다 다시 부를 때는 배경 요청이에요.
    const bg = background();
    const quiet = tick !== lastTick.current || bg;
    lastTick.current = tick;
    apiRequest<CafeResponse>('GET', '/api/cafe', undefined, { background: quiet })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setFailed(null);
      })
      .catch((e: unknown) => {
        if (alive) setFailed(e instanceof ApiFailure ? e.message : '카페를 불러오지 못했어요');
      });
    return () => {
      alive = false;
    };
  }, [version, retry, tick]);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  // 내 쓰기(주문·취소)가 끝나면 고른 것을 비워요.
  useEffect(() => {
    setPicks({});
    setSlot(null);
    setError(null);
  }, [actions.writes]);

  // 고른 칸이 지나가거나 꽉 차면 다시 고르게 해요.
  const on = data?.status === 'on' ? data : null;
  useEffect(() => {
    if (slot && on && !on.slots.some((s) => s.start === slot && !s.full)) setSlot(null);
  }, [on, slot]);

  if (failed && !data) {
    return (
      <div className='feature-page cafe-page'>
        <CafeHead />
        <p className='empty'>{failed}</p>
        <button type='button' className='secondary small' onClick={() => setRetry((n) => n + 1)}>
          다시 불러오기
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className='feature-page cafe-page'>
        <CafeHead />
        <div className='skeleton' aria-label='불러오는 중' />
      </div>
    );
  }
  if (data.status === 'link') {
    return (
      <div className='feature-page cafe-page'>
        <CafeHead lead={linkSummary('cafeteria')} />
        <CardView card={data.card} onAction={(a) => actions.run(a)} />
      </div>
    );
  }

  const chosen = Object.entries(picks).filter(([, p]) => p.qty > 0);
  const lineCount = chosen.length;
  const menuById = new Map(data.menu.map((m) => [m.id, m]));
  const total = chosen.reduce((sum, [id, p]) => sum + (menuById.get(id)?.priceWon ?? 0) * p.qty, 0);
  const canOrder = data.open && lineCount > 0 && slot !== null && !busy;

  function setQty(m: CafeMenuItem, qty: number) {
    setError(null);
    setPicks((all) => ({ ...all, [m.id]: { qty, options: all[m.id]?.options ?? [] } }));
  }
  function toggleOption(m: CafeMenuItem, option: string) {
    setError(null);
    setPicks((all) => {
      const cur = all[m.id] ?? { qty: 0, options: [] };
      const options = cur.options.includes(option) ? cur.options.filter((o) => o !== option) : [...cur.options, option];
      // 옵션을 고르면 한 잔은 고른 것으로 쳐요.
      return { ...all, [m.id]: { qty: Math.max(cur.qty, 1), options } };
    });
  }

  async function order() {
    if (!canOrder || !slot) return;
    setBusy(true);
    setError(null);
    try {
      const body = { lines: chosen.map(([menuId, p]) => ({ menuId, qty: p.qty, options: p.options })), pickupSlot: slot };
      const { proposalToken } = await apiRequest<CafeProposeResponse>('POST', '/api/cafe/order/propose', body);
      // 기존 확인 시트 흐름: 서버가 plan을 만들어 시트를 주고, [주문하기]가 planId만 보내요(ADR-03).
      await actions.run({ type: 'propose', text: '주문하기', proposalToken });
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금 주문하지 못했어요');
      actions.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className='feature-page cafe-page'>
      <CafeHead />
      <p className={data.open ? 'cafe-band open' : 'cafe-band closed'} role='status'>
        {data.open ? CAFE_TEXT.open : CAFE_TEXT.closed}
      </p>

      <section className='card cafe-menu' aria-label='메뉴'>
        <h2>메뉴</h2>
        <ul className='cafe-menu-list'>
          {data.menu.map((m) => {
            const p = picks[m.id];
            const qty = p?.qty ?? 0;
            const full = qty === 0 && lineCount >= CAFE_LIMITS.maxLines;
            return (
              <li key={m.id} className={m.soldOut ? 'cafe-menu-row sold-out' : 'cafe-menu-row'}>
                <div className='cafe-menu-name'>
                  <strong>{m.name}</strong>
                  <span className='cafe-price'>{wonText(m.priceWon)}</span>
                  {m.soldOut && <span className='chip'>품절</span>}
                </div>
                {!m.soldOut && (
                  <>
                    {m.options.length > 0 && (
                      <div className='chips' aria-label={`${m.name} 옵션`}>
                        {m.options.map((o) => {
                          const active = p?.options.includes(o) ?? false;
                          return (
                            <button
                              key={o}
                              type='button'
                              className={active ? 'chip selected' : 'chip'}
                              aria-pressed={active}
                              disabled={full}
                              onClick={() => toggleOption(m, o)}
                            >
                              {o}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div className='cafe-qty' aria-label={`${m.name} 잔 수`}>
                      <button
                        type='button'
                        className='neutral small'
                        aria-label={`${m.name} 한 잔 빼기`}
                        disabled={qty === 0}
                        onClick={() => setQty(m, qty - 1)}
                      >
                        −
                      </button>
                      <span aria-live='polite'>{qty}잔</span>
                      <button
                        type='button'
                        className='secondary small'
                        aria-label={`${m.name} 한 잔 더하기`}
                        disabled={qty >= CAFE_LIMITS.maxQty || full}
                        onClick={() => setQty(m, qty + 1)}
                      >
                        +
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {lineCount >= CAFE_LIMITS.maxLines && <p className='hint'>한 번에 {CAFE_LIMITS.maxLines}가지 메뉴까지 골라요.</p>}
      </section>

      <section className='card' aria-label='픽업 시간'>
        <h2>언제 가져갈까요?</h2>
        <p className='hint'>10분 칸마다 받을 수 있는 잔 수가 정해져 있어요. 꽉 찬 칸은 고를 수 없어요.</p>
        <div className='chips cafe-slots'>
          {data.slots.map((s) => (
            <button
              key={s.start}
              type='button'
              className={slot === s.start ? 'chip selected' : 'chip'}
              aria-pressed={slot === s.start}
              disabled={s.full}
              onClick={() => {
                setError(null);
                setSlot(s.start);
              }}
            >
              {s.label}
              {s.full && ' 꽉 참'}
            </button>
          ))}
        </div>
      </section>

      <div className='cafe-order-bar'>
        {lineCount > 0 && <p className='cafe-total'>합계 {wonText(total)}</p>}
        {error && (
          <p className='lock-line' role='alert'>
            {error}
          </p>
        )}
        <button type='button' className='primary' disabled={!canOrder} onClick={() => void order()}>
          {busy ? '주문하는 중' : '주문하기'}
        </button>
        {!data.open && <p className='hint'>{CAFE_TEXT.closed}</p>}
      </div>

      <MyOrders orders={data.orders} />

      <section className='card' aria-label='이번 달 카페 값'>
        <h2>이번 달 지금까지 {wonText(data.monthTotalWon)}</h2>
        <p className='hint'>취소한 주문은 빼고 셌어요.</p>
      </section>
    </div>
  );
}

function CafeHead({ lead }: { lead?: string }) {
  return (
    <header className='page-head'>
      <p className='eyebrow'>카페</p>
      <h1>무엇을 마실까요?</h1>
      <p className='lead'>{lead ?? '사내 카페에 주문하고 픽업 번호로 받아요. 값은 직원가예요.'}</p>
    </header>
  );
}

/** 오늘 내 주문(픽업 번호·상태). 접수 대기면 [취소](확인 시트 뒤)예요. */
function MyOrders({ orders }: { orders: CafeMyOrder[] }) {
  const actions = useActions();
  return (
    <section className='card' aria-label='오늘 내 주문'>
      <h2>오늘 내 주문</h2>
      {orders.length === 0 && <p className='empty'>오늘 주문이 없어요</p>}
      <ul className='cafe-my-orders'>
        {orders.map((o) => (
          <li key={o.id} className={o.status === 'ready' ? 'cafe-my-order ready' : 'cafe-my-order'}>
            <span className='cafe-no' aria-label={`픽업 번호 ${o.pickupNo}`}>
              {o.pickupNo}
            </span>
            <div className='cafe-my-order-body'>
              <strong>{o.lines.map(lineText).join(' · ')}</strong>
              <span className='hint'>
                픽업 {o.pickupLabel} · {wonText(o.totalWon)}
              </span>
            </div>
            <span className='chip'>{CAFE_STATUS_LABEL[o.status]}</span>
            {o.cancellable && (
              <button
                type='button'
                className='neutral small'
                onClick={() =>
                  void actions.run({
                    type: 'fixed',
                    text: '취소',
                    method: 'POST',
                    path: `/api/cafe/orders/${o.id}/cancel`,
                    confirm: {
                      title: '이 주문을 취소할까요?',
                      lines: [`픽업 번호 ${o.pickupNo}`, o.lines.map(lineText).join(' · ')],
                      confirmLabel: '취소하기',
                      note: '카페가 받기 전(접수 대기)까지만 취소할 수 있어요',
                    },
                  })
                }
              >
                취소
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
