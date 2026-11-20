import { addDays, type Card, kstDate, type ModuleKind } from '@one-line-desk/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiGateway, FakeProvider } from './ai/gateway';
import { AuditLog } from './audit';
import { makeCard } from './cards';
import type { Db } from './db';
import { createTestDb } from './db/test-db';
import type { AskInput, DeskModule } from './module';
import { OpsSettingsStore } from './ops-settings';
import { Router } from './router';
import type { DeskUser } from './user';

const NOW = Date.parse('2026-10-26T09:00:00+09:00');
const user: DeskUser = { sessionId: 's', pseudonymId: 'p_me', idpSubject: 'x', displayName: '가상', department: '재무팀', floor: '3층', roles: ['employee'] };

let db: Db;
let ops: OpsSettingsStore;
let router: Router;
const seen: { kind: ModuleKind; input: AskInput }[] = [];

function fakeModule(kind: ModuleKind): DeskModule {
  return {
    kind,
    async ask(input) {
      seen.push({ kind, input });
      const card: Card = makeCard({ id: kind, kind, label: '안내', headline: kind, evidence: { text: 't', aiSummarized: false }, tail: '' });
      return { cards: [card], found: true };
    },
  };
}

beforeAll(async () => {
  db = await createTestDb();
  const audit = new AuditLog(db);
  ops = new OpsSettingsStore(audit, db);
  const modules = new Map<ModuleKind, DeskModule>((['navi', 'notices', 'rooms', 'pantry'] as const).map((k) => [k, fakeModule(k)]));
  router = new Router(modules, new AiGateway(new FakeProvider(), false, db), ops, audit, () => NOW);
});
afterAll(async () => {
  await db.close();
});

describe('앞문 라우터(ADR-02)', () => {
  it('담당 질문은 담당 안내로 가요', async () => {
    const res = await router.ask(user, '법인카드 잃어버렸어요');
    expect(res).toMatchObject({ kind: 'navi', confidence: 'high', cards: [{ id: 'navi' }] });
  });

  it('회의실 문장은 슬롯을 뽑아 회의실로 가요', async () => {
    await router.ask(user, '내일 3시 6명 화면 있는 방');
    expect(seen.at(-1)).toMatchObject({
      kind: 'rooms',
      input: { slots: { date: addDays(kstDate(NOW), 1), start: '15:00', people: 6, equipment: ['화면'] } },
    });
  });

  it('탕비실 문장은 품목 이름만 뽑아요', async () => {
    await router.ask(user, '제로콜라 또 넣어 주세요');
    expect(seen.at(-1)).toMatchObject({ kind: 'pantry', input: { slots: { itemName: '제로콜라' } } });
  });

  it('[ADR-02 시험] 경계 문장은 칩으로 되물어요', async () => {
    const res = await router.ask(user, '회의실 TV가 안 켜져요');
    expect(res.confidence).toBe('low');
    expect(res.cards).toEqual([]);
    expect(res.chips).toEqual(expect.arrayContaining(['rooms', 'navi']));
  });

  it('칩으로 고른 종류는 분류를 건너뛰어요', async () => {
    const res = await router.ask(user, '회의실 TV가 안 켜져요', 'navi');
    expect(res).toMatchObject({ kind: 'navi', confidence: 'high' });
  });

  it('[ADR-27 호출 수] 종류를 정해 물은 담당·공지 물음은 분류를 부르지 않고, 회의실·탕비실은 그대로 불러요', async () => {
    // 계약을 확인한 게이트웨이라야 호출이 비용 표에 남아요(확인 전에는 등급 1을 거절하고 줄을 안 써요).
    const audit = new AuditLog(db);
    const modules = new Map<ModuleKind, DeskModule>((['navi', 'notices', 'rooms', 'pantry'] as const).map((k) => [k, fakeModule(k)]));
    const counted = new Router(modules, new AiGateway(new FakeProvider(), true, db), ops, audit, () => NOW);
    const classifyCalls = async () =>
      Number((await db.query<{ n: number }>("select count(*)::int as n from ai_usage where purpose = 'classify'")).rows[0]?.n ?? 0);
    const before = await classifyCalls();
    expect(await counted.ask(user, '법인카드 잃어버렸어요', 'navi')).toMatchObject({ kind: 'navi', confidence: 'high', cards: [{ id: 'navi' }] });
    expect(await counted.ask(user, '연말정산 서류 언제까지 내요', 'notices')).toMatchObject({
      kind: 'notices',
      confidence: 'high',
      cards: [{ id: 'notices' }],
    });
    expect(await classifyCalls()).toBe(before);
    // 회의실은 슬롯을 분류 결과에서 받아서 종류를 정해 물어도 분류를 불러요.
    await counted.ask(user, '내일 3시 6명 화면 있는 방', 'rooms');
    expect(seen.at(-1)).toMatchObject({ kind: 'rooms', input: { slots: { start: '15:00', people: 6 } } });
    await counted.ask(user, '제로콜라 또 넣어 주세요', 'pantry');
    expect(seen.at(-1)).toMatchObject({ kind: 'pantry', input: { slots: { itemName: '제로콜라' } } });
    expect(await classifyCalls()).toBe(before + 2);
  });

  it('[ADR-02] 모르는 문장은 담당 안내(읽기 전용)로 가요', async () => {
    const res = await router.ask(user, '안녕하세요 반가워요');
    expect(res.kind).toBe('navi');
  });

  it('[R4] 링크만이면 그룹웨어 링크 카드, 끔이면 담당 안내로 가요', async () => {
    await ops.setModule('p_op', 'rooms', 'link');
    expect((await router.ask(user, '내일 3시 회의실 잡아 줘')).cards[0]).toMatchObject({ kind: 'rooms', label: '안내', headline: '이 일은 그룹웨어에서 해요' });
    await ops.setModule('p_op', 'rooms', 'off');
    expect((await router.ask(user, '내일 3시 회의실 잡아 줘')).kind).toBe('navi');
    await ops.setModule('p_op', 'rooms', 'on');
  });

  it('[R11] 묻기 감사 로그에는 모듈 종류와 결과만 남아요', async () => {
    await router.ask(user, '법인카드 잃어버렸어요 CANARY-ASK');
    const { rows } = await db.query("select * from audit_log where channel = 'ask'");
    expect(JSON.stringify(rows)).not.toContain('CANARY');
    expect(rows.length).toBeGreaterThan(0);
  });
});
