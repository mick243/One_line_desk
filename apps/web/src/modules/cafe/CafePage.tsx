import {
  CAFE_BILL_STATUS_LABEL,
  CAFE_BILLING_LIMITS,
  CAFE_LIMITS,
  CAFE_MISSED_LABEL,
  CAFE_STATUS_LABEL,
  CAFE_TEXT,
  type CafeBill,
  cafeLimitText,
  type CafeMenuItem,
  type CafeMyBilling,
  type CafeMyOrder,
  type CafeProposeResponse,
  type CafeResponse,
  wonText,
} from '@one-line-desk/shared';
import { useEffect, useRef, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { useActions, useListVersion } from '../../components/ActionHost';
import { CardView } from '../../components/CardView';
import { Sheet } from '../../components/Sheet';
import { linkSummary } from '../../screens/features';
import './cafe.css';

// S7 카페 주문(직원, F4, ADR-29). 영업 띠(미납이면 막힘 띠와 청구서) → 메뉴(옵션 칩·수량) → 픽업 칸 → [주문하기](확인 시트)
// → 오늘 내 주문 → 내 청구(이번 달 지금까지·남은 한도·지난 청구서) → [한도 늘려 달라고 하기].
// 금액·한도는 서버가 계산해요. 화면은 메뉴 ID·잔 수·옵션 이름·픽업 칸, 한도 요청 금액만 보내요.
// 고른 것·적은 금액은 이 페이지 메모리에만 있어요(R13). 내 청구는 나만 보여요(총무는 입금을 확인할 때만 봐요).

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
  const [asking, setAsking] = useState(false);

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
  const { billing } = data;
  // 미납(기한 지남)이면 막히고, 고른 합계가 남은 한도를 넘으면 막혀요. 서버도 제안·확인 시트·실행에서 다시 막아요.
  const overLimit = total > billing.leftWon;
  const canOrder = data.open && !billing.blocked && !overLimit && lineCount > 0 && slot !== null && !busy;

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
      {billing.blocked && <UnpaidBlock billing={billing} />}

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
        <p className='cafe-left'>
          이번 달 지금까지 {wonText(data.monthTotalWon)} · 남은 한도 {wonText(billing.leftWon)}
        </p>
        {overLimit && !billing.blocked && (
          <>
            <p className='lock-line' role='alert'>
              {cafeLimitText(billing.limitWon)}
            </p>
            {billing.request?.status !== 'pending' && (
              <button type='button' className='secondary' onClick={() => setAsking(true)}>
                한도 늘려 달라고 하기
              </button>
            )}
          </>
        )}
        {error && (
          <p className='lock-line' role='alert'>
            {error}
          </p>
        )}
        <button type='button' className='primary' disabled={!canOrder} onClick={() => void order()}>
          {busy ? '주문하는 중' : '주문하기'}
        </button>
        {!data.open && <p className='hint'>{CAFE_TEXT.closed}</p>}
        {billing.blocked && <p className='hint'>{CAFE_TEXT.unpaid}</p>}
      </div>

      <MyOrders orders={data.orders} />

      <MyBilling monthTotalWon={data.monthTotalWon} billing={billing} onAsk={() => setAsking(true)} />

      {asking && (
        <LimitAskSheet
          billing={billing}
          need={data.monthTotalWon + total}
          onClose={() => setAsking(false)}
          onSent={() => {
            setAsking(false);
            // 고른 메뉴는 그대로 두고 내 청구만 다시 불러요.
            actions.reload();
          }}
        />
      )}
    </div>
  );
}

/** 미납 막힘(8일부터, ADR-29): 주문 위에 막힘 띠와 기한 지난 청구서를 보여 줘요. */
function UnpaidBlock({ billing }: { billing: CafeMyBilling }) {
  return (
    <section className='card cafe-blocked' aria-label='미납 막힘'>
      <p className='cafe-band blocked' role='alert'>
        {CAFE_TEXT.unpaid}
      </p>
      <ul className='cafe-bills'>
        {billing.bills
          .filter((b) => b.status === 'overdue')
          .map((b) => (
            <BillCard key={b.id} bill={b} account={billing.account} />
          ))}
      </ul>
    </section>
  );
}

