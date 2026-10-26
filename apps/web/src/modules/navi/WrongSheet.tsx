import { type Card, KIND_LABEL, KINDS, type Kind, WRONG_REASON_LABEL, type WrongFeedbackRequest, type WrongReason } from '@one-line-desk/shared';
import { useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { useActions } from '../../components/ActionHost';
import { CardView } from '../../components/CardView';
import { Sheet } from '../../components/Sheet';
import type { WrongSheetProps } from '../types';

// "틀렸어요" 시트(R8, 화면설계 카드 문법). 선택지는 넷이고, 남는 건 고른 결과뿐이에요.
// 기록은 질문과 다른 피드백 경로로 보내요. 질문 원문은 보내지 않아요(기능 페이지 메모리에만 있어요).

type Step = 'choose' | 'pick-row' | 'pick-kind' | 'saved' | 'replaced';

const TAIL = '고른 결과만 남아요. 질문 원문은 남지 않아요.';

function failureText(e: unknown): string {
  return e instanceof ApiFailure ? e.message : '지금 처리하지 못했어요';
}

export function WrongSheet({ card, onReask, onReplace, onClose }: WrongSheetProps) {
  const actions = useActions();
  const [step, setStep] = useState<Step>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replaced, setReplaced] = useState<Card | null>(null);

  const wrong = card.wrong;
  const predictedRowId = wrong?.predictedRowId;
  const candidates = wrong?.candidates ?? [];
  const predictedKind: Kind = wrong?.predictedKind ?? (card.kind === 'link' ? 'unknown' : card.kind);

  async function send(reason: WrongReason, extra: Pick<WrongFeedbackRequest, 'chosenRowId' | 'correctedKind'> = {}) {
    const body: WrongFeedbackRequest = { predictedKind, reason, ...(predictedRowId ? { predictedRowId } : {}), ...extra };
    await apiRequest('POST', '/api/navi/feedback', body);
  }

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  }

  if (step === 'replaced' && replaced) {
    return (
      <Sheet title='결과' onClose={onClose}>
        <p className='hint'>고른 담당으로 바꿨어요.</p>
        <CardView card={replaced} onAction={(a) => actions.run(a, replaced)} />
        <p className='tail'>{TAIL}</p>
      </Sheet>
    );
  }

  return (
    <Sheet title='틀렸어요' onClose={onClose}>
      {step === 'choose' && (
        <div className='actions' role='group' aria-label='무엇이 틀렸나요'>
          {predictedRowId && candidates.length > 0 && (
            <button type='button' className='secondary' disabled={busy} onClick={() => setStep('pick-row')}>
              {WRONG_REASON_LABEL['other-owner']}
            </button>
          )}
          {predictedRowId && (
            <>
              <button
                type='button'
                className='secondary'
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await send('not-listed');
                    setStep('saved');
                  })
                }
              >
                {WRONG_REASON_LABEL['not-listed']}
              </button>
              <button
                type='button'
                className='secondary'
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await send('content-changed');
                    setStep('saved');
                  })
                }
              >
                {WRONG_REASON_LABEL['content-changed']}
              </button>
            </>
          )}
          <button type='button' className='secondary' disabled={busy} onClick={() => setStep('pick-kind')}>
            {WRONG_REASON_LABEL['wrong-kind']}
          </button>
        </div>
      )}

      {step === 'pick-row' && (
        <div className='actions' role='group' aria-label='맞는 담당'>
          <p className='hint'>맞는 담당을 골라 주세요</p>
          {candidates.map((c) => (
            <button
              key={c.id}
              type='button'
              className='secondary'
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await send('other-owner', { chosenRowId: c.id });
                  const res = await apiRequest<{ card: Card }>('POST', '/api/navi/rows/card', { rowId: c.id });
                  if (onReplace) return onReplace(res.card);
                  setReplaced(res.card);
                  setStep('replaced');
                })
              }
            >
              {c.label}
            </button>
          ))}
          <button type='button' className='link' disabled={busy} onClick={() => setStep('choose')}>
            뒤로 가기
          </button>
        </div>
      )}

      {step === 'pick-kind' && (
        <div className='kind-chips' role='group' aria-label='종류'>
          <p className='hint'>어떤 일인지 골라 주세요</p>
          {KINDS.filter((k) => k !== 'unknown' && k !== predictedKind).map((k) => (
            <button
              key={k}
              type='button'
              className='chip'
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  // 기록이 실패해도(횟수 제한 등) 같은 문장으로 다시 묻기는 이어 가요.
                  await send('wrong-kind', { correctedKind: k }).catch(() => undefined);
                  onReask(k);
                })
              }
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}

      {step === 'saved' && <p>고른 결과를 남겼어요. 분장표 주인에게 묶음으로 보여요.</p>}

      {error && (
        <p className='lock-line' role='alert'>
          {error}
        </p>
      )}
      <p className='tail'>{TAIL}</p>
    </Sheet>
  );
}
