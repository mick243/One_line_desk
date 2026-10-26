import {
  formatWon,
  ORDER_MESSAGES,
  type OrderConfirmResponse,
  type OrderCurrentResponse,
  type OrderFloorSummary,
  type OrderLine,
  type OrderPlanView,
  type OrderWarning,
} from '@one-line-desk/shared';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ApiFailure, apiRequest } from '../../../api';
import { ConfirmSheet } from '../../../components/ActionHost';
import type { ScreenProps } from '../../types';
import './order.css';

// S4 주문안 칸(ADR-08, R1·R16). 예산 → [주문안 만들기] → 줄 표 → 합계·최소 몫 충족 → [확정](확인 시트) → [파일 내보내기].
// PC 우선이에요. 폰에서는 층별 합계와 [확정]·[파일 내보내기]만 보여 주고, 만들기와 줄 고치기는 PC에서 해요.

const BASE = '/api/pantry/order/plans';
const WIDE = '(min-width: 900px)';

function subscribeWide(onChange: () => void): () => void {
  const m = window.matchMedia(WIDE);
  m.addEventListener('change', onChange);
  return () => m.removeEventListener('change', onChange);
}

function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches);
}

const won = (n: number) => `${formatWon(n)}원`;
const messageOf = (e: unknown) => (e instanceof ApiFailure ? e.message : '지금 처리하지 못했어요');

