import { GRADE, gatewayAllows, type Grade, type ModuleKind } from '@one-line-desk/shared';
import type { z } from 'zod';
import type { Queryable } from '../db';
import { DeskError } from '../errors';

// LLM은 이 게이트웨이 하나로만 불러요(ADR-10).
// 등급 검사 → 고정된 공급자 한 번 호출(요청마다 상태 없음) → 본문 없는 비용 기록.
// 쓰기 도구는 어디에도 없어요. 결과는 늘 zod로 검증한 구조 값이에요.

export interface StructuredRequest<T> {
  module: ModuleKind | 'router';
  /** 비용 표에 남는 목적 이름(예: 'classify', 'pick-row') */
  purpose: string;
  /** 보내는 자료의 등급. 모의 어댑터 자료면 0, 실제 사내 자료면 1이에요. */
  grade: Grade;
  system: string;
  input: string;
  schema: z.ZodType<T>;
  /** 모델 없이 돌 때(FakeProvider) 쓰는 결정적 결과. 시험과 키 없는 개발에서 써요. */
  fallback: () => T;
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

export interface ProviderResult<T> {
  output: T;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  readonly name: 'anthropic' | 'gemini' | 'fake';
  complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>>;
}

/** 모델을 부르지 않고 호출한 쪽의 결정적 대안을 돌려줘요. */
export class FakeProvider implements LlmProvider {
  readonly name = 'fake' as const;
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    return { output: req.schema.parse(req.fallback()), inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * 공급자 실패와 그 종류(11/5). 비용 표에는 종류 코드만 남겨요(글·오류 본문은 남기지 않아요).
 * refusal · max_tokens · no-output · parse(구조 검사) · http-<상태 번호> · timeout · error
 */
export class ProviderFailure extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

export class GatewayRefused extends DeskError {
  constructor(grade: Grade) {
    super('grade-refused', 422, `등급 ${grade} 자료는 AI로 보내지 않아요`);
  }
}

export class AiGateway {
  constructor(
    private readonly provider: LlmProvider,
    private readonly contractConfirmed: boolean,
    private readonly db: Queryable,
  ) {}

  get providerName(): LlmProvider['name'] {
    return this.provider.name;
  }

  /** 실제 모델이 답을 만드는지. 가짜 공급자는 부르는 쪽의 결정적 대안을 돌려줘서, 카드에 "AI 정리"를 붙이면 안 돼요. */
  get modelBacked(): boolean {
    return this.provider.name !== 'fake';
  }

  /** 사람이 쓴 글과 같은 등급 1을 보낼 수 있는지(무보관 계약 확인). 관리자 정답률 화면이 [AI로 다시 재기]를 열지 정해요. */
  get allowsInternal(): boolean {
    return gatewayAllows(GRADE.internal, this.contractConfirmed);
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    if (!gatewayAllows(req.grade, this.contractConfirmed)) throw new GatewayRefused(req.grade);
    try {
      const res = await this.provider.complete(req);
      await this.recordUsage(req, res.inputTokens, res.outputTokens, true);
      return res.output;
    } catch (e) {
      await this.recordUsage(req, 0, 0, false, e instanceof ProviderFailure ? e.kind : 'error');
      if (e instanceof DeskError) throw e;
      throw new DeskError('ai-failed', 502, '지금 답을 만들지 못했어요');
    }
  }

  /** 모듈별 AI 비용(운영 표). 본문은 없어요. */
  async usageByModule(): Promise<
    {
      module: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      failures: number;
      failureKinds: { purpose: string; kind: string; count: number }[];
    }[]
  > {
    const { rows } = await this.db.query<{ module: string; calls: number; input_tokens: number; output_tokens: number; failures: number }>(
      `select module, count(*)::int as calls, coalesce(sum(input_tokens), 0)::int as input_tokens,
              coalesce(sum(output_tokens), 0)::int as output_tokens, count(*) filter (where not ok)::int as failures
         from ai_usage group by module order by module`,
    );
    // 실패 종류(11/5): 목적·종류별 수만이에요. 글은 없어요.
    const { rows: kinds } = await this.db.query<{ module: string; purpose: string; kind: string; count: number }>(
      `select module, purpose, coalesce(fail_kind, 'error') as kind, count(*)::int as count
         from ai_usage where not ok group by module, purpose, coalesce(fail_kind, 'error') order by module, purpose, kind`,
    );
    return rows.map((r) => ({
      module: r.module,
      calls: r.calls,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      failures: r.failures,
      failureKinds: kinds.filter((k) => k.module === r.module).map((k) => ({ purpose: k.purpose, kind: k.kind, count: Number(k.count) })),
    }));
  }

  /** 보관 기간(7일, 10/28)이 지난 사용량 줄을 지워요. 운영 표의 AI 비용은 최근 7일 합계가 돼요. */
  async purgeUsage(before: number): Promise<void> {
    await this.db.query('delete from ai_usage where at < $1', [new Date(before).toISOString()]);
  }

  private async recordUsage(req: StructuredRequest<unknown>, inputTokens: number, outputTokens: number, ok: boolean, failKind?: string): Promise<void> {
    await this.db.query('insert into ai_usage (module, purpose, provider, input_tokens, output_tokens, ok, fail_kind) values ($1, $2, $3, $4, $5, $6, $7)', [
      req.module,
      req.purpose,
      this.provider.name,
      inputTokens,
      outputTokens,
      ok,
      ok ? null : safeKind(failKind),
    ]);
  }
}

/** 표 검사(소문자·숫자·-·_ 40자)에 맞는 종류 코드만 남겨요. 아니면 error예요. */
function safeKind(kind: string | undefined): string {
  return kind && /^[a-z0-9_-]{1,40}$/.test(kind) ? kind : 'error';
}
