import type { AppDestination, Card, CardAction, LeaveCheckResponse, PlanConfirmResponse, PlanSheet } from '@one-line-desk/shared';
import { type ComponentType, createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { ApiFailure, api, apiRequest, type PublicConfig } from '../api';
import { CardView } from './CardView';
import { Sheet } from './Sheet';

// 카드 행동 처리(ADR-03, R2). 쓰기는 늘 사람이 한 번 확인한 뒤에만 실행돼요.
// - propose: 서버가 plan을 만들고 확인 시트를 돌려줘요 → [확인]이 planId만 보내요
// - post: 공개 미리보기 [올리기]가 곧 확인이에요
// - fixed: confirm이 있으면 확인 시트를 먼저, 없으면 바로(+1·표 거두기)
interface Confirming {
  sheet: PlanSheet;
  run: () => Promise<PlanConfirmResponse | unknown>;
  onResult?: ResultHandler;
}

/** 버튼을 누른 카드를 결과 카드로 바꿔 끼울 때 받는 함수(QA D-B01). 끝난 카드가 실행 전 모양으로 남지 않게 해요. */
type ResultHandler = (cards: Card[]) => void;

interface Shown {
  title: string;
  message?: string;
  cards: Card[];
}

interface ActionsApi {
  /** onResult: 실행이 끝나면 그 카드 자리에 들어갈 결과 카드(확정·취소·막힘+대안·다시 찾은 카드)를 받아요. */
  run(action: CardAction, card?: Card, onResult?: ResultHandler): Promise<void>;
  /** 결과 카드를 시트로 보여 줘요(앱 확인 링크 진입 등). */
  show(shown: Shown): void;
  /** 쓰기가 끝나거나 새 알림이 올 때마다 올라가요. 목록 화면은 이 값이 바뀌면 다시 불러요. */
  version: number;
  /** 마지막으로 version을 올린 게 사람이 누르지 않은 새 알림(폴링)인지. 목록 화면은 useListVersion으로 읽어요(ADR-20). */
  quiet: boolean;
  /**
   * 이 화면에서 내가 한 쓰기가 끝날 때만 올라가요. 양식(문의·초대)과 고른 칸은 이 값으로만 닫거나 비워요.
   * 새 알림으로 목록만 다시 부를 때는 그대로라서, 쓰던 글이 사라지지 않아요(10/29 개선 회의 A2).
   */
  writes: number;
  /** 카드 버튼 밖에서 쓰기가 끝났을 때(회의실 채팅 자동 실행, ADR-19) 목록을 다시 불러요. */
  refresh(): void;
  /** 초대 알릴 길(공개 설정). 여러 팀 회의 참석자 고르기(ADR-28)도 같은 길을 보여 줘요. */
  inviteChannels: PublicConfig['inviteChannels'];
  /**
   * 남이 한 일(새 알림)로 목록만 다시 불러요. 열린 양식은 그대로예요.
   * background: 폴링이 부른 거라 목록 요청도 쉬는 시간을 늘리지 않아요(ADR-20). 사람이 누른 거면 빼요.
   */
  reload(opts?: { background?: boolean }): void;
}

const ActionsContext = createContext<ActionsApi | null>(null);

export function useActions(): ActionsApi {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error('ActionHost 안에서만 써요');
  return ctx;
}

/**
 * version으로 다시 부르는 목록 화면이 써요. background()는 effect 안에서 한 번 불러요.
 * 새 알림(폴링) 때문에 version만 올랐을 때만 true예요. 처음 열 때·내가 쓴 뒤·날짜 같은 조건을 바꾼 때는 false예요(ADR-20).
 */
export function useListVersion(): { version: number; background: () => boolean } {
  const { version, quiet } = useActions();
  const seen = useRef<number | null>(null);
  return {
    version,
    background: () => {
      const bg = quiet && seen.current !== null && seen.current !== version;
      seen.current = version;
      return bg;
    },
  };
}

type InviteAction = Extract<CardAction, { type: 'invite' }>;
type InviteChannels = PublicConfig['inviteChannels'];

export function ActionHost({
  children,
  onNavigate,
  InviteSheet,
  inviteChannels,
}: {
  children: ReactNode;
  onNavigate: (to: AppDestination) => void;
  /** 참석자 고르기 양식(ADR-17). 모듈 부품이라 App이 넘겨줘요(공통 부품이 모듈을 import하지 않게). */
  InviteSheet?: ComponentType<{ action: InviteAction; channels: InviteChannels; onClose: () => void }>;
  /** 초대 알릴 길. App이 이미 받은 공개 설정에서 넘겨줘요(양식을 열 때마다 다시 부르지 않게). */
  inviteChannels: InviteChannels;
}) {
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [version, setVersion] = useState(0);
  const [quiet, setQuiet] = useState(false);
  const [writes, setWrites] = useState(0);
  const [inviting, setInviting] = useState<InviteAction | null>(null);

  // 내 쓰기가 끝났어요: 목록도 다시 부르고, 양식도 닫게 해요.
  const wrote = useCallback(() => {
    setQuiet(false);
    setVersion((v) => v + 1);
    setWrites((w) => w + 1);
  }, []);

  const showOutcome = useCallback(
    (res: PlanConfirmResponse) => {
      wrote();
      if (res.status === 'done') setShown({ title: '결과', cards: [res.card] });
      else if (res.status === 'blocked') setShown({ title: '결과', cards: [res.card, ...res.alternatives] });
      else setShown({ title: '다시 찾았어요', message: res.message, cards: res.cards });
    },
    [wrote],
  );

  const fail = useCallback((e: unknown) => {
    setShown({ title: '결과', message: e instanceof ApiFailure ? e.message : '지금 처리하지 못했어요', cards: [] });
  }, []);

  const run = useCallback(
    async (action: CardAction, card?: Card, onResult?: ResultHandler) => {
      try {
        switch (action.type) {
          case 'link':
            window.open(action.href, '_blank', 'noopener,noreferrer');
            return;
          case 'leave-day': {
            // [이 날로 보기](11/6 휴가 A안): 걸린 일이 없는 가까운 날로 신청 전 카드를 다시 계산해요(읽기만, 쓰기 없음).
            // 날짜·종류 코드만 보내요. 그 카드 자리가 있으면 바꾸고, 없으면 시트로 보여 줘요.
            const res = await apiRequest<LeaveCheckResponse>('POST', '/api/navi/leave/check', { type: action.leaveType, days: action.days });
            if (onResult) onResult([res.card]);
            else setShown({ title: '다른 날로 봤어요', cards: [res.card] });
            return;
          }
          case 'copy':
            // 신청 내용 복사(11/6 휴가 A안): 서버가 정한 종류·날짜 글만 클립보드에 넣어요. 앱은 어디에도 남기지 않아요(R13).
            // 글은 그룹웨어 신청서 칸 순서(휴가 종류·기간·날짜·일수·사유는 직접) 여러 줄이라 줄을 살려 보여 줘요.
            try {
              await navigator.clipboard.writeText(action.value);
              setShown({ title: '복사했어요', message: `그룹웨어 신청서에 붙여 넣어 주세요\n\n${action.value}`, cards: [] });
            } catch {
              setShown({ title: '복사하지 못했어요', message: `이 브라우저는 복사를 막았어요. 직접 적어 주세요\n\n${action.value}`, cards: [] });
            }
            return;
          case 'navigate':
            setShown(null);
            onNavigate(action.to);
            return;
          case 'reask':
          case 'inquire':
          case 'leave-request':
            // 다시 찾기·문의 양식·휴가 신청 양식은 원문을 가진 기능 페이지가 처리해요(CardView onAction에서 먼저 가로채요).
            return;
          case 'invite':
            // 참석자 고르기 양식(ADR-17). 확정 카드 시트 위에서도 열려야 해서 여기서 띄워요.
            setShown(null);
            setInviting(action);
            return;
          case 'propose': {
            const created = await api.createPlan(action.proposalToken);
            if (created.status === 'expired') {
              setShown({ title: '다시 찾았어요', message: created.message, cards: created.cards });
              return;
            }
            setShown(null);
            setConfirming({ sheet: created.sheet, run: () => api.confirmPlan(created.planId), onResult });
            return;
          }
          case 'post': {
            const res = await api.directPlan(action.proposalToken, { itemName: action.itemName });
            showOutcome(res);
            onResult?.(resultCards(res));
            return;
          }
          case 'fixed': {
            const call = () => apiRequest(action.method, action.path, action.body);
            if (action.confirm) {
              setConfirming({ sheet: action.confirm, run: call, onResult });
              return;
            }
            const res = await call();
            // 결과 카드를 돌려주는 버튼(취소 등)은 카드를 보여 줘요. 카드 위 버튼(+1 등)은 카드가 그대로라 짧은 확인을 띄워요.
            // 판·목록 줄의 버튼은 목록이 바로 바뀌어서 따로 띄우지 않아요.
            if (isOutcome(res)) {
              showOutcome(res);
              onResult?.(resultCards(res));
            } else {
              wrote();
              if (card) setShown({ title: '결과', message: '반영했어요', cards: [] });
            }
            return;
          }
        }
      } catch (e) {
        fail(e);
      }
    },
    [fail, onNavigate, showOutcome, wrote],
  );

  const reload = useCallback((opts?: { background?: boolean }) => {
    setQuiet(opts?.background === true);
    setVersion((v) => v + 1);
  }, []);
  const value = useMemo<ActionsApi>(
    () => ({ run, show: setShown, version, quiet, writes, refresh: wrote, reload, inviteChannels }),
    [run, version, quiet, writes, wrote, reload, inviteChannels],
  );

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
              if (isOutcome(res)) {
                showOutcome(res);
                confirming.onResult?.(resultCards(res));
              } else wrote();
            } catch (e) {
              setConfirming(null);
              fail(e);
            }
          }}
        />
      )}
      {inviting && InviteSheet && <InviteSheet action={inviting} channels={inviteChannels} onClose={() => setInviting(null)} />}
      {shown && (
        <Sheet title={shown.title} onClose={() => setShown(null)}>
          {shown.message && <p className='sheet-message'>{shown.message}</p>}
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

/** 결과 → 그 카드 자리에 들어갈 카드. 확정·취소는 결과 카드, 막힘은 막힘 카드와 대안, 만료는 다시 찾은 카드예요. */
function resultCards(res: PlanConfirmResponse): Card[] {
  if (res.status === 'done') return [res.card];
  if (res.status === 'blocked') return [res.card, ...res.alternatives];
  return res.cards;
}

/** 목록에서 id 카드를 결과 카드로 바꿔요. 이미 목록에 있는 카드는 겹쳐 넣지 않아요. */
export function replaceCard(list: Card[], id: string, next: Card[]): Card[] {
  const kept = new Set(list.filter((c) => c.id !== id).map((c) => c.id));
  return list.flatMap((c) => (c.id === id ? next.filter((n) => !kept.has(n.id)) : [c]));
}

function isOutcome(res: unknown): res is PlanConfirmResponse {
  return !!res && typeof res === 'object' && 'status' in res && ('card' in res || 'cards' in res);
}
