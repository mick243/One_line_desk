import type { AppDestination, DeskNotification, ModuleKind, NotificationsResponse } from '@one-line-desk/shared';
import type { Db, Queryable } from './db';
import type { DeskUser } from './user';

// 앱 안 알림(10/26, ADR-16). 받는 쪽은 한 사람 또는 한 부서예요.
// 알림 글에는 내용(문의 글 등)을 넣지 않아요. 무슨 일인지와 볼 페이지만 넣고, 내용은 그 페이지에서 권한을 확인한 뒤 보여 줘요.

export interface NotifyInput {
  module: ModuleKind | 'core';
  title: string;
  page: AppDestination;
}

const KEEP_DAYS = 30;
const LIST_LIMIT = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const kstIso = (at: number) => `${new Date(at + KST_MS).toISOString().slice(0, 19)}+09:00`;

export class Notifier {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  /** 쓰기 트랜잭션 안에서 같이 넣어요. 쓰기가 되돌려지면 알림도 없어요. */
  async toUser(q: Queryable, pseudonymId: string, n: NotifyInput): Promise<void> {
    await q.query('insert into notifications (audience_pseudonym, module, title, page, created_at) values ($1, $2, $3, $4, $5)', [
      pseudonymId,
      n.module,
      n.title.slice(0, 120),
      n.page,
      new Date(this.now()).toISOString(),
    ]);
  }

  /** 부서 전체에 보내요. 보낸 사람이 같은 부서면 그 사람은 빼요. */
  async toDepartment(q: Queryable, department: string, n: NotifyInput, excludePseudonym?: string): Promise<void> {
    await q.query('insert into notifications (audience_department, exclude_pseudonym, module, title, page, created_at) values ($1, $2, $3, $4, $5, $6)', [
      department,
      excludePseudonym ?? null,
      n.module,
      n.title.slice(0, 120),
      n.page,
      new Date(this.now()).toISOString(),
    ]);
  }

  /** 30일 지난 알림을 지워요(읽음 표시도 같이 지워져요). 서버가 한 시간마다, 목록을 열 때도 불러요(L-33). */
  async purge(): Promise<void> {
    const cutoff = new Date(this.now() - KEEP_DAYS * DAY_MS).toISOString();
    await this.db.query('delete from notifications where created_at < $1', [cutoff]);
  }

  /** 내 알림(나에게 온 것 + 내 부서에 온 것). 30일 지난 알림은 먼저 지워요. */
  async list(user: Pick<DeskUser, 'pseudonymId' | 'department'>): Promise<NotificationsResponse> {
    await this.purge();
    const { rows } = await this.db.query<{ id: string; title: string; page: DeskNotification['page']; created: number; read: boolean }>(
      `select n.id::text as id, n.title, n.page,
              (extract(epoch from n.created_at) * 1000)::float8 as created,
              (r.notification_id is not null) as read
         from notifications n
         left join notification_reads r on r.notification_id = n.id and r.pseudonym_id = $1
        where (n.audience_pseudonym = $1 or (n.audience_department = $2 and coalesce(n.exclude_pseudonym, '') <> $1))
        order by n.created_at desc, n.id desc
        limit ${LIST_LIMIT}`,
      [user.pseudonymId, user.department],
    );
    const items = rows.map((r) => ({ id: r.id, title: r.title, page: r.page, createdAt: kstIso(r.created), read: r.read }));
    return { unread: items.filter((i) => !i.read).length, items };
  }

  /** 읽음 표시. ids가 없으면 내게 보이는 알림을 모두 읽음으로 해요. 남의 알림 ID는 걸러져요. */
  async markRead(user: Pick<DeskUser, 'pseudonymId' | 'department'>, ids?: string[]): Promise<void> {
    await this.db.query(
      `insert into notification_reads (notification_id, pseudonym_id)
       select n.id, $1 from notifications n
        where (n.audience_pseudonym = $1 or (n.audience_department = $2 and coalesce(n.exclude_pseudonym, '') <> $1))
          and ($3::bigint[] is null or n.id = any($3::bigint[]))
       on conflict do nothing`,
      [user.pseudonymId, user.department, ids ?? null],
    );
  }
}
