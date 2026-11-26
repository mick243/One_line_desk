import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuditEntry, AuditLog } from './audit';
import { createTestDb } from './db/test-db';
import type { Db } from './db/types';

// 감사 로그는 정해진 칸만, 칸 값도 코드 모양만 받아요(CLAUDE.md "감사 로그에는 정해진 칸만", 11/23 보안 검토).
// 칸 이름만 보면 result에 검색어를 이어 붙여도 막히지 않아서 값 모양까지 봐요.

let db: Db;
let audit: AuditLog;
const base: AuditEntry = { pseudonymId: 'p_abc123', channel: 'write', module: 'rooms', action: 'reserve', result: 'done' };

beforeAll(async () => {
  db = await createTestDb();
  audit = new AuditLog(db);
});
afterAll(async () => {
  await db.close();
});

describe('감사 로그 값 모양', () => {
  it('코드 모양 값(셈·쉼표·등호 포함)은 그대로 남아요', async () => {
    await audit.record({ ...base, result: 'app:2,calendar:no,slack:1/2' });
    await audit.record({ ...base, channel: 'ops', module: undefined, action: 'values.set', result: 'idleTimeoutMinutes=30' });
    const rows = await audit.recent(2);
    expect(rows.map((r) => r.result)).toEqual(['idleTimeoutMinutes=30', 'app:2,calendar:no,slack:1/2']);
  });

  it('검색어·문장·한글·띄어쓰기가 든 값은 칸 이름이 맞아도 거절하고, 오류 글에 값을 넣지 않아요', async () => {
    const bad: Partial<AuditEntry>[] = [
      { result: 'not-found:법인카드 분실' },
      { result: 'not found' },
      { action: '회의실 잡아 줘' },
      { module: 'rooms\nresult' },
      { tool: 'x'.repeat(121) },
      { planId: '' },
    ];
    for (const patch of bad) {
      const err = await audit.record({ ...base, ...patch }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain('법인카드');
      expect((err as Error).message).not.toContain('잡아');
    }
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from audit_log where result like '%법인카드%' or action like '%잡아%'");
    expect(rows[0]!.n).toBe(0);
  });

  it('channel·pseudonymId 모양도 봐요', async () => {
    await expect(audit.record({ ...base, channel: 'chat' as AuditEntry['channel'] })).rejects.toThrow('channel');
    await expect(audit.record({ ...base, pseudonymId: '홍길동' })).rejects.toThrow('pseudonymId');
  });
});
