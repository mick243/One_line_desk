import {
  CAFE_BILL_STATUS_LABEL,
  CAFE_BILLING_LIMITS,
  CAFE_MISSED_LABEL,
  CAFE_TEXT,
  type CafeAdminMenuItem,
  type CafeSettleBill,
  type CafeSettleLimitRequest,
  type CafeSettleMissed,
  type CafeSettleResponse,
  wonText,
} from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { useActions, useListVersion } from '../../components/ActionHost';
import { Icon } from '../../components/Icon';
import './cafe.css';

// S9 카페 정산(총무만, F4 2묶음, ADR-29 등급 2 예외). 마이 페이지 > 내 역할 > [카페 정산]으로 들어와요.
// 배치: 머리 문구(접속기록) → 달 고르기 → 청구 목록([입금 확인]) → 한도 요청([늘려 주기]·[안 돼요]) → 메뉴·직원가 관리 → 지난달 매출 합계 내려받기.
// 이름·청구액·입금 코드는 이 화면에서만 보여요. 화면을 열거나 다시 불러올 때마다 서버가 접속기록에 남겨요(가명 ID만).
// 앱은 돈을 받거나 보내지 않아요: 총무가 통장을 보고 [입금 확인]을 눌러요.
// 3묶음(11/6): [못 받았어요] 확인([청구에서 빼기]·[그대로 두기])과 재직 확인에서 빠진 사람의 미납 표시(PRD F4-14, 급여·퇴직금 공제는 하지 않아요).

const LIMIT_LABEL = { pending: '기다림', approved: '늘려 줌', rejected: '안 됨' } as const;

export function CafeSettle({ onBack }: { onBack: () => void }) {
  const { version, background } = useListVersion();
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<CafeSettleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // 새 알림(폴링)으로 다시 부를 때만 배경 요청이에요(쉬는 시간을 늘리지 않아요, ADR-20).
    const bg = background();
    apiRequest<CafeSettleResponse>('GET', `/api/cafe/settle${month ? `?month=${month}` : ''}`, undefined, { background: bg })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof ApiFailure ? e.message : '정산 화면을 불러오지 못했어요');
      });
    return () => {
      alive = false;
    };
  }, [version, month]);

  return (
    <div className='feature-page cafe-settle'>
      <button type='button' className='link back' onClick={onBack}>
        <Icon name='back' size={18} />
        마이 페이지
      </button>
      <header className='page-head'>
        <h1>카페 정산</h1>
        <p className='lead'>{CAFE_TEXT.settleHead}</p>
        <p className='page-meta'>총무만 봐요</p>
      </header>

      {error && <p className='lock-line'>{error}</p>}
      {!data && !error && <div className='skeleton' aria-label='정산 화면을 불러오는 중' />}
      {data && <SettleView data={data} onMonth={setMonth} />}
    </div>
  );
}