export function OrderPanel(_props: ScreenProps) {
  const wide = useWide();
  const [plan, setPlan] = useState<OrderPlanView | null>(null);
  const [loading, setLoading] = useState(true);
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<OrderConfirmResponse | null>(null);

  // 줄 표가 먼저 나오고 설명 문장은 뒤에 채워져요(화면설계 S4 로딩).
  const fillExplanations = useCallback(async (p: OrderPlanView) => {
    if (p.status !== 'draft' || p.explained) return;
    try {
      const filled = await apiRequest<OrderPlanView>('POST', `${BASE}/${p.planId}/explain`);
      setPlan((now) => (now?.planId === filled.planId ? filled : now));
    } catch (e) {
      setNotice(messageOf(e));
    }
  }, []);

  const reload = useCallback(async () => {
    const res = await apiRequest<OrderCurrentResponse>('GET', `${BASE}/current`);
    setPlan(res.plan);
    if (res.plan) void fillExplanations(res.plan);
    return res.plan;
  }, [fillExplanations]);

  useEffect(() => {
    let alive = true;
    reload()
      .then((p) => {
        if (alive && p) setBudget(String(p.budget));
      })
      .catch((e: unknown) => alive && setNotice(messageOf(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [reload]);

  async function make() {
    const value = Number(budget);
    if (!Number.isInteger(value) || value < 0) {
      setNotice('예산은 원 단위 숫자로 넣어 주세요.');
      return;
    }
    setBusy(true);
    setNotice(null);
    setResult(null);
    try {
      const created = await apiRequest<OrderPlanView>('POST', BASE, { budget: value });
      setPlan(created);
      void fillExplanations(created);
    } catch (e) {
      setNotice(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function edit(line: OrderLine, change: { quantity: number } | 'remove') {
    if (!plan) return;
    setNotice(null);
    try {
      const url = `${BASE}/${plan.planId}/lines/${line.lineId}`;
      setPlan(await apiRequest<OrderPlanView>(change === 'remove' ? 'DELETE' : 'PUT', url, change === 'remove' ? undefined : change));
    } catch (e) {
      setNotice(messageOf(e));
      if (e instanceof ApiFailure && e.code === 'order-closed') await reload().catch(() => undefined);
    }
  }

  async function confirm() {
    if (!plan) return;
    try {
      const res = await apiRequest<OrderConfirmResponse>('POST', `${BASE}/${plan.planId}/confirm`);
      setConfirming(false);
      setPlan(res.plan);
      setResult(res);
    } catch (e) {
      setConfirming(false);
      setNotice(messageOf(e));
    }
  }

  const singleFloor = (plan?.floors.length ?? 0) <= 1;
  const lockReasons = plan?.warnings.filter((w) => w.locks) ?? [];
  const included = plan?.lines.filter((l) => l.included) ?? [];

  return (
    <section className='card order'>
      <h2>주문안</h2>

      {wide ? (
        <form
          className='order-form'
          onSubmit={(e) => {
            e.preventDefault();
            void make();
          }}
        >
          <label htmlFor='order-budget'>예산</label>
          <input
            id='order-budget'
            inputMode='numeric'
            autoComplete='off'
            placeholder='예: 300000'
            value={budget}
            onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ''))}
          />
          <span className='hint'>원</span>
          <button type='submit' className='primary' disabled={busy || budget === ''}>
            {busy ? '만드는 중' : '주문안 만들기'}
          </button>
        </form>
      ) : (
        <p className='hint'>주문안 만들기와 줄 고치기는 PC에서 해요.</p>
      )}

      {notice && <p className='lock-line'>{notice}</p>}
      {loading && <div className='skeleton' />}
      {!loading && !plan && <p className='empty'>{ORDER_MESSAGES.empty}</p>}

      {plan && (
        <>
          {plan.status === 'confirmed' && (
            <p className='order-done'>
              {result ? '확정했어요. 주기가 닫히고 새 주기가 열렸어요.' : '확정한 주문안이에요.'} 실제 주문은 내보낸 파일로 기존 절차대로 해 주세요.
            </p>
          )}

          {plan.lines.length === 0 ? (
            <p className='empty'>지금 주문안에 넣을 열린 요청이 없어요.</p>
          ) : wide ? (
            <LineTable plan={plan} singleFloor={singleFloor} editable={plan.status === 'draft'} onEdit={edit} />
          ) : (
            <FloorTotals floors={plan.floors} warnings={plan.warnings} singleFloor={singleFloor} />
          )}

          <div className='order-summary'>
            <span>
              합계 {won(plan.total)} / 예산 {won(plan.budget)}
            </span>
            <span className='hint'>주문에 넣은 품목 {included.length}개</span>
          </div>

          <div className='order-actions'>
            {plan.status === 'draft' && (
              <>
                {lockReasons.map((w) => (
                  <p key={w.kind} className='lock-line'>
                    {w.message}
                  </p>
                ))}
                <button type='button' className='primary' disabled={plan.locked || included.length === 0} onClick={() => setConfirming(true)}>
                  확정
                </button>
              </>
            )}
            {plan.status === 'confirmed' && (
              <a className='secondary' href={`${BASE}/${plan.planId}/export.csv`} download>
                파일 내보내기
              </a>
            )}
          </div>
        </>
      )}

      {confirming && plan && (
        <ConfirmSheet
          sheet={{
            title: '주문안 확정',
            lines: [ORDER_MESSAGES.confirmSheet, `주문에 넣은 품목 ${included.length}개 · 합계 ${won(plan.total)}`],
            confirmLabel: '확정하기',
          }}
          onCancel={() => setConfirming(false)}
          onConfirm={confirm}
        />
      )}
    </section>
  );
}

function floorHead(f: OrderFloorSummary, singleFloor: boolean): string {
  if (singleFloor) return `${f.floor} · ${won(f.total)}`;
  return `${f.floor} · ${won(f.total)} / 최소 몫 ${won(f.minShare)} · ${f.met ? '최소 몫 채움' : '최소 몫 못 채움'}`;
}

function FloorWarnings({ floor, warnings }: { floor: string; warnings: OrderWarning[] }) {
  return (
    <>
      {warnings
        .filter((w) => w.floor === floor)
        .map((w) => (
          <p key={w.kind} className='order-warn'>
            {w.message}
          </p>
        ))}
    </>
  );
}

/** 폰: 층별 합계만 */
function FloorTotals({ floors, warnings, singleFloor }: { floors: OrderFloorSummary[]; warnings: OrderWarning[]; singleFloor: boolean }) {
  return (
    <ul className='order-floors'>
      {floors.map((f) => (
        <li key={f.floor}>
          <strong>{floorHead(f, singleFloor)}</strong>
          <FloorWarnings floor={f.floor} warnings={warnings} />
        </li>
      ))}
    </ul>
  );
}

/** PC: 줄 표(층·품목·수량·금액·이유 코드 칩·한 문장·[빼기]·[바꾸기]) */
function LineTable({
  plan,
  singleFloor,
  editable,
  onEdit,
}: {
  plan: OrderPlanView;
  singleFloor: boolean;
  editable: boolean;
  onEdit: (line: OrderLine, change: { quantity: number } | 'remove') => Promise<void>;
}) {
  return (
    <table className='order-table'>
      <thead>
        <tr>
          <th>품목</th>
          <th className='num'>수량</th>
          <th className='num'>금액</th>
          <th>이유</th>
          <th>설명</th>
          {editable && <th>고치기</th>}
        </tr>
      </thead>
      {plan.floors.map((f) => (
        <tbody key={f.floor}>
          <tr className='order-floor-row'>
            <td colSpan={editable ? 6 : 5}>
              {floorHead(f, singleFloor)}
              <FloorWarnings floor={f.floor} warnings={plan.warnings} />
            </td>
          </tr>
          {plan.lines
            .filter((l) => l.floor === f.floor)
            .map((l) => (
              <LineRow key={l.lineId} line={l} pending={!plan.explained && !l.edited && plan.status === 'draft'} editable={editable} onEdit={onEdit} />
            ))}
        </tbody>
      ))}
    </table>
  );
}

function LineRow({
  line,
  pending,
  editable,
  onEdit,
}: {
  line: OrderLine;
  pending: boolean;
  editable: boolean;
  onEdit: (line: OrderLine, change: { quantity: number } | 'remove') => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pack = Math.max(1, line.packUnit ?? 1);
  const canChange = line.catalogItemId !== null && line.unitPrice !== null;

  async function run(change: { quantity: number } | 'remove') {
    setBusy(true);
    await onEdit(line, change);
    setBusy(false);
    setDraft(null);
  }

  return (
    <tr className={line.included ? 'order-line' : 'order-line out'}>
      <td>
        {line.itemName}
        {line.edited && <span className='order-edited'>{ORDER_MESSAGES.editedLabel}</span>}
      </td>
      <td className='num'>{line.included ? `${line.quantity}개` : '넣지 않음'}</td>
      <td className='num'>{line.included ? won(line.amount) : line.amount > 0 ? `(${won(line.amount)})` : '—'}</td>
      <td>
        <span className='chip order-reason'>{line.reason}</span>
      </td>
      <td>
        {pending ? (
          <span className='hint'>설명을 쓰는 중이에요</span>
        ) : (
          <>
            {line.explanationSource === 'ai' && <span className='ai-badge'>AI 정리</span>}
            {line.explanation}
          </>
        )}
        <span className='hint order-votes'> · 표 {line.votes}개</span>
      </td>
      {editable && (
        <td>
          {draft === null ? (
            <div className='order-line-actions'>
              {line.included && (
                <button type='button' className='secondary small' disabled={busy} onClick={() => void run('remove')}>
                  빼기
                </button>
              )}
              {canChange && (
                <button type='button' className='secondary small' disabled={busy} onClick={() => setDraft(String(line.quantity || pack))}>
                  바꾸기
                </button>
              )}
            </div>
          ) : (
            <form
              className='order-qty'
              onSubmit={(e) => {
                e.preventDefault();
                void run({ quantity: Number(draft) });
              }}
            >
              <input aria-label={`${line.itemName} 수량`} type='number' min={pack} step={pack} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <span className='hint'>{pack}개 단위</span>
              <button type='submit' className='secondary small' disabled={busy || !(Number(draft) > 0)}>
                저장
              </button>
              <button type='button' className='secondary small' disabled={busy} onClick={() => setDraft(null)}>
                취소
              </button>
            </form>
          )}
        </td>
      )}
    </tr>
  );
}
