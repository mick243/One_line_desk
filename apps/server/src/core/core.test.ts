import { DEFAULT_OPS_SETTINGS, GRADE, gatewayAllows, isPantryStandalone, type OpsSettings } from '@one-line-desk/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANTHROPIC_CLIENT_OPTIONS } from './ai/anthropic-provider';
import {
  AiDailyLimitReached,
  AiGateway,
  FakeProvider,
  GatewayGradeTooLow,
  GatewayRefused,
  type LlmProvider,
  ProviderFailure,
  PUBLIC_GRADE_PURPOSES,
  SIGNAL_FOLD_MIN,
} from './ai/gateway';
import { AuditLog } from './audit';
import type { Db } from './db';
import { createTestDb } from './db/test-db';
import { classifyText } from './router';
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
    // 11/23: 등급 0은 정해 둔 목적(PUBLIC_GRADE_PURPOSES, 지금 없음)만 보내요. 사람 글을 등급 0으로 잘못 적어도 계약 전에 나가지 않아요.
    expect(PUBLIC_GRADE_PURPOSES.size).toBe(0);
    await expect(gateway.structured({ ...req, grade: GRADE.public })).rejects.toBeInstanceOf(GatewayGradeTooLow);
    await expect(new AiGateway(new FakeProvider(), true, db).structured({ ...req, grade: GRADE.public })).rejects.toBeInstanceOf(GatewayGradeTooLow);
    await expect(new AiGateway(new FakeProvider(), true, db).structured({ ...req, grade: GRADE.internal })).resolves.toEqual({ id: 'a' });
    const usage = await gateway.usageByModule();
    expect(usage).toEqual([{ module: 'navi', calls: 1, inputTokens: 0, outputTokens: 0, failures: 0, failureKinds: [], agreement: [] }]);
    const { rows } = await db.query('select * from ai_usage');
    expect(JSON.stringify(rows)).not.toContain('X-CANARY');
  });

  it('[QA Q7 시험] 하루 AI 호출 상한을 넘으면 공급자를 부르지 않고 실패(규칙으로 답하게)예요. 가짜 공급자는 세지 않아요', async () => {
    await db.query('delete from ai_usage');
    let calls = 0;
    const model: LlmProvider = {
      name: 'gemini',
      async complete(r) {
        calls++;
        return { output: r.schema.parse(r.fallback()), inputTokens: 1, outputTokens: 1 };
      },
    };
    let limit = 2;
    const gateway = new AiGateway(model, true, db, () => limit);
    const req = {
      module: 'router' as const,
      purpose: 'classify',
      grade: GRADE.internal,
      system: 's',
      input: '문장',
      schema: z.object({ id: z.string() }),
      fallback: () => ({ id: 'a' }),
    };
    await gateway.structured(req);
    await gateway.structured(req);
    await expect(gateway.structured(req)).rejects.toBeInstanceOf(AiDailyLimitReached);
    expect(calls).toBe(2);
    // 상한에 걸린 줄은 종류 코드만 남고, 다음 셈에는 들어가지 않아요(상한을 올리면 바로 다시 불러요).
    const kinds = (await db.query<{ fail_kind: string | null }>('select fail_kind from ai_usage order by id')).rows.map((r) => r.fail_kind);
    expect(kinds).toEqual([null, null, 'daily-limit']);
    limit = 3;
    await gateway.structured(req);
    expect(calls).toBe(3);
    // 0이면 모델을 부르지 않아요.
    limit = 0;
    await expect(gateway.structured(req)).rejects.toBeInstanceOf(AiDailyLimitReached);
    // 가짜 공급자(시험·키 없는 개발)는 상한과 상관없어요.
    await expect(new AiGateway(new FakeProvider(), true, db, () => 0).structured(req)).resolves.toEqual({ id: 'a' });
    // Anthropic은 SDK 기본(10분·다시 시도 2번) 대신 20초·한 번이에요.
    expect(ANTHROPIC_CLIENT_OPTIONS).toEqual({ timeout: 20_000, maxRetries: 1 });
  });

  it('공급자 실패는 비용 표에 종류 코드만 남겨요(11/5). 오류 글은 남지 않아요', async () => {
    await db.query('delete from ai_usage');
    const failing = (error: Error): LlmProvider => ({
      name: 'anthropic',
      async complete() {
        throw error;
      },
    });
    const req = {
      module: 'rooms' as const,
      purpose: 'chat-intent',
      grade: GRADE.internal,
      system: 's',
      input: '문장 Y-CANARY',
      schema: z.object({ id: z.string() }),
      fallback: () => ({ id: 'a' }),
    };
    for (const error of [
      new ProviderFailure('parse', '모양 틀림 Y-CANARY'),
      new ProviderFailure('parse', 'x'),
      new ProviderFailure('http-429', 'x'),
      new Error('Y-CANARY'),
    ])
      await expect(new AiGateway(failing(error), true, db).structured(req)).rejects.toThrow();
    // 표 검사에 맞지 않는 종류 글자는 error로 남겨요.
    await expect(new AiGateway(failing(new ProviderFailure('나쁜 종류 Y-CANARY', 'x')), true, db).structured(req)).rejects.toThrow();
    const usage = await new AiGateway(new FakeProvider(), true, db).usageByModule();
    expect(usage).toEqual([
      {
        module: 'rooms',
        calls: 5,
        inputTokens: 0,
        outputTokens: 0,
        failures: 5,
        failureKinds: [
          { purpose: 'chat-intent', kind: 'error', count: 2 },
          { purpose: 'chat-intent', kind: 'http-429', count: 1 },
          { purpose: 'chat-intent', kind: 'parse', count: 2 },
        ],
        agreement: [],
      },
    ]);
    const { rows } = await db.query('select * from ai_usage');
    expect(JSON.stringify(rows)).not.toContain('Y-CANARY');
  });
});

