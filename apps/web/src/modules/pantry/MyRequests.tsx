import type { MyRequestItem } from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { ApiFailure } from '../../api';
import { useActions } from '../../components/ActionHost';
import { pantryApi } from './pantry-api';

// S1·S6 "내 요청" 칸(F3-15). 상태: 표 받는 중 · 주문에 들어감 · 다음 주기로 넘어감. 누르면 S3 판으로 가요.
// 알림은 다음 2주예요(M6). 이번엔 이 상태로만 알 수 있어요.

export function MyRequests({ compact }: { compact?: boolean }) {
  const actions = useActions();
  const [items, setItems] = useState<MyRequestItem[] | null>(null);
  const [off, setOff] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    pantryApi
      .myRequests()
      .then((r) => alive && setItems(r.items))
      .catch((e: unknown) => {
        if (!alive) return;
        // 같이 채워요가 꺼져 있으면 칸을 숨겨요(R4).
        if (e instanceof ApiFailure && e.code === 'feature-off') setOff(true);
        else setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [actions.version]);

  if (off) return null;
  const shown = compact ? items?.slice(0, 3) : items;

  async function withdraw(item: MyRequestItem) {
    setBusy(item.bundleId);
    try {
      await actions.run({ type: 'fixed', text: '표 거두기', method: 'DELETE', path: `/api/pantry/votes/${item.bundleId}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className='card' aria-label='내 요청'>
      <h2>내 요청</h2>
      {items === null && <p className='hint'>불러오는 중</p>}
      {items?.length === 0 && <p className='empty'>{compact ? '아직 요청이 없어요.' : '요청이 없어요'}</p>}
      {shown && shown.length > 0 && (
        <div className='actions'>
          {shown.map((item) => (
            <div key={item.bundleId} className='card-actions'>
              <button type='button' className='link' onClick={() => void actions.run({ type: 'navigate', text: '판에서 보기', to: 'board' })}>
                {item.name}
              </button>
              <span className='chip'>{item.status}</span>
              {item.votes !== null && <span className='hint'>표 {item.votes}</span>}
              {!compact && item.status !== '주문에 들어감' && (
                <button type='button' className='secondary small' disabled={busy !== null} onClick={() => void withdraw(item)}>
                  {busy === item.bundleId ? '거두는 중' : '표 거두기'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {compact && items && items.length > 3 && <p className='hint'>나머지는 내 것에서 볼 수 있어요</p>}
    </section>
  );
}
