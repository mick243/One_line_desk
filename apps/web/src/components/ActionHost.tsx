import type { AppDestination, Card, CardAction, PlanConfirmResponse, PlanSheet } from '@one-line-desk/shared';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { ApiFailure, api, apiRequest } from '../api';
import { CardView } from './CardView';
import { Sheet } from './Sheet';

// 카드 행동 처리(ADR-03, R2). 쓰기는 늘 사람이 한 번 확인한 뒤에만 실행돼요.
// - propose: 서버가 plan을 만들고 확인 시트를 돌려줘요 → [확인]이 planId만 보내요
// - post: 공개 미리보기 [올리기]가 곧 확인이에요
// - fixed: confirm이 있으면 확인 시트를 먼저, 없으면 바로(+1·표 거두기)
interface Confirming {
  sheet: PlanSheet;
  run: () => Promise<PlanConfirmResponse | unknown>;
}

interface Shown {
  title: string;
  message?: string;
  cards: Card[];
}

interface ActionsApi {
  run(action: CardAction, card?: Card): Promise<void>;
  /** 결과 카드를 시트로 보여 줘요(앱 확인 링크 진입 등). */
  show(shown: Shown): void;
  /** 쓰기가 끝날 때마다 올라가요. 목록 화면은 이 값이 바뀌면 다시 불러요. */
  version: number;
}

const ActionsContext = createContext<ActionsApi | null>(null);

export function useActions(): ActionsApi {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error('ActionHost 안에서만 써요');
  return ctx;
}

export function ActionHost({ children, onNavigate }: { children: ReactNode; onNavigate: (to: AppDestination) => void }) {
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [version, setVersion] = useState(0);

  const showOutcome = useCallback((res: PlanConfirmResponse) => {
    setVersion((v) => v + 1);
    if (res.status === 'done') setShown({ title: '결과', cards: [res.card] });
    else if (res.status === 'blocked') setShown({ title: '결과', cards: [res.card, ...res.alternatives] });
    else setShown({ title: '다시 찾았어요', message: res.message, cards: res.cards });
  }, []);

  const fail = useCallback((e: unknown) => {
    setShown({ title: '결과', message: e instanceof ApiFailure ? e.message : '지금 처리하지 못했어요', cards: [] });
  }, []);

  const run = useCallback(
    async (action: CardAction, card?: Card) => {
      try {
        switch (action.type) {
          case 'link':
            window.open(action.href, '_blank', 'noopener,noreferrer');
            return;
          case 'navigate':
            setShown(null);
            onNavigate(action.to);
            return;
          case 'reask':
            // 다시 묻기는 원문을 가진 묻기 화면이 처리해요(CardView onAction에서 먼저 가로채요).
            return;
          case 'propose': {
            const created = await api.createPlan(action.proposalToken);
            if (created.status === 'expired') {
              setShown({ title: '다시 찾았어요', message: created.message, cards: created.cards });
              return;
            }
            setShown(null);
            setConfirming({ sheet: created.sheet, run: () => api.confirmPlan(created.planId) });
            return;
          }
          case 'post':
            showOutcome(await api.directPlan(action.proposalToken, { itemName: action.itemName }));
            return;
          case 'fixed': {
            const call = () => apiRequest(action.method, action.path, action.body);
            if (action.confirm) {
              setConfirming({ sheet: action.confirm, run: call });
              return;
            }
            const res = await call();
            // 결과 카드를 돌려주는 버튼(취소 등)은 카드를 보여 줘요. 카드 위 버튼(+1 등)은 카드가 그대로라 짧은 확인을 띄워요.
            // 판·목록 줄의 버튼은 목록이 바로 바뀌어서 따로 띄우지 않아요.
            if (isOutcome(res)) showOutcome(res);
            else {
              setVersion((v) => v + 1);
              if (card) setShown({ title: '결과', message: '반영했어요', cards: [] });
            }
            return;
          }
        }
      } catch (e) {
        fail(e);
      }
    },
    [fail, onNavigate, showOutcome],
  );

  const value = useMemo<ActionsApi>(() => ({ run, show: setShown, version }), [run, version]);

  return (
    <ActionsContext.Provider value={value}>
      {children}
      {confirming && (
        <ConfirmSheet
          sheet={confirming.sheet}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            try {
              const res = await confirming.run();
              setConfirming(null);
              if (isOutcome(res)) showOutcome(res);
              else setVersion((v) => v + 1);
            } catch (e) {
              setConfirming(null);
              fail(e);
            }
          }}
        />
      )}
      {shown && (
        <Sheet title={shown.title} onClose={() => setShown(null)}>
          {shown.message && <p>{shown.message}</p>}
          {shown.cards.map((c) => (
            <CardView key={c.id} card={c} onAction={(a) => run(a)} />
          ))}
        </Sheet>
      )}
    </ActionsContext.Provider>
  );
}

/** 확인 시트. 버튼은 누르면 바로 잠기고 "○○하는 중"으로 바뀌어요. "하기"로 끝나지 않는 이름(합치기·끊기)은 "처리하는 중"이에요. */
export function ConfirmSheet({ sheet, onConfirm, onCancel }: { sheet: PlanSheet; onConfirm: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title={sheet.title} onClose={busy ? () => undefined : onCancel}>
      <ul className='sheet-lines'>
        {sheet.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {sheet.note && <p className='hint'>{sheet.note}</p>}
      <button
        type='button'
        className='primary'
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onConfirm();
        }}
      >
        {busy ? busyLabel(sheet.confirmLabel) : sheet.confirmLabel}
      </button>
    </Sheet>
  );
}

function busyLabel(label: string): string {
  return label.endsWith('하기') ? `${label.slice(0, -2)}하는 중` : '처리하는 중';
}

function isOutcome(res: unknown): res is PlanConfirmResponse {
  return !!res && typeof res === 'object' && 'status' in res && ('card' in res || 'cards' in res);
}
