// 감사 로그(ADR-10, R11, M5). 내용 칸은 없어요. 아래 칸 말고는 받지 않아요.
export type AuditChannel = 'ask' | 'write' | 'mcp' | 'auth' | 'ops';

export interface AuditEntry {
  at: string;
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

const ALLOWED_KEYS = new Set(['at', 'pseudonymId', 'channel', 'module', 'action', 'tool', 'clientId', 'planId', 'result']);

export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  constructor(private readonly now: () => number) {}

  record(entry: Omit<AuditEntry, 'at'>): void {
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_KEYS.has(key)) throw new Error(`감사 로그에 없는 칸이에요: ${key}`);
    }
    // 2일 차에 DB 표(audit_log)로 옮겨요. 지금은 서버 메모리에만 둬요.
    this.entries.push({ at: new Date(this.now()).toISOString(), ...entry });
  }

  recent(limit = 50): AuditEntry[] {
    return this.entries.slice(-limit);
  }
}
