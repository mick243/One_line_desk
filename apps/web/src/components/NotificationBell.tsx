import { type AppDestination, type NotificationsResponse, RECORD_KEEP_DAYS } from '@one-line-desk/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiRequest } from '../api';
import { useActions } from './ActionHost';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

// 앱 안 알림(ADR-16). 몇 초마다 새로 불러요(밀어 주기는 다음 단계). 알림 글에는 내용이 없고, 누르면 그 페이지로 가요.

const POLL_MS = 15_000;
const TOAST_MS = 5_000;

function when(iso: string): string {
  return `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일 ${iso.slice(11, 16)}`;
}

export function NotificationBell({ onNavigate }: { onNavigate: (to: AppDestination) => void }) {
  const { version, reload } = useActions();
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<NotificationsResponse>('GET', '/api/notifications');
      // 처음 불러온 것 말고, 새로 온 읽지 않은 알림만 토스트로 알려요.
      if (seen.current) {
        const fresh = res.items.find((i) => !i.read && !seen.current!.has(i.id));
        if (fresh) {
          setToast(fresh.title);
          // 새 알림이 오면 화면의 목록(내 문의·받은 문의함·나를 부른 회의·내 예약)도 다시 불러요(QA D-A03).
          // 목록만 다시 불러요. 쓰던 문의·초대 양식은 닫지 않아요(10/29 개선 회의 A2).
          reload();
        }
      }
      seen.current = new Set(res.items.map((i) => i.id));
      setData(res);
    } catch {
      // 알림을 못 불러와도 화면은 그대로 써요.
    }
  }, [reload]);

  useEffect(() => {
    void load();
    // 탭이 가려져 있으면 부르지 않아요(ADR-20).
    const id = window.setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [load, version]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(id);
  }, [toast]);

  async function read(ids?: string[]) {
    setData(await apiRequest<NotificationsResponse>('POST', '/api/notifications/read', ids ? { ids } : {}));
  }

  const unread = data?.unread ?? 0;
  return (
    <>
      <button type='button' className='bell' aria-label={unread ? `알림 ${unread}개 읽지 않음` : '알림'} onClick={() => setOpen(true)}>
        <Icon name='bell' />
        {unread > 0 && <span className='bell-count'>{unread > 9 ? '9+' : unread}</span>}
      </button>
      {toast &&
        createPortal(
          <button type='button' className='toast' role='status' onClick={() => (setToast(null), setOpen(true))}>
            🔔 {toast}
          </button>,
          document.body,
        )}
      {open && (
        <Sheet title='알림' onClose={() => setOpen(false)}>
          {!data || data.items.length === 0 ? (
            <p className='empty'>새 알림이 없어요.</p>
          ) : (
            <>
              {unread > 0 && (
                <button type='button' className='link' onClick={() => void read()}>
                  모두 읽음
                </button>
              )}
              <ul className='plain notification-list'>
                {data.items.map((n) => (
                  <li key={n.id} className={n.read ? 'read' : 'unread'}>
                    <button
                      type='button'
                      onClick={() => {
                        void read([n.id]);
                        setOpen(false);
                        onNavigate(n.page);
                        reload();
                      }}
                    >
                      <span>{n.title}</span>
                      <small>{when(n.createdAt)}</small>
                    </button>
                  </li>
                ))}
              </ul>
              <p className='hint'>알림에는 내용이 없어요. 누르면 그 페이지에서 볼 수 있어요. {RECORD_KEEP_DAYS}일 지나면 지워져요.</p>
            </>
          )}
        </Sheet>
      )}
    </>
  );
}