/** 내 청구(본인만): 이번 달 지금까지·남은 한도, 지난 청구서, 한도 요청 상태, [한도 늘려 달라고 하기] */
export function MyBilling({ monthTotalWon, billing, onAsk }: { monthTotalWon: number; billing: CafeMyBilling; onAsk: () => void }) {
  // 미납 막힘 칸에 이미 보인 청구서는 여기서 빼요.
  const bills = billing.blocked ? billing.bills.filter((b) => b.status !== 'overdue') : billing.bills;
  const request = billing.request;
  return (
    <section className='card' aria-label='내 청구'>
      <h2>내 청구</h2>
      <p className='hint'>{CAFE_TEXT.myBill}</p>
      <p>
        <strong>이번 달 지금까지 {wonText(monthTotalWon)}</strong> · 남은 한도 {wonText(billing.leftWon)}
      </p>
      <p className='hint'>
        이번 달 한도 {wonText(billing.limitWon)} · 취소한 주문은 빼고 셌어요. 한 달치를 모아 다음 달 1일에 청구하고, {billing.dueDays}일 안에 회사 계좌로 보내
        주세요.
      </p>
      {bills.length > 0 && (
        <ul className='cafe-bills'>
          {bills.map((b) => (
            <BillCard key={b.id} bill={b} account={billing.account} />
          ))}
        </ul>
      )}
      {!billing.blocked && bills.length === 0 && <p className='empty'>지난 청구서가 없어요</p>}
      {request?.status === 'pending' && (
        <p className='hint'>이번 달 한도를 {wonText(request.amountWon)}으로 늘려 달라고 했어요. 총무가 처리하면 알려 드려요.</p>
      )}
      {request?.status === 'approved' && <p className='hint'>총무가 이번 달 한도를 늘려 줬어요. 다음 달에는 원래 한도로 돌아가요.</p>}
      {request?.status === 'rejected' && <p className='hint'>이번 달 한도 요청이 반려됐어요.</p>}
      {request?.status !== 'pending' && (
        <div className='actions'>
          <button type='button' className='secondary' onClick={onAsk}>
            한도 늘려 달라고 하기
          </button>
        </div>
      )}
    </section>
  );
}

