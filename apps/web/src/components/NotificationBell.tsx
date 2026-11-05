import { type AppDestination, type NotificationsResponse, RECORD_KEEP_DAYS } from '@one-line-desk/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiRequest } from '../api';
import { useActions } from './ActionHost';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

// 앱 안 알림(ADR-16). 몇 초마다 새로 불러요(밀어 주기는 다음 단계). 알림 글에는 내용이 없고, 누르면 그 페이지로 가요.
// 11/5(처음 쓰는 직원 점검: 앱을 열어 종을 눌러야만 보여요):
// - 탭이 가려져 있어도 1분마다 새 알림만 확인해요(사람이 누른 요청이 아니라 쉬는 시간을 늘리지 않아요, ADR-20).
// - 읽지 않은 알림 수를 브라우저 탭 제목에 "(2) 한 줄 데스크"처럼 보여요.
// - 사람이 [이 기기에 알림 띄우기]로 허락하면, 탭이 가려졌을 때 새 알림을 컴퓨터·폰 알림으로 띄워요. 잠금 화면·알림 센터에
//   남을 수 있어서 알림 글(이름·회의실·시간)은 넣지 않고 "새 알림이 있어요"만 보여요. 바깥 푸시 서비스는 쓰지 않아요
//   (앱이 열려 있을 때만 떠요. 앱을 닫아도 오는 알림은 Slack 연결이나 웹 푸시라 보안 승인 뒤의 일이에요).

const POLL_MS = 15_000;
const HIDDEN_POLL_MS = 60_000;
const TOAST_MS = 5_000;
const TITLE = '한 줄 데스크';

/** 이 브라우저가 알림 띄우기를 지원하는지 */
const canNotify = () => typeof window !== 'undefined' && 'Notification' in window;

/** 탭이 가려졌을 때 새 알림이 오면 컴퓨터·폰 알림을 띄워요. 내용 없이 수만 보여요. 누르면 앱으로 돌아와 알림을 열어요. */
function notifyDevice(unread: number, onOpen: () => void) {
  if (!canNotify() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(TITLE, { body: unread > 1 ? `새 알림이 ${unread}개 있어요` : '새 알림이 있어요', tag: 'one-line-desk' });
    n.onclick = () => {
      window.focus();
      onOpen();
      n.close();
    };
  } catch {
    // 알림을 못 띄워도 앱 안 알림은 그대로예요.
  }
}

function when(iso: string): string {
  return `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일 ${iso.slice(11, 16)}`;
}

export function NotificationBell({ onNavigate }: { onNavigate: (to: AppDestination) => void }) {
  const { version, reload } = useActions();
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => (canNotify() ? Notification.permission : 'unsupported'));
  const seen = useRef<Set<string> | null>(null);
  // 이 종이 새 알림으로 올린 version이에요. 그 version으로는 알림을 곧바로 다시 부르지 않아요.
  const selfReload = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<NotificationsResponse>('GET', '/api/notifications');
      // 처음 불러온 것 말고, 새로 온 읽지 않은 알림만 토스트로 알려요.
      if (seen.current) {
        const fresh = res.items.find((i) => !i.read && !seen.current!.has(i.id));
        if (fresh) {
          setToast(fresh.title);
          if (document.hidden) notifyDevice(res.unread, () => setOpen(true));
          // 새 알림이 오면 화면의 목록(내 문의·받은 문의함·나를 부른 회의·내 예약)도 다시 불러요(QA D-A03).
          // 목록만 다시 불러요. 쓰던 문의·초대 양식은 닫지 않아요(10/29 개선 회의 A2).
          // 사람이 누른 게 아니라서 목록 요청도 쉬는 시간을 늘리지 않아요(ADR-20).
          selfReload.current = true;
          reload({ background: true });
        }
      }
      seen.current = new Set(res.items.map((i) => i.id));
      setData(res);
    } catch {
      // 알림을 못 불러와도 화면은 그대로 써요.
    }
  }, [reload]);

  useEffect(() => {
    // 방금 받은 알림으로 올린 version이면 다시 부르지 않고 간격만 새로 잡아요.
    if (selfReload.current) selfReload.current = false;
    else void load();
    // 탭이 가려져 있으면 1분에 한 번만 불러요(11/5). 다시 보이면 바로 한 번 불러요.
    let last = Date.now();
    const id = window.setInterval(() => {
      if (document.hidden && Date.now() - last < HIDDEN_POLL_MS) return;
      last = Date.now();
      void load();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) {
        last = Date.now();
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, version]);

  // 읽지 않은 알림 수를 탭 제목에 보여요(11/5). 글은 넣지 않아요.
  const unreadCount = data?.unread ?? 0;
  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount > 9 ? '9+' : unreadCount}) ${TITLE}` : TITLE;
  }, [unreadCount]);

  async function askPermission() {
    if (!canNotify()) return;
    setPermission(await Notification.requestPermission());
  }

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
          {permission === 'default' && (
            <div className='device-notify'>
              <button type='button' className='secondary small' onClick={() => void askPermission()}>
                이 기기에 알림 띄우기
              </button>
              <p className='hint'>앱이 열려 있으면 다른 창을 보고 있어도 "새 알림이 있어요"를 띄워요. 알림 글은 넣지 않아요.</p>
            </div>
          )}
          {permission === 'granted' && <p className='hint'>이 기기에 새 알림을 띄워요. 끄려면 브라우저 사이트 설정에서 알림을 꺼요.</p>}
          {permission === 'denied' && <p className='hint'>이 브라우저에서 알림을 막아 두었어요. 브라우저 사이트 설정에서 알림을 허용하면 띄울 수 있어요.</p>}
        </Sheet>
      )}
    </>
  );
}
