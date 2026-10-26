import { randomUUID } from 'node:crypto';
import { type Card, checkInput, type ModuleKind, type OpsSettings, type PlanConfirmResponse, type PlanCreateResponse } from '@one-line-desk/shared';
import type { AuditLog } from './audit';
import type { Db, Queryable } from './db';
import { DeskError } from './errors';
import type { ExecOutcome, PlanHandler } from './module';
import type { ProposalPayload, ProposalTokens } from './proposal-token';
import type { DeskUser } from './user';

// 쓰기 실행 경계(ADR-03, R2). LLM은 제안만 하고, 사람의 확인은 쓰기마다 정확히 한 번이에요.
// - create: 제안 토큰 → plan 저장 → 확인 시트
// - confirm: plan_id만 받아 "proposed일 때만 executing으로" 바꾸고 실행(한 번만 이겨요)
// - direct: 공개 미리보기 [올리기]. 토큰 ID가 멱등 키예요

interface PlanRow {
  id: string;
  pseudonym_id: string;
  module: ModuleKind;
  action: string;
  params: unknown;
  expires_at: Date;
  state: string;
  result: StoredOutcome | null;
}

type StoredOutcome = { status: 'done'; card: Card } | { status: 'blocked'; card: Card; alternatives: Card[] };

const EXPIRED_MESSAGE = '시간이 지나 다시 찾았어요';

