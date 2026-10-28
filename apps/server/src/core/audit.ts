import type { Queryable } from './db';

// 감사 로그(ADR-10, R11, M5). 내용 칸은 없어요. 아래 칸 말고는 받지 않아요.
export type AuditChannel = 'ask' | 'write' | 'mcp' | 'auth' | 'ops';

export interface AuditEntry {
  pseudonymId: string;
  channel: AuditChannel;
  /** 묻기는 모듈 종류만, 쓰기는 모듈·동작, MCP는 도구 이름·클라이언트 ID */
  module?: string;
  action?: string;
  tool?: string;
  clientId?: string;
  planId?: string;
  result: string;
}

const ALLOWED_KEYS = new Set(['pseudonymId', 'channel', 'module', 'action', 'tool', 'clientId', 'planId', 'result']);

export class AuditLog {
  constructor(private readonly db: Queryable) {}

  /** tx 안에서 남기려면 q를 넘겨요. */
  async record(entry: AuditEntry, q: Queryable = this.db): Promise<void> {
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_KEYS.has(key)) throw new Error(`감사 로그에 없는 칸이에요: ${key}`);
    }
    await q.query('insert into audit_log (pseudonym_id, channel, module, action, tool, client_id, plan_id, result) values ($1, $2, $3, $4, $5, $6, $7, $8)', [
      entry.pseudonymId,
      entry.channel,
      entry.module ?? null,
      entry.action ?? null,
      entry.tool ?? null,
      entry.clientId ?? null,
      entry.planId ?? null,
      entry.result,
    ]);
  }

  /** 보관 기간(7일, 10/28)이 지난 줄을 지워요. 서버가 한 시간마다 불러요. 법정 접속기록은 따로예요(core/access-record.ts). */
  async purge(before: number): Promise<void> {
    await this.db.query('delete from audit_log where at < $1', [new Date(before).toISOString()]);
  }

  async recent(limit = 50): Promise<(AuditEntry & { at: string })[]> {
    const { rows } = await this.db.query<{
      at: Date;
      pseudonym_id: string;
      channel: AuditChannel;
      module: string | null;
      action: string | null;
      tool: string | null;
      client_id: string | null;
      plan_id: string | null;
      result: string;
    }>('select at, pseudonym_id, channel, module, action, tool, client_id, plan_id, result from audit_log order by id desc limit $1', [limit]);
    return rows.map((r) => ({
      at: new Date(r.at).toISOString(),
      pseudonymId: r.pseudonym_id,
      channel: r.channel,
      ...(r.module ? { module: r.module } : {}),
      ...(r.action ? { action: r.action } : {}),
      ...(r.tool ? { tool: r.tool } : {}),
      ...(r.client_id ? { clientId: r.client_id } : {}),
      ...(r.plan_id ? { planId: r.plan_id } : {}),
      result: r.result,
    }));
  }
}
