import { DEFAULT_OPS_SETTINGS, GRADE, gatewayAllows, isPantryStandalone, type OpsSettings } from '@one-line-desk/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiGateway, FakeProvider, GatewayRefused } from './ai/gateway';
import { AuditLog } from './audit';
import type { Db } from './db';
import { createTestDb } from './db/test-db';
import { listMcpTools, toolsForModule } from './tool-registry';

const settings = (patch: Partial<OpsSettings>): OpsSettings => ({ ...DEFAULT_OPS_SETTINGS, ...patch });
let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe('AI 게이트웨이', () => {
  it('[ADR-10] 계약 확인 전에는 등급 0만, 등급 2 이상은 늘 거부해요', () => {
    expect(gatewayAllows(GRADE.public, false)).toBe(true);
    expect(gatewayAllows(GRADE.internal, false)).toBe(false);
    expect(gatewayAllows(GRADE.internal, true)).toBe(true);
    expect(gatewayAllows(GRADE.confidential, true)).toBe(false);
  });

  it('[ADR-10] 거부된 등급은 공급자를 부르지 않고, 비용 표에는 본문 없이 횟수만 남아요', async () => {
    const gateway = new AiGateway(new FakeProvider(), false, db);
    const req = {
      module: 'navi' as const,
      purpose: 'pick-row',
      system: 's',
      input: '비밀 문장 X-CANARY',
      schema: z.object({ id: z.string() }),
      fallback: () => ({ id: 'a' }),
    };
    await expect(gateway.structured({ ...req, grade: GRADE.internal })).rejects.toBeInstanceOf(GatewayRefused);
    await expect(gateway.structured({ ...req, grade: GRADE.public })).resolves.toEqual({ id: 'a' });
    const usage = await gateway.usageByModule();
    expect(usage).toEqual([{ module: 'navi', calls: 1, inputTokens: 0, outputTokens: 0, failures: 0 }]);
    const { rows } = await db.query('select * from ai_usage');
    expect(JSON.stringify(rows)).not.toContain('X-CANARY');
  });
});

describe('도구 레지스트리', () => {
  it('[M5] MCP는 기본으로 꺼져 있고, 켜도 모듈이 켬일 때만 도구가 나와요', () => {
    expect(listMcpTools(DEFAULT_OPS_SETTINGS)).toEqual([]);
    const on = settings({ mcp: true });
    expect(
      listMcpTools(on)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['notices_search', 'rooms_find_free']);
    const roomsLinkOnly = settings({ mcp: true, modules: { ...DEFAULT_OPS_SETTINGS.modules, rooms: 'link' } });
    expect(listMcpTools(roomsLinkOnly).map((t) => t.name)).toEqual(['notices_search']);
  });

  it('[ADR-10] 꺼진 모듈은 도구를 받지 못해요', () => {
    const off = settings({ modules: { ...DEFAULT_OPS_SETTINGS.modules, notices: 'off' } });
    expect(toolsForModule('notices', off)).toEqual([]);
  });

  it('[R4] 같이 채워요 단독 모드는 navi·notices·rooms가 모두 끔일 때예요', () => {
    expect(isPantryStandalone(DEFAULT_OPS_SETTINGS)).toBe(false);
    expect(isPantryStandalone(settings({ modules: { navi: 'off', notices: 'off', rooms: 'off', pantry: 'on' } }))).toBe(true);
  });
});

describe('감사 로그', () => {
  it('[R11] 정해진 칸 말고는 받지 않아요', async () => {
    const log = new AuditLog(db);
    await expect(log.record({ pseudonymId: 'p_1', channel: 'ask', result: 'locked', text: '원문' } as never)).rejects.toThrow();
    await log.record({ pseudonymId: 'p_1', channel: 'ask', module: 'navi', result: 'card' });
    expect((await log.recent(1))[0]).toMatchObject({ pseudonymId: 'p_1', channel: 'ask', module: 'navi', result: 'card' });
  });
});