/** 청구서 한 장: 달·합계·상태·입금 코드·기한·회사 계좌 안내·건별 내역(접기) */
function BillCard({ bill, account }: { bill: CafeBill; account: string }) {
  return (
    <li className={`cafe-bill status-${bill.status}`}>
      <div className='cafe-bill-head'>
        <strong>
          {bill.monthLabel} 카페 값 {wonText(bill.totalWon)}
        </strong>
        <span className={`chip cafe-bill-${bill.status}`}>{CAFE_BILL_STATUS_LABEL[bill.status]}</span>
      </div>
      <dl className='cafe-bill-facts'>
        <dt>입금 코드</dt>
        <dd className='cafe-code'>{bill.code}</dd>
        <dt>기한</dt>
        <dd>{bill.dueLabel}까지</dd>
        <dt>보낼 곳</dt>
        <dd>{account}</dd>
      </dl>
      {bill.status === 'paid' ? (
        <p className='hint'>입금을 확인했어요. 7일 뒤 이 청구서와 그 달 주문 내역이 지워져요.</p>
      ) : (
        <p className='hint'>보낼 때 입금자명에 입금 코드 {bill.code}를 넣어 주세요. 총무가 통장을 보고 입금을 확인해요.</p>
      )}
      <details>
        <summary>건별 내역 {bill.count}건</summary>
        <ul className='cafe-bill-orders'>
          {bill.orders.map((o, i) => (
            <li key={`${o.dayLabel}-${i}`}>
              <span>
                {o.dayLabel} · {o.lines.map(lineText).join(' · ')}
              </span>
              <span>{wonText(o.totalWon)}</span>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

/** [한도 늘려 달라고 하기] 시트: 이번 달 한도로 바라는 금액만 적어요(사유 글 없음). 보내기는 고정 버튼이에요. */
function LimitAskSheet({ billing, need, onClose, onSent }: { billing: CafeMyBilling; need: number; onClose: () => void; onSent: () => void }) {
  const step = 10_000;
  const suggest = Math.min(CAFE_BILLING_LIMITS.maxLimitWon, Math.max(billing.limitWon + step, Math.ceil(need / step) * step));
  const [amount, setAmount] = useState(String(suggest));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const won = Number(amount);
  const valid = Number.isInteger(won) && won > billing.limitWon && won <= CAFE_BILLING_LIMITS.maxLimitWon;

  async function send() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest('POST', '/api/cafe/limit/request', { amountWon: won });
      onSent();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금 보내지 못했어요');
      setBusy(false);
    }
  }

  return (
    <Sheet title='한도 늘려 달라고 하기' onClose={busy ? () => undefined : onClose}>
      <div className='cafe-ask'>
        <p>
          이번 달 한도 {wonText(billing.limitWon)} · 남은 한도 {wonText(billing.leftWon)}
        </p>
        <label className='cafe-won'>
          <input
            aria-label='이번 달 한도로 바라는 금액(원)'
            type='number'
            inputMode='numeric'
            min={billing.limitWon + 1}
            max={CAFE_BILLING_LIMITS.maxLimitWon}
            step={step}
            value={amount}
            onChange={(e) => {
              setError(null);
              setAmount(e.target.value);
            }}
          />
          <span>원</span>
        </label>
        <p className='hint'>금액만 총무에게 가요. 사유는 적지 않아요. 총무가 늘려 주면 이번 달에만 써요.</p>
        {!valid && amount !== '' && <p className='hint'>지금 한도보다 크고 {wonText(CAFE_BILLING_LIMITS.maxLimitWon)}까지인 금액을 적어 주세요.</p>}
        {error && (
          <p className='lock-line' role='alert'>
            {error}
          </p>
        )}
        <button type='button' className='primary' disabled={!valid || busy} onClick={() => void send()}>
          {busy ? '보내는 중' : '보내기'}
        </button>
      </div>
    </Sheet>
  );
}

function CafeHead({ lead }: { lead?: string }) {
  return (
    <header className='page-head'>
      <h1>무엇을 마실까요?</h1>
      <p className='lead'>{lead ?? '사내 카페에 주문하고 픽업 번호로 받아요. 값은 직원가예요.'}</p>
    </header>
  );
}

/** [못 받았어요] 확인 시트 문구(화면설계 "보안이 보이는 문구" S7 줄, 11/6 3묶음) */
export const MISSED_SHEET = {
  title: '음료를 못 받았나요?',
  confirmLabel: '못 받았어요',
  note: '총무가 확인해서 청구에서 빼거나 그대로 둬요. 사유는 적지 않아요. 결과는 알림으로 알려 드려요',
};

/**
 * 오늘 내 주문(픽업 번호·상태). 접수 대기면 [취소](확인 시트 뒤)예요.
 * 나왔어요·가져감인데 음료를 받지 못했으면 [못 받았어요](확인 시트 뒤, 3묶음)를 눌러요. 그날에만 돼요.
 */
export function MyOrders({ orders }: { orders: CafeMyOrder[] }) {
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
            {o.missed && <span className='chip'>{CAFE_MISSED_LABEL[o.missed]}</span>}
            {o.canReportMissed && (
              <button
                type='button'
                className='neutral small'
                onClick={() =>
                  void actions.run({
                    type: 'fixed',
                    text: '못 받았어요',
                    method: 'POST',
                    path: `/api/cafe/orders/${o.id}/missed`,
                    confirm: {
                      title: MISSED_SHEET.title,
                      lines: [`픽업 번호 ${o.pickupNo}`, o.lines.map(lineText).join(' · ')],
                      confirmLabel: MISSED_SHEET.confirmLabel,
                      note: MISSED_SHEET.note,
                    },
                  })
                }
              >
                못 받았어요
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
