import { type BoardItem, type BoardResponse, type Card, type CardAction, PANTRY_TEXT } from '@one-line-desk/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiFailure } from '../../api';
import { useActions } from '../../components/ActionHost';
import { CardView } from '../../components/CardView';
import { CheckedInput } from '../../components/CheckedInput';
import { Sheet } from '../../components/Sheet';
import type { ScreenProps } from '../types';
import { pantryApi } from './pantry-api';

// S3 같이 채워요 판(F3). 층별 공개 요청판이에요. 몇 초마다 새로고침해요(실시간 밀어 주기는 다음 2주, M6).
// 누가 표를 줬는지는 서버 응답에도 없어서 화면 어디에도 안 보여요.

const REFRESH_MS = 5000;

export function BoardScreen({ me, onOpenOps, onMoveToAsk }: ScreenProps & { onOpenOps: () => void; onMoveToAsk: (text: string) => void }) {
  const actions = useActions();
  const isFacilities = me.roles.includes('facilities');
  const [floor, setFloor] = useState(me.floor);
  const [data, setData] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 요청 쓰기 칸 글은 이 화면 상태(페이지 메모리)에만 있어요(R13).
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Card[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await pantryApi.board(floor === me.floor ? undefined : floor));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '판을 불러오지 못했어요');
    }
  }, [floor, me.floor]);

  useEffect(() => {
    void load();
  }, [load, actions.version]);

  useEffect(() => {
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  async function submit(masked: string) {
    try {
      setDraft((await pantryApi.draft(masked)).cards);
    } catch (e) {
      setNotice(e instanceof ApiFailure ? e.message : '지금 처리하지 못했어요');
    }
  }

  async function onDraftAction(action: CardAction, card: Card) {
    // [묻기로 옮기기]: 글은 앱 메모리로만 넘겨요(F3-4).
    if (action.type === 'navigate' && action.to === 'ask') {
      setDraft(null);
      onMoveToAsk(text);
      return;
    }
    if (action.type === 'post') setText('');
    setDraft(null);
    await actions.run(action, card);
  }

  async function press(item: BoardItem) {
    if (busy !== null) return;
    setBusy(item.bundleId);
    try {
      await actions.run(
        item.myVote
          ? { type: 'fixed', text: '표 거두기', method: 'DELETE', path: `/api/pantry/votes/${item.bundleId}` }
          : { type: 'fixed', text: '+1', method: 'POST', path: '/api/pantry/votes', body: { bundleId: item.bundleId } },
      );
    } finally {
      setBusy(null);
    }
  }

  const canWrite = floor === me.floor;
  return (
    <div className='board'>
      <header className='screen-head'>
        <div>
          <h1>{floor} 같이 채워요</h1>
          {data?.cycleNote && <p className='hint'>{data.cycleNote}</p>}
        </div>
        {isFacilities && (
          <div className='chips'>
            {data && data.floors.length > 1 && (
              <select value={floor} onChange={(e) => setFloor(e.target.value)} aria-label='층 고르기'>
                {data.floors.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            )}
            <button type='button' className='secondary small' onClick={onOpenOps}>
              운영
            </button>
          </div>
        )}
      </header>

      {canWrite ? (
        <CheckedInput
          scope={PANTRY_TEXT.boardScope}
          placeholder='필요한 간식·음료·비품을 적어 주세요'
          submitLabel='보내기'
          value={text}
          onValueChange={setText}
          onSubmit={submit}
        />
      ) : (
        <p className='hint'>다른 층 판은 보기만 해요. 표는 내 층에서만 줄 수 있어요.</p>
      )}

      {data && canWrite && (
        <p className='hint' aria-live='polite'>
          열린 품목 중 내 표 {data.myBundleCount} / {data.limit}
          {data.myBundleCount > data.limit ? ` · ${PANTRY_TEXT.overLimit}` : data.myBundleCount >= data.limit ? ` · ${PANTRY_TEXT.voteLimit}` : ''}
        </p>
      )}

      <section className='card' aria-label='열린 품목'>
        <h2>열린 품목</h2>
        {error && <p className='lock-line'>{error}</p>}
        {!data && !error && <div className='skeleton' aria-hidden='true' />}
        {data && data.items.length === 0 && <p className='empty'>{PANTRY_TEXT.emptyBoard}</p>}
        {data && data.items.length > 0 && (
          <div className='actions'>
            {data.items.map((item) => (
              <article key={item.bundleId} className='result-card' aria-label={`${item.name} 표 ${item.votes}`}>
                <header className='card-head'>
                  <span className='kind'>{item.name}</span>
                  <span className='label'>표 {item.votes}</span>
                  {item.myVote && <span className='label'>내 표 있음</span>}
                </header>
                {item.catalogName && <p className='evidence'>카탈로그: {item.catalogName}</p>}
                {item.similarTo.length > 0 && (
                  <p className='evidence'>
                    {item.similarByAi && <span className='ai-badge'>AI 정리</span>}같은 상품 같아요: {item.similarTo.join(', ')}
                  </p>
                )}
                {item.mergedNames.length > 0 && <p className='evidence'>합쳐진 이름: {[item.name, ...item.mergedNames].join(', ')}</p>}
                {item.carriedOver && <p className='evidence'>지난 주기에서 넘어왔어요</p>}
                {data.canVote && (
                  <div className='card-actions'>
                    <button type='button' className={item.myVote ? 'secondary' : 'primary'} disabled={busy !== null} onClick={() => void press(item)}>
                      {busy === item.bundleId ? (item.myVote ? '거두는 중' : '+1 하는 중') : item.myVote ? '표 거두기' : '+1'}
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
        <p className='tail'>{PANTRY_TEXT.noVoterShown}</p>
      </section>

      {data && (data.lastCycle.ordered.length > 0 || data.lastCycle.carriedOver > 0) && (
        <section className='card' aria-label='지난 주기 결과'>
          <h2>지난 주기 결과</h2>
          {data.lastCycle.ordered.length > 0 && <p>주문에 들어감: {data.lastCycle.ordered.join(', ')}</p>}
          {data.lastCycle.carriedOver > 0 && <p>다음 주기로 넘어감: {data.lastCycle.carriedOver}개</p>}
        </section>
      )}

      {draft && (
        <Sheet title='결과' onClose={() => setDraft(null)}>
          <div className='kind-chips'>
            <span className='chip selected'>탕비실</span>
          </div>
          {draft.map((card) => (
            <CardView key={card.id} card={card} onAction={onDraftAction} />
          ))}
        </Sheet>
      )}
      {notice && (
        <Sheet title='결과' onClose={() => setNotice(null)}>
          <p>{notice}</p>
        </Sheet>
      )}
    </div>
  );
}
