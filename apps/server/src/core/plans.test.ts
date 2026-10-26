import { DEFAULT_OPS_SETTINGS, type OpsSettings } from '@one-line-desk/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuditLog } from './audit';
import { makeCard } from './cards';
import type { Db } from './db';
import { createTestDb } from './db/test-db';
import type { PlanHandler } from './module';
import { PlanService } from './plans';
import { ProposalTokens } from './proposal-token';
import type { DeskUser } from './user';

// 시험용 쓰기: 이름 하나를 표에 넣어요. 같은 이름이면 막힘이에요.
const Params = z.object({ name: z.string().min(1).max(20) });
type Params = z.infer<typeof Params>;

const handler: PlanHandler<Params> = {
  module: 'rooms',
  action: 'test-write',
  schema: Params,
  editableKeys: ['name'],
  async sheet(p) {
    return { title: '확인', lines: [p.name], confirmLabel: '하기' };
  },
  async execute(p, ex) {
    const { rows } = await ex.q.query('insert into t_items (name) values ($1) on conflict do nothing returning id', [p.name]);
    const card = makeCard({
      id: p.name,
      kind: 'rooms',
      label: rows.length ? '확정' : '막힘',
      headline: p.name,
      evidence: { text: 't', aiSummarized: false },
      tail: '',
    });
    return rows.length ? { status: 'done', card } : { status: 'blocked', card };
  },
  async reSearch(p) {
    return [makeCard({ id: `again-${p.name}`, kind: 'rooms', label: '제안', headline: p.name, evidence: { text: 't', aiSummarized: false }, tail: '' })];
  },
};

// 바로 실행(게시) 시험용: 확인 시트가 없는 처리기예요.
const directHandler: PlanHandler<Params> = { ...handler, action: 'test-post', sheet: undefined };

const user = (pseudonymId = 'p_me'): DeskUser => ({
  sessionId: 's',
  pseudonymId,
  idpSubject: 'x',
  displayName: '가상',
  department: '재무팀',
  floor: '3층',
  roles: ['employee'],
});

let db: Db;
let clock = 1_000_000;
let settings: OpsSettings = DEFAULT_OPS_SETTINGS;
let plans: PlanService;
let tokens: ProposalTokens;

beforeAll(async () => {
  db = await createTestDb();
  await db.exec('create table t_items (id serial primary key, name text unique)');
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec('truncate t_items; truncate plans; truncate action_receipts');
  settings = DEFAULT_OPS_SETTINGS;
  tokens = new ProposalTokens(
    'secret',
    () => clock,
    () => 600_000,
  );
  plans = new PlanService(
    db,
    tokens,
    new AuditLog(db),
    () => settings,
    () => clock,
  );
  plans.register(handler as PlanHandler<unknown>);
  plans.register(directHandler as PlanHandler<unknown>);
});

