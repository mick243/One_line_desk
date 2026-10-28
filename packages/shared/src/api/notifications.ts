import type { AppDestination } from '../cards';

// 앱 안 알림(10/26, ADR-16). 알림 글에는 내용이 없고, 무슨 일인지와 볼 페이지만 있어요.

export interface DeskNotification {
  id: string;
  title: string;
  page: AppDestination;
  /** ISO 시각(+09:00) */
  createdAt: string;
  read: boolean;
}

/** GET /api/notifications. 최근 7일(RECORD_KEEP_DAYS), 최대 30개예요. */
export interface NotificationsResponse {
  unread: number;
  items: DeskNotification[];
}

/** POST /api/notifications/read. ids가 없으면 모두 읽음이에요. */
export interface NotificationReadRequest {
  ids?: string[];
}