// 실사용 신호(11/17): 실제 모델 답이 낱말 규칙 답과 같았는지를 비용 줄에 같음·다름으로만 남겨요. 글·답·사람은 남기지 않아요.
describe('AI 게이트웨이: 모델·규칙 견줌(실사용 신호)', () => {
  /** 실제 모델 흉내: 정해 둔 답을 돌려줘요. */
  const answering = (answer: unknown): LlmProvider => ({
    name: 'gemini',
    async complete(r) {
      return { output: r.schema.parse(answer), inputTokens: 3, outputTokens: 2 };
    },
  });
  const req = {
    module: 'rooms' as const,
    purpose: 'chat-intent',
    grade: GRADE.internal,
    system: 's',
    input: '문장 Z-CANARY',
    schema: z.object({ id: z.string() }),
    fallback: () => ({ id: 'rule Z-CANARY' }),
  };
  const agrees = (o: { id: string }) => o.id === 'rule Z-CANARY';
  const agreeRows = async () =>
    (await db.query<{ provider: string; ok: boolean; agree: boolean | null }>('select provider, ok, agree from ai_usage order by id')).rows;

  it('[실사용 신호-마이그레이션] 새 칸은 새 마이그레이션 파일로 들어가고, null을 받는 boolean 칸 하나씩이에요', async () => {
    const applied = (await db.query<{ name: string }>('select name from schema_migrations order by name')).rows.map((r) => r.name);
    expect(applied).toEqual(expect.arrayContaining(['030_core_ai_agree.sql', '230_notices_audience_edited.sql']));
    const { rows } = await db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `select table_name, column_name, data_type, is_nullable from information_schema.columns
        where table_schema = current_schema()
          and ((table_name = 'ai_usage' and column_name = 'agree') or (table_name = 'notice_audience' and column_name = 'edited'))
        order by table_name`,
    );
    expect(rows).toEqual([
      { table_name: 'ai_usage', column_name: 'agree', data_type: 'boolean', is_nullable: 'YES' },
      { table_name: 'notice_audience', column_name: 'edited', data_type: 'boolean', is_nullable: 'YES' },
    ]);
  });

  it('[실사용 신호-기록] 실제 모델 답은 같음·다름만 남기고, 가짜 공급자·견주는 함수 없는 호출·실패한 호출은 null이에요', async () => {
    await db.query('delete from ai_usage');
    // 가짜 공급자는 규칙 답을 그대로 돌려줘서 늘 같음이라 세지 않아요.
    await new AiGateway(new FakeProvider(), true, db).structured({ ...req, agrees });
    await expect(new AiGateway(answering({ id: 'rule Z-CANARY' }), true, db).structured({ ...req, agrees })).resolves.toEqual({ id: 'rule Z-CANARY' });
    await expect(new AiGateway(answering({ id: 'model Z-CANARY' }), true, db).structured({ ...req, agrees })).resolves.toEqual({ id: 'model Z-CANARY' });
    await new AiGateway(answering({ id: 'model Z-CANARY' }), true, db).structured(req);
    const failing: LlmProvider = {
      name: 'anthropic',
      async complete() {
        throw new ProviderFailure('parse', 'Z-CANARY');
      },
    };
    await expect(new AiGateway(failing, true, db).structured({ ...req, agrees })).rejects.toThrow();
    expect(await agreeRows()).toEqual([
      { provider: 'fake', ok: true, agree: null },
      { provider: 'gemini', ok: true, agree: true },
      { provider: 'gemini', ok: true, agree: false },
      { provider: 'gemini', ok: true, agree: null },
      { provider: 'anthropic', ok: false, agree: null },
    ]);
    // 비용 줄에는 정해진 칸만 있고, 질문 글·모델 답·규칙 답은 없어요.
    const { rows } = await db.query('select * from ai_usage');
    expect(Object.keys(rows[0] as object).sort()).toEqual([
      'agree',
      'at',
      'fail_kind',
      'id',
      'input_tokens',
      'module',
      'ok',
      'output_tokens',
      'provider',
      'purpose',
    ]);
    expect(JSON.stringify(rows)).not.toContain('Z-CANARY');
  });

  it('[실사용 신호-던짐] 견주는 함수가 던지거나 참·거짓이 아닌 값을 내도 호출은 그대로 성공하고 null로 남아요', async () => {
    await db.query('delete from ai_usage');
    const gateway = new AiGateway(answering({ id: 'x' }), true, db);
    const throwing = (): boolean => {
      throw new Error('Z-CANARY');
    };
    await expect(gateway.structured({ ...req, agrees: throwing })).resolves.toEqual({ id: 'x' });
    await expect(gateway.structured({ ...req, agrees: (() => 'Z-CANARY') as unknown as () => boolean })).resolves.toEqual({ id: 'x' });
    expect(await agreeRows()).toEqual([
      { provider: 'gemini', ok: true, agree: null },
      { provider: 'gemini', ok: true, agree: null },
    ]);
    expect(JSON.stringify((await db.query('select * from ai_usage')).rows)).not.toContain('Z-CANARY');
  });

  it('[실사용 신호-접기] 운영 표는 목적별 견준 수·다른 수만 주고, 견준 수가 10건이 안 되는 목적은 수를 접어요', async () => {
    await db.query('delete from ai_usage');
    const same = new AiGateway(answering({ id: 'rule Z-CANARY' }), true, db);
    const differs = new AiGateway(answering({ id: 'model Z-CANARY' }), true, db);
    for (let i = 0; i < SIGNAL_FOLD_MIN - 1; i += 1) await (i < 3 ? differs : same).structured({ ...req, agrees });
    await differs.structured({ ...req, purpose: 'pick-room', agrees });
    // 견주지 않은 줄(가짜 공급자·견주는 함수 없음)은 견준 수에 들어가지 않아요.
    await new AiGateway(new FakeProvider(), true, db).structured({ ...req, agrees });
    await same.structured(req);
    expect((await same.usageByModule()).find((u) => u.module === 'rooms')?.agreement).toEqual([
      { purpose: 'chat-intent', folded: true },
      { purpose: 'pick-room', folded: true },
    ]);
    await same.structured({ ...req, agrees });
    const usage = await same.usageByModule();
    expect(usage).toEqual([
      {
        module: 'rooms',
        calls: SIGNAL_FOLD_MIN + 3,
        inputTokens: (SIGNAL_FOLD_MIN + 2) * 3,
        outputTokens: (SIGNAL_FOLD_MIN + 2) * 2,
        failures: 0,
        failureKinds: [],
        agreement: [
          { purpose: 'chat-intent', folded: false, compared: SIGNAL_FOLD_MIN, differed: 3 },
          { purpose: 'pick-room', folded: true },
        ],
      },
    ]);
    expect(JSON.stringify(usage)).not.toContain('Z-CANARY');
  });

  it('[실사용 신호-분류] 앞문 분류는 모델이 고른 종류가 낱말 규칙의 첫 종류와 같은지만 남겨요(문장·슬롯 값 없음)', async () => {
    await db.query('delete from ai_usage');
    const classified = (kind: string) => ({
      kind,
      ambiguous: false,
      slots: { date: null, start: null, minutes: null, people: 6, equipment: [], floor: null, itemName: 'Z-CANARY 과자' },
    });
    const now = Date.parse('2026-11-17T01:00:00Z');
    const text = 'Z-CANARY 내일 3시 회의실 6명';
    expect((await classifyText(new AiGateway(answering(classified('rooms')), true, db), text, ['rooms'], now)).kind).toBe('rooms');
    expect((await classifyText(new AiGateway(answering(classified('rooms')), true, db), text, ['navi', 'rooms'], now)).kind).toBe('rooms');
    // 규칙이 아무 종류도 못 고르면 규칙 답은 모름이에요.
    await classifyText(new AiGateway(answering(classified('unknown')), true, db), text, [], now);
    await classifyText(new AiGateway(answering(classified('pantry')), true, db), text, [], now);
    // 가짜 공급자(키 없는 개발·시험)는 견주지 않아요.
    await classifyText(new AiGateway(new FakeProvider(), true, db), text, ['rooms'], now);
    expect(await agreeRows()).toEqual([
      { provider: 'gemini', ok: true, agree: true },
      { provider: 'gemini', ok: true, agree: false },
      { provider: 'gemini', ok: true, agree: true },
      { provider: 'gemini', ok: true, agree: false },
      { provider: 'fake', ok: true, agree: null },
    ]);
    const rows = (await db.query<{ module: string; purpose: string }>('select * from ai_usage')).rows;
    expect(JSON.stringify(rows)).not.toMatch(/Z-CANARY|과자|회의실/);
    expect([...new Set(rows.map((r) => `${r.module}/${r.purpose}`))]).toEqual(['router/classify']);
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
    ).toEqual([
      'leave_prepare',
      'my_requests_status',
      'navi_find_team',
      'navi_it_faq',
      'navi_onboarding',
      'notices_search',
      'pantry_find_similar',
      'rooms_find_equipment',
      'rooms_find_free',
    ]);
    const roomsLinkOnly = settings({ mcp: true, modules: { ...DEFAULT_OPS_SETTINGS.modules, rooms: 'link', navi: 'link', pantry: 'link' } });
    expect(listMcpTools(roomsLinkOnly).map((t) => t.name)).toEqual(['notices_search']);
  });

  it('[ADR-10] 꺼진 모듈은 도구를 받지 못해요', () => {
    const off = settings({ modules: { ...DEFAULT_OPS_SETTINGS.modules, notices: 'off' } });
    expect(toolsForModule('notices', off)).toEqual([]);
  });

  it('[R4] 같이 채워요 단독 모드는 navi·notices·rooms가 모두 끔일 때예요', () => {
    expect(isPantryStandalone(DEFAULT_OPS_SETTINGS)).toBe(false);
    expect(isPantryStandalone(settings({ modules: { navi: 'off', notices: 'off', rooms: 'off', pantry: 'on', cafeteria: 'off' } }))).toBe(true);
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