/** 불러온 정산 화면. 시험에서 바로 그려요. */
export function SettleView({ data, onMonth }: { data: CafeSettleResponse; onMonth: (month: string) => void }) {
  return (
    <>
      <section className='card' aria-label='청구 목록'>
        <div className='cafe-settle-head'>
          <h2>{data.monthLabel} 주문 청구</h2>
          <label className='cafe-month'>
            <span className='hint'>달</span>
            <select value={data.month} onChange={(e) => onMonth(e.target.value)}>
              {data.months.map((m) => (
                <option key={m.month} value={m.month}>
                  {m.label} 주문
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className='hint meta-row'>
          <span>청구 {data.summary.count}건</span>
          <span>합계 {wonText(data.summary.totalWon)}</span>
          <span>입금 확인 {wonText(data.summary.paidWon)}</span>
          {data.summary.overdue > 0 && <span>기한 지남 {data.summary.overdue}건</span>}
        </p>
        <p className='hint'>통장에서 입금자명의 입금 코드를 찾아 맞는 줄의 [입금 확인]을 눌러 주세요. 누르면 그 사람의 주문 막힘이 바로 풀려요.</p>
        {data.bills.length === 0 ? <p className='empty'>이 달에 나온 청구서가 없어요</p> : <BillTable bills={data.bills} monthLabel={data.monthLabel} />}
        {data.bills.some((b) => !b.active) && <p className='hint'>{LEFT_HINT}</p>}
      </section>

      <section className='card' aria-label='한도 요청'>
        <h2>한도 요청</h2>
        <p className='hint'>직원이 이번 달 한도로 바라는 금액만 보내요. 늘려 준 한도는 그 달에만 써요. 요청은 처리하고 7일 뒤 지워져요.</p>
        {data.requests.length === 0 ? <p className='empty'>받은 한도 요청이 없어요</p> : <LimitRequests requests={data.requests} />}
      </section>

      <section className='card' aria-label='못 받았어요 확인'>
        <h2>못 받았어요 확인</h2>
        <p className='hint'>{MISSED_HINT}</p>
        {data.missed.length === 0 ? <p className='empty'>받은 신고가 없어요</p> : <MissedList missed={data.missed} />}
      </section>

      <MenuManager menu={data.menu} />

      <section className='card' aria-label='매출 합계'>
        <h2>매출 합계</h2>
        <p className='hint'>{CAFE_TEXT.salesNote}</p>
        <p className='hint'>날·메뉴별 잔 수와 금액만 있고 이름은 없어요. 회사 장부 보관은 회사 회계가 맡아요.</p>
        <div className='actions'>
          <a className='secondary' href={`/api/cafe/sales.csv?month=${data.salesMonth}`} download>
            지난달 매출 합계 내려받기
          </a>
        </div>
        <p className='hint'>{data.salesMonthLabel} 주문(취소 뺌)이에요.</p>
      </section>
    </>
  );
}

function BillTable({ bills, monthLabel }: { bills: CafeSettleBill[]; monthLabel: string }) {
  const actions = useActions();
  return (
    <div className='cafe-table-wrap'>
      <table className='cafe-table'>
        <thead>
          <tr>
            <th>이름</th>
            <th className='num'>청구액</th>
            <th className='num'>건수</th>
            <th>입금 코드</th>
            <th>기한</th>
            <th>상태</th>
            <th aria-label='입금 확인' />
          </tr>
        </thead>
        <tbody>
          {bills.map((b) => (
            <tr key={b.id} className={`status-${b.status}`}>
              <td>
                {b.name}
                {!b.active && <span className='chip'> 재직 확인 안 됨</span>}
              </td>
              <td className='num'>{wonText(b.totalWon)}</td>
              <td className='num'>{b.count}</td>
              <td className='cafe-code'>{b.code}</td>
              <td>{b.dueLabel}</td>
              <td>
                <span className={`chip cafe-bill-${b.status}`}>{CAFE_BILL_STATUS_LABEL[b.status]}</span>
                {b.paidLabel && <span className='hint'> {b.paidLabel}</span>}
              </td>
              <td>
                {b.status !== 'paid' && (
                  <button
                    type='button'
                    className='secondary small'
                    onClick={() =>
                      void actions.run({
                        type: 'fixed',
                        text: '입금 확인',
                        method: 'POST',
                        path: `/api/cafe/bills/${b.id}/paid`,
                        confirm: {
                          title: '입금을 확인할까요?',
                          lines: [`${b.name} · ${monthLabel} 카페 값 ${wonText(b.totalWon)}`, `입금 코드 ${b.code}`],
                          confirmLabel: '입금 확인하기',
                          note: '통장에 들어온 것을 본 뒤 눌러 주세요. 누르면 바로 주문 막힘이 풀리고, 7일 뒤 이 청구서와 그 달 주문 내역이 지워져요',
                        },
                      })
                    }
                  >
                    입금 확인
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** S9 [못 받았어요] 확인 안내(화면설계 "보안이 보이는 문구" S9 줄) */
export const MISSED_HINT = '직원이 음료를 못 받았다고 알린 주문이에요. 확인하고 [청구에서 빼기]나 [그대로 두기]를 눌러 주세요. 결과는 본인에게 알림으로 가요';
/** 재직 확인에서 빠진 사람의 미납(PRD F4-14). 앱은 급여·퇴직금에서 빼지 않아요. */
export const LEFT_HINT = '재직 확인 안 됨: 회사 계정에서 빠진 사람이에요. 앱은 미납을 급여·퇴직금에서 빼지 않아요. 직접 연락해 정산을 안내해 주세요';

/** [못 받았어요] 신고 목록: 처리를 기다리는 것만 [청구에서 빼기]·[그대로 두기](확인 시트 뒤 고정 버튼)가 있어요. */
function MissedList({ missed }: { missed: CafeSettleMissed[] }) {
  const actions = useActions();
  const lineOf = (m: CafeSettleMissed) => m.lines.map((l) => `${l.name}${l.options.length ? `(${l.options.join('·')})` : ''} × ${l.qty}`).join(' · ');
  const decide = (m: CafeSettleMissed, remove: boolean) =>
    void actions.run({
      type: 'fixed',
      text: remove ? '청구에서 빼기' : '그대로 두기',
      method: 'POST',
      path: `/api/cafe/missed/${m.id}/${remove ? 'remove' : 'keep'}`,
      confirm: remove
        ? {
            title: '청구에서 뺄까요?',
            lines: [`${m.name} · ${m.dayLabel} 픽업 번호 ${m.pickupNo}`, `${lineOf(m)} · ${wonText(m.totalWon)}`],
            confirmLabel: '청구에서 빼기',
            note: '이번 달 합계·한도와 청구서에서 빠져요. 이미 나온 청구서는 합계를 다시 세요. 입금을 확인한 청구서에서는 뺄 수 없어요',
          }
        : {
            title: '청구에 그대로 둘까요?',
            lines: [`${m.name} · ${m.dayLabel} 픽업 번호 ${m.pickupNo}`, `${lineOf(m)} · ${wonText(m.totalWon)}`],
            confirmLabel: '그대로 두기',
            note: '주문한 사람 청구에 그대로 남아요. 본인에게 알림이 가요',
          },
    });
  return (
    <ul className='cafe-requests'>
      {missed.map((m) => (
        <li key={m.id} className='cafe-request'>
          <div className='cafe-request-body'>
            <strong>
              {m.name} · {m.dayLabel} 픽업 번호 {m.pickupNo}
            </strong>
            <span className='hint meta-row'>
              <span>{lineOf(m)}</span>
              <span>픽업 {m.pickupLabel}</span>
              <span>{wonText(m.totalWon)}</span>
              <span>알린 때 {m.reportedLabel}</span>
              <span>{CAFE_MISSED_LABEL[m.status]}</span>
            </span>
          </div>
          {m.status === 'reported' && (
            <div className='actions'>
              <button type='button' className='secondary small' onClick={() => decide(m, true)}>
                청구에서 빼기
              </button>
              <button type='button' className='neutral small' onClick={() => decide(m, false)}>
                그대로 두기
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function LimitRequests({ requests }: { requests: CafeSettleLimitRequest[] }) {
  const actions = useActions();
  const decide = (r: CafeSettleLimitRequest, approve: boolean) =>
    void actions.run({
      type: 'fixed',
      text: approve ? '늘려 주기' : '안 돼요',
      method: 'POST',
      path: `/api/cafe/limit/${r.id}/${approve ? 'approve' : 'reject'}`,
      confirm: approve
        ? {
            title: '한도를 늘려 줄까요?',
            lines: [`${r.name} · ${r.monthLabel} 한도 ${wonText(r.limitWon)} → ${wonText(r.amountWon)}`],
            confirmLabel: '늘려 주기',
            note: '늘린 한도는 그 달에만 써요. 요청한 사람에게 알림이 가요',
          }
        : {
            title: '한도를 그대로 둘까요?',
            lines: [`${r.name} · ${r.monthLabel} 한도 ${wonText(r.limitWon)} 그대로`],
            confirmLabel: '안 돼요',
            note: '요청한 사람에게 알림이 가요',
          },
    });
  return (
    <ul className='cafe-requests'>
      {requests.map((r) => (
        <li key={r.id} className='cafe-request'>
          <div className='cafe-request-body'>
            <strong>
              {r.name} · {r.monthLabel} 한도 {wonText(r.limitWon)} → {wonText(r.amountWon)}
            </strong>
            <span className='hint'>
              {r.createdLabel} · {LIMIT_LABEL[r.status]}
              {r.status === 'pending' && !r.current && ' · 지난달 요청이라 늘릴 수 없어요'}
            </span>
          </div>
          {r.status === 'pending' && (
            <div className='actions'>
              {r.current && (
                <button type='button' className='secondary small' onClick={() => decide(r, true)}>
                  늘려 주기
                </button>
              )}
              <button type='button' className='neutral small' onClick={() => decide(r, false)}>
                안 돼요
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** "아이스, 핫" → ['아이스', '핫'] */
const parseOptions = (text: string) =>
  text
    .split(/[,，]/)
    .map((o) => o.trim())
    .filter(Boolean);

type Draft = { name: string; price: string; options: string; active: boolean };
const draftOf = (m?: CafeAdminMenuItem): Draft => ({
  name: m?.name ?? '',
  price: m ? String(m.priceWon) : '',
  options: m?.options.join(', ') ?? '',
  active: m?.active ?? true,
});

function MenuManager({ menu }: { menu: CafeAdminMenuItem[] }) {
  return (
    <section className='card' aria-label='메뉴·직원가 관리'>
      <h2>메뉴·직원가 관리</h2>
      <p className='hint'>
        옵션은 쉼표로 나눠 적어요(값은 바뀌지 않아요). 직원가를 바꾸면 이미 연 확인 시트는 실행 때 막혀서 다시 골라요. 품절은 바리스타가 카페 판에서 바꿔요.
      </p>
      <ul className='cafe-menu-admin'>
        {menu.map((m) => (
          <MenuEditor key={`${m.id}-${m.name}-${m.priceWon}-${m.options.join('|')}-${m.active}`} item={m} />
        ))}
        <MenuEditor key={`new-${menu.length}`} />
      </ul>
    </section>
  );
}

/** 메뉴 한 줄 고치기(item이 없으면 새 메뉴 더하기). 저장은 고정 버튼이에요. */
function MenuEditor({ item }: { item?: CafeAdminMenuItem }) {
  const actions = useActions();
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const price = Number(draft.price);
  const valid = draft.name.trim().length > 0 && draft.price !== '' && Number.isInteger(price) && price >= 0 && price <= CAFE_BILLING_LIMITS.maxPriceWon;
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(item));
  const label = item ? item.name : '새 메뉴';

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const body = { name: draft.name, priceWon: price, options: parseOptions(draft.options) };
    try {
      if (item) await apiRequest('PUT', `/api/cafe/menu/${item.id}`, { ...body, active: draft.active });
      else await apiRequest('POST', '/api/cafe/menu', body);
      actions.reload();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금 저장하지 못했어요');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={item && !item.active ? 'cafe-menu-edit off' : 'cafe-menu-edit'}>
      <input
        aria-label={`${label} 이름`}
        placeholder='메뉴 이름'
        maxLength={CAFE_BILLING_LIMITS.menuNameMax}
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <label className='cafe-won'>
        <input
          aria-label={`${label} 직원가(원)`}
          type='number'
          inputMode='numeric'
          min={0}
          max={CAFE_BILLING_LIMITS.maxPriceWon}
          step={100}
          placeholder='직원가'
          value={draft.price}
          onChange={(e) => setDraft({ ...draft, price: e.target.value })}
        />
        <span>원</span>
      </label>
      <input
        aria-label={`${label} 옵션(쉼표로 나눠요)`}
        placeholder='옵션(예: 아이스, 핫)'
        value={draft.options}
        onChange={(e) => setDraft({ ...draft, options: e.target.value })}
      />
      {item && (
        <label className='cafe-active'>
          <input type='checkbox' checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
          <span>파는 중</span>
        </label>
      )}
      <button type='button' className='secondary small' disabled={!valid || !changed || busy} onClick={() => void save()}>
        {busy ? '저장하는 중' : item ? '저장하기' : '메뉴 더하기'}
      </button>
      {error && (
        <p className='lock-line' role='alert'>
          {error}
        </p>
      )}
    </li>
  );
}
