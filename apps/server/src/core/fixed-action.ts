import type { ModuleKind, OpsSettings } from '@one-line-desk/shared';
import type { AuditLog } from './audit';
import type { Db, Queryable } from './db';
import { DeskError } from './errors';
import type { DeskUser } from './user';

// 고정 버튼 쓰기(+1·표 거두기·예약 취소·합치기·되돌리기·따로 두기·주문안 확정·분장표 파일 다시 올리기·
// AI 앱 연결 끊기·모든 기기 로그아웃). plan 없이 이 함수 하나를 거쳐요(ADR-03, R2).
// 권한·상태 재검사는 run 안에서, 멱등 키·스위치·감사 로그는 여기서 해요.

export interface FixedAction<T> {
  module: ModuleKind | 'core' | 'mcp';
  action: string;
  /** 같은 키가 다시 오면 저장한 결과만 돌려줘요(버튼 연타). 없으면 멱등 처리를 안 해요. */
  idempotencyKey?: string;
  /** 실행해도 되는 스위치 상태인지. 기본은 모듈 스위치가 'on'이에요. */
  enabled?(settings: OpsSettings): boolean;
  /** 감사 로그 결과 칸에 남길 짧은 값(내용 없음). 기본은 'done'이에요. */
  resultCode?(result: T): string;
  run(q: Queryable, now: number): Promise<T>;
}

export class FixedActions {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly settings: () => OpsSettings,
    private readonly now: () => number,
  ) {}

  async run<T>(user: DeskUser, action: FixedAction<T>): Promise<T> {
    const settings = this.settings();
    const enabled = action.enabled ? action.enabled(settings) : action.module === 'core' || action.module === 'mcp' || settings.modules[action.module] === 'on';
    if (!enabled) throw new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');

    const key = action.idempotencyKey ? `fixed:${user.pseudonymId}:${action.module}:${action.action}:${action.idempotencyKey}` : null;
    if (key) {
      const { rows } = await this.db.query<{ result: T }>('select result from action_receipts where idempotency_key = $1', [key]);
      if (rows[0]) return rows[0].result;
    }

    return this.db.tx(async (q) => {
      if (key) {
        // 같은 키가 동시에 두 번 와도 한 번만 실행해요. 키로 잠근 뒤 영수증을 다시 봐요.
        await q.query('select pg_advisory_xact_lock(hashtext($1))', [key]);
        const { rows } = await q.query<{ result: T }>('select result from action_receipts where idempotency_key = $1', [key]);
        if (rows[0]) return rows[0].result;
      }
      const result = await action.run(q, this.now());
      if (key) {
        await q.query(
          'insert into action_receipts (idempotency_key, pseudonym_id, module, action, result) values ($1, $2, $3, $4, $5) on conflict (idempotency_key) do nothing',
          [key, user.pseudonymId, action.module, action.action, JSON.stringify(result ?? null)],
        );
      }
      await this.audit.record(
        {
          pseudonymId: user.pseudonymId,
          channel: 'write',
          module: action.module,
          action: action.action,
          result: action.resultCode ? action.resultCode(result) : 'done',
        },
        q,
      );
      return result;
    });
  }
}