describe('plan: 쓰기마다 사람 확인 한 번(ADR-03, R2)', () => {
  it('제안 토큰으로 확인 시트를 받고, 확인하면 실행돼요', async () => {
    const token = plans.propose(user(), 'rooms', 'test-write', { name: '가' });
    const created = await plans.create(user(), token);
    expect(created).toMatchObject({ status: 'sheet', sheet: { lines: ['가'] } });
    if (created.status !== 'sheet') throw new Error();
    expect((await db.query('select * from t_items')).rows).toHaveLength(0);

    const done = await plans.confirm(user(), created.planId);
    expect(done).toMatchObject({ status: 'done', card: { label: '확정' } });
    expect((await db.query('select * from t_items')).rows).toHaveLength(1);
  });

  it('[ADR-03 시험] 같은 plan_id를 동시에 여러 번 확인해도 실행은 한 번이에요', async () => {
    const created = await plans.create(user(), plans.propose(user(), 'rooms', 'test-write', { name: '나' }));
    if (created.status !== 'sheet') throw new Error();
    const results = await Promise.all([1, 2, 3].map(() => plans.confirm(user(), created.planId).catch((e: Error) => e)));
    expect(results.filter((r) => !(r instanceof Error) && r.status === 'done')).toHaveLength(3);
    expect((await db.query('select * from t_items')).rows).toHaveLength(1);
  });

  it('[ADR-03 시험] 남의 plan_id와 남의 토큰은 거부해요', async () => {
    const created = await plans.create(user(), plans.propose(user(), 'rooms', 'test-write', { name: '다' }));
    if (created.status !== 'sheet') throw new Error();
    await expect(plans.confirm(user('p_other'), created.planId)).rejects.toMatchObject({ status: 404 });
    await expect(plans.create(user('p_other'), plans.propose(user(), 'rooms', 'test-write', { name: '라' }))).rejects.toMatchObject({
      code: 'not-owner',
      message: '다른 사람이 받은 링크라 열 수 없어요',
    });
  });

  it('[ADR-03 시험] 만료된 plan을 확인하면 실행하지 않고 같은 조건으로 다시 찾아요', async () => {
    const created = await plans.create(user(), plans.propose(user(), 'rooms', 'test-write', { name: '마' }));
    if (created.status !== 'sheet') throw new Error();
    clock += 11 * 60 * 1000;
    const res = await plans.confirm(user(), created.planId);
    expect(res).toMatchObject({ status: 'expired', message: '시간이 지나 다시 찾았어요', cards: [{ id: 'again-마' }] });
    expect((await db.query('select * from t_items')).rows).toHaveLength(0);
  });

  it('[ADR-12 시험] 꺼진 모듈의 plan은 막힘(기능 꺼짐)으로 끝나요', async () => {
    const created = await plans.create(user(), plans.propose(user(), 'rooms', 'test-write', { name: '바' }));
    if (created.status !== 'sheet') throw new Error();
    settings = { ...DEFAULT_OPS_SETTINGS, modules: { ...DEFAULT_OPS_SETTINGS.modules, rooms: 'link' } };
    expect(await plans.confirm(user(), created.planId)).toMatchObject({ status: 'blocked', card: { label: '막힘', headline: '기능이 방금 꺼졌어요' } });
    expect((await db.query('select * from t_items')).rows).toHaveLength(0);
  });

  it('[ADR-03 시험] 확인 시트가 있는 제안은 바로 실행으로 보낼 수 없어요', async () => {
    const token = plans.propose(user(), 'rooms', 'test-write', { name: '차' });
    await expect(plans.direct(user(), token, {})).rejects.toMatchObject({ status: 400 });
    expect((await db.query('select * from t_items')).rows).toHaveLength(0);
    expect((await db.query('select * from plans')).rows).toHaveLength(0);
  });

  it('[R2] 바로 실행(게시)은 고칠 수 있는 칸만 받고, 같은 토큰은 한 번만 실행해요', async () => {
    const token = plans.propose(user(), 'rooms', 'test-post', { name: '사' });
    await expect(plans.direct(user(), token, { other: 1 })).rejects.toMatchObject({ status: 400 });
    const first = await plans.direct(user(), token, { name: '고친 이름' });
    const second = await plans.direct(user(), token, { name: '고친 이름' });
    expect(first).toEqual(second);
    expect((await db.query<{ name: string }>('select name from t_items')).rows).toEqual([{ name: '고친 이름' }]);
  });

  it('[R2] 이미 올린 토큰은 만료 뒤에 다시 와도 그때 결과를 돌려줘요', async () => {
    const token = plans.propose(user(), 'rooms', 'test-post', { name: '카' });
    const first = await plans.direct(user(), token, {});
    clock += 11 * 60 * 1000;
    expect(await plans.direct(user(), token, {})).toEqual(first);
    expect((await db.query('select * from t_items')).rows).toHaveLength(1);
  });

  it('[ADR-11 시험] 고친 값도 공통 검사를 다시 지나야 해요(만료된 토큰도)', async () => {
    const token = plans.propose(user(), 'rooms', 'test-post', { name: '타' });
    await expect(plans.direct(user(), token, { name: 'AKIAABCDEFGHIJKLMNOP' })).rejects.toMatchObject({ status: 400 });
    clock += 11 * 60 * 1000;
    await expect(plans.direct(user(), token, { name: 'AKIAABCDEFGHIJKLMNOP' })).rejects.toMatchObject({ status: 400 });
    expect((await db.query('select * from plans')).rows).toHaveLength(0);
  });

  it('[R2] 바로 실행 토큰이 만료되면 고친 값으로 다시 확인하게 해요', async () => {
    const token = plans.propose(user(), 'rooms', 'test-post', { name: '아' });
    clock += 11 * 60 * 1000;
    expect(await plans.direct(user(), token, { name: '자' })).toMatchObject({ status: 'expired', cards: [{ id: 'again-자' }] });
  });
});