export class PlanService {
  private readonly handlers = new Map<string, PlanHandler<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly tokens: ProposalTokens,
    private readonly audit: AuditLog,
    private readonly settings: () => OpsSettings,
    private readonly now: () => number,
  ) {}

  register(handler: PlanHandler<unknown>): void {
    const key = `${handler.module}:${handler.action}`;
    if (this.handlers.has(key)) throw new Error(`plan 처리기가 겹쳐요: ${key}`);
    this.handlers.set(key, handler);
  }

  /** 카드에 붙일 제안 토큰을 만들어요. 모듈은 이것만 부르고 DB에는 쓰지 않아요. */
  propose(user: Pick<DeskUser, 'pseudonymId'>, module: ModuleKind, action: string, params: Record<string, unknown>): string {
    if (!this.handlers.has(`${module}:${action}`)) throw new Error(`plan 처리기가 없어요: ${module}:${action}`);
    return this.tokens.sign(user.pseudonymId, module, action, params);
  }

  async create(user: DeskUser, token: string): Promise<PlanCreateResponse> {
    const { payload, handler, expired } = this.open(user, token);
    const params = handler.schema.parse(payload.p);
    if (expired) return { status: 'expired', message: EXPIRED_MESSAGE, cards: (await handler.reSearch?.(params, user)) ?? [] };
    if (!handler.sheet) throw new DeskError('bad-request', 400, '이 제안은 확인 시트가 없어요');
    this.assertEnabled(handler);

    const planId = randomUUID();
    const expiresAt = new Date(this.now() + this.settings().values.planTtlSeconds * 1000);
    await this.db.query('insert into plans (id, pseudonym_id, module, action, params, expires_at) values ($1, $2, $3, $4, $5, $6)', [
      planId,
      user.pseudonymId,
      handler.module,
      handler.action,
      JSON.stringify(params),
      expiresAt.toISOString(),
    ]);
    return { status: 'sheet', planId, sheet: await handler.sheet(params, user), expiresAt: expiresAt.toISOString() };
  }

  async confirm(user: DeskUser, planId: string): Promise<PlanConfirmResponse> {
    const nowIso = new Date(this.now()).toISOString();
    const outcome = await this.db.tx(async (q) => {
      const { rows } = await q.query<PlanRow>(
        `update plans set state = 'executing'
          where id = $1 and pseudonym_id = $2 and state = 'proposed' and expires_at > $3
          returning id, pseudonym_id, module, action, params, expires_at, state, result`,
        [planId, user.pseudonymId, nowIso],
      );
      const plan = rows[0];
      if (!plan) return null;
      const handler = this.handlerFor(plan.module, plan.action);
      const params = handler.schema.parse(plan.params);
      const result = await this.runHandler(q, handler, params, user, plan.id);
      await this.finish(q, plan.id, handler, params, result);
      await this.audit.record(
        { pseudonymId: user.pseudonymId, channel: 'write', module: plan.module, action: plan.action, planId: plan.id, result: result.status },
        q,
      );
      return result;
    });
    if (outcome) return outcome;
    return this.afterLostRace(user, planId, nowIso);
  }

  /** 공개 미리보기 [올리기]: 토큰과 사용자가 확정한 값으로 plan 만들기와 실행을 한 번에 해요(R2). */
  async direct(user: DeskUser, token: string, edits: Record<string, unknown>): Promise<PlanConfirmResponse> {
    const { payload, handler, expired } = this.open(user, token);
    // 확인 시트가 있는 제안(회의실 예약 등)은 시트를 건너뛰고 바로 실행할 수 없어요(ADR-03).
    if (handler.sheet) throw new DeskError('bad-request', 400, '확인 시트를 거쳐야 하는 제안이에요');
    const allowed = new Set(handler.editableKeys ?? []);
    for (const key of Object.keys(edits)) {
      if (!allowed.has(key)) throw new DeskError('bad-request', 400, '고칠 수 없는 칸이에요');
    }
    // 사용자가 고친 값도 공통 검사를 다시 지나야 해요(ADR-11). 걸리면 내용 없이 거부해요.
    for (const value of Object.values(edits)) {
      if (typeof value === 'string' && checkInput(value).locks.length > 0) throw new DeskError('locked', 400, '올릴 수 없는 글자가 있어요');
    }
    const params = handler.schema.parse({ ...payload.p, ...edits });

    // 이미 실행한 토큰이면 만료와 상관없이 그때 결과를 돌려줘요.
    const receiptKey = `plan:${payload.jti}`;
    const prior = await this.receipt(receiptKey);
    if (prior) return prior;
    if (expired) return { status: 'expired', message: '시간이 지나 다시 확인해 주세요', cards: (await handler.reSearch?.(params, user)) ?? [] };

    return this.db.tx(async (q) => {
      // 같은 토큰이 동시에 두 번 와도 한 번만 실행해요. 키로 잠근 뒤 영수증을 다시 봐요.
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [receiptKey]);
      const raced = await this.receipt(receiptKey, q);
      if (raced) return raced;
      const planId = randomUUID();
      await q.query("insert into plans (id, pseudonym_id, module, action, params, expires_at, state) values ($1, $2, $3, $4, $5, $6, 'executing')", [
        planId,
        user.pseudonymId,
        handler.module,
        handler.action,
        JSON.stringify(params),
        new Date(payload.exp).toISOString(),
      ]);
      const result = this.assertEnabledOutcome(handler) ?? (await this.runHandler(q, handler, params, user, planId));
      await this.finish(q, planId, handler, params, result);
      await q.query('insert into action_receipts (idempotency_key, pseudonym_id, module, action, result) values ($1, $2, $3, $4, $5)', [
        receiptKey,
        user.pseudonymId,
        handler.module,
        handler.action,
        JSON.stringify(result),
      ]);
      await this.audit.record(
        { pseudonymId: user.pseudonymId, channel: 'write', module: handler.module, action: handler.action, planId, result: result.status },
        q,
      );
      return result;
    });
  }

  private open(user: DeskUser, token: string): { payload: ProposalPayload; handler: PlanHandler<unknown>; expired: boolean } {
    const verified = this.tokens.verify(token, user.pseudonymId);
    if (!verified.ok && verified.reason === 'owner') throw new DeskError('not-owner', 403, '다른 사람이 받은 링크라 열 수 없어요');
    if (!verified.ok && verified.reason === 'bad') throw new DeskError('bad-token', 400, '제안을 확인하지 못했어요. 다시 찾아 주세요');
    const payload = verified.ok ? verified.payload : verified.payload!;
    return { payload, handler: this.handlerFor(payload.m, payload.a), expired: !verified.ok };
  }

  private handlerFor(module: ModuleKind, action: string): PlanHandler<unknown> {
    const handler = this.handlers.get(`${module}:${action}`);
    if (!handler) throw new DeskError('bad-request', 400, '알 수 없는 제안이에요');
    return handler;
  }

  /**
   * 제안 토큰을 실행하지 않고 열어 봐요(M3 앱 확인 링크). 토큰 주인이 아니면 거부해요.
   * 링크를 연 것만으로는 아무것도 쓰지 않아요. 만료돼도 서명이 맞으면 값을 돌려줘서 같은 조건으로 다시 찾게 해요.
   */
  peek(user: DeskUser, token: string): { module: ModuleKind; action: string; params: unknown; expired: boolean } {
    const { payload, handler, expired } = this.open(user, token);
    return { module: handler.module, action: handler.action, params: handler.schema.parse(payload.p), expired };
  }

  private isEnabled(handler: PlanHandler<unknown>): boolean {
    const settings = this.settings();
    return handler.enabled ? handler.enabled(settings) : settings.modules[handler.module] === 'on';
  }

  private assertEnabled(handler: PlanHandler<unknown>): void {
    if (!this.isEnabled(handler)) throw new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
  }

  private assertEnabledOutcome(handler: PlanHandler<unknown>): StoredOutcome | null {
    return this.isEnabled(handler) ? null : { status: 'blocked', card: featureOffCard(handler.module), alternatives: [] };
  }

  private async runHandler(q: Queryable, handler: PlanHandler<unknown>, params: unknown, user: DeskUser, planId: string): Promise<StoredOutcome> {
    const off = this.assertEnabledOutcome(handler);
    if (off) return off;
    const outcome: ExecOutcome = await handler.execute(params, { q, user, planId, now: this.now() });
    return outcome.status === 'done' ? outcome : { status: 'blocked', card: outcome.card, alternatives: outcome.alternatives ?? [] };
  }

  /** 조건부 UPDATE에서 이기지 못했을 때: 이미 끝난 plan이면 결과만, 만료면 다시 찾기. */
  private async afterLostRace(user: DeskUser, planId: string, nowIso: string): Promise<PlanConfirmResponse> {
    const { rows } = await this.db.query<PlanRow>(
      'select id, pseudonym_id, module, action, params, expires_at, state, result from plans where id = $1 and pseudonym_id = $2',
      [planId, user.pseudonymId],
    );
    const plan = rows[0];
    if (!plan) throw new DeskError('not-found', 404, '확인할 제안을 찾지 못했어요');
    if (plan.result) return plan.result;
    if (plan.state === 'proposed' && new Date(plan.expires_at).toISOString() <= nowIso) {
      await this.db.query("update plans set state = 'expired' where id = $1 and state = 'proposed'", [plan.id]);
      const handler = this.handlerFor(plan.module, plan.action);
      return { status: 'expired', message: EXPIRED_MESSAGE, cards: (await handler.reSearch?.(handler.schema.parse(plan.params), user)) ?? [] };
    }
    throw new DeskError('in-progress', 409, '처리하는 중이에요. 잠시 뒤에 다시 확인해 주세요');
  }

  /** 실행 결과를 plan 행에 남겨요. 매개변수는 처리기가 정한 만큼만 남겨요. */
  private async finish(q: Queryable, planId: string, handler: PlanHandler<unknown>, params: unknown, result: StoredOutcome): Promise<void> {
    const kept = handler.storedParams ? handler.storedParams(params, result) : params;
    await q.query('update plans set state = $2, result = $3, params = $4 where id = $1', [planId, result.status, JSON.stringify(result), JSON.stringify(kept)]);
  }

  private async receipt(key: string, q: Queryable = this.db): Promise<StoredOutcome | null> {
    const { rows } = await q.query<{ result: StoredOutcome }>('select result from action_receipts where idempotency_key = $1', [key]);
    return rows[0]?.result ?? null;
  }
}

export function featureOffCard(module: ModuleKind): Card {
  return {
    id: `feature-off-${module}`,
    kind: module,
    label: '막힘',
    headline: '기능이 방금 꺼졌어요',
    fields: [],
    evidence: { text: '운영 설정', aiSummarized: false },
    actions: { secondary: [] },
    tail: '아무것도 바뀌지 않았어요',
  };
}
