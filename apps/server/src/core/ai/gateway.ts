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
  /**
   * 모델 답이 낱말 규칙 답과 같은지 견줘요(11/17, 실사용 신호). 비용 표에는 같음·다름만 남아요(글·값 없음).
   * 실제 모델이 답했을 때만 불러요. 없으면 그 호출은 견주지 않아요. 던지면 안 견준 것으로 봐요.
   */
  agrees?: (output: T) => boolean;
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

/**
 * 실사용 신호(같음·다름, 고침 여부)는 이보다 적으면 수를 접어요(11/17). 작은 묶음으로 누가 썼는지 짐작하지 못하게요
 * (받은 문의 주간 셈 INQUIRY_WEEK_MIN과 같은 방식이에요).
 */
export const SIGNAL_FOLD_MIN = 10;

/** 목적 하나의 모델·규칙 견줌(운영 표). 견준 수가 SIGNAL_FOLD_MIN보다 적으면 folded이고 숫자 칸이 없어요. */
export interface AgreementStat {
  purpose: string;
  folded: boolean;
  /** 실제 모델 답을 규칙 답과 견준 수 */
  compared?: number;
  /** 그중 규칙 답과 달랐던 수 */
  differed?: number;
}

export class GatewayRefused extends DeskError {
  constructor(grade: Grade) {
    super('grade-refused', 422, `등급 ${grade} 자료는 AI로 보내지 않아요`);
  }
}

/** 하루 AI 호출 상한에 걸렸을 때(11/11 QA Q7). 부르는 쪽은 다른 실패처럼 낱말 규칙으로 답해요("AI 정리" 없음). */
export class AiDailyLimitReached extends DeskError {
  constructor() {
    super('ai-daily-limit', 503, '오늘 AI 사용 한도를 다 써서 낱말 규칙으로만 찾아요');
  }
}

export class AiGateway {
  /**
   * dailyCalls: 회사 전체 하루(한국 시간) 실제 모델 호출 상한(운영 값 aiDailyCalls, 11/11 QA Q7). 0이면 모델을 부르지 않아요.
   * 없으면 상한 없음이에요(시험·정답률 재기). 가짜 공급자는 세지 않아요.
   */
  constructor(
    private readonly provider: LlmProvider,
    private readonly contractConfirmed: boolean,
    private readonly db: Queryable,
    private readonly dailyCalls?: () => number,
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
    if (this.dailyCalls && this.modelBacked && (await this.callsToday()) >= this.dailyCalls()) {
      await this.recordUsage(req, 0, 0, false, 'daily-limit');
      throw new AiDailyLimitReached();
    }
    try {
      const res = await this.provider.complete(req);
      await this.recordUsage(req, res.inputTokens, res.outputTokens, true, undefined, this.agreement(req, res.output));
      return res.output;
    } catch (e) {
      await this.recordUsage(req, 0, 0, false, e instanceof ProviderFailure ? e.kind : 'error');
      if (e instanceof DeskError) throw e;
      throw new DeskError('ai-failed', 502, '지금 답을 만들지 못했어요');
    }
  }

  /**
   * 모델 답이 낱말 규칙 답과 같았는지(11/17, 실사용 신호). 같음·다름만 돌려주고 답 자체는 어디에도 남기지 않아요.
   * 가짜 공급자는 규칙 답을 그대로 돌려줘서 늘 같음이라 견주지 않아요(null). 견주는 함수가 없거나 던져도 null이에요.
   */
  private agreement<T>(req: StructuredRequest<T>, output: T): boolean | null {
    if (!this.modelBacked || !req.agrees) return null;
    try {
      const same: unknown = req.agrees(output);
      return typeof same === 'boolean' ? same : null;
    } catch {
      return null;
    }
  }

  /**
   * 모듈별 AI 비용(운영 표). 본문은 없어요.
   * agreement(11/17): 목적별로 실제 모델 답을 규칙 답과 견준 수·달랐던 수예요. 견준 수가 10건이 안 되면 수를 접어요.
   */
  async usageByModule(): Promise<
    {
      module: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      failures: number;
      failureKinds: { purpose: string; kind: string; count: number }[];
      agreement: AgreementStat[];
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
    // 모델·규칙 견줌(11/17): 목적별 수만이에요. 견주지 않은 줄(agree null: 가짜 공급자·실패·견주는 함수 없음)은 세지 않아요.
    const { rows: agreed } = await this.db.query<{ module: string; purpose: string; compared: number; differed: number }>(
      `select module, purpose, count(*)::int as compared, count(*) filter (where not agree)::int as differed
         from ai_usage where agree is not null group by module, purpose order by module, purpose`,
    );
    return rows.map((r) => ({
      module: r.module,
      calls: Number(r.calls),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      failures: Number(r.failures),
      failureKinds: kinds.filter((k) => k.module === r.module).map((k) => ({ purpose: k.purpose, kind: k.kind, count: Number(k.count) })),
      agreement: agreed
        .filter((a) => a.module === r.module)
        .map((a) =>
          Number(a.compared) < SIGNAL_FOLD_MIN
            ? { purpose: a.purpose, folded: true }
            : { purpose: a.purpose, folded: false, compared: Number(a.compared), differed: Number(a.differed) },
        ),
    }));
  }

  /** 오늘(한국 시간) 실제 모델을 부른 수. 상한에 걸려 부르지 않은 줄은 세지 않아요. 비용 줄의 시각(DB 시계)으로 세요. */
  private async callsToday(): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `select count(*)::int as n from ai_usage
        where at >= (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
          and provider <> 'fake' and fail_kind is distinct from 'daily-limit'`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** 보관 기간(7일, 10/28)이 지난 사용량 줄을 지워요. 운영 표의 AI 비용은 최근 7일 합계가 돼요. */
  async purgeUsage(before: number): Promise<void> {
    await this.db.query('delete from ai_usage where at < $1', [new Date(before).toISOString()]);
  }

  /** 비용 줄 하나. 요청에서는 모듈·목적 이름만 읽어요(글·답은 넣지 않아요). agree는 같음·다름뿐이고 실패한 호출은 null이에요. */
  private async recordUsage(
    req: { module: string; purpose: string },
    inputTokens: number,
    outputTokens: number,
    ok: boolean,
    failKind?: string,
    agree: boolean | null = null,
  ): Promise<void> {
    await this.db.query(
      'insert into ai_usage (module, purpose, provider, input_tokens, output_tokens, ok, fail_kind, agree) values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [req.module, req.purpose, this.provider.name, inputTokens, outputTokens, ok, ok ? null : safeKind(failKind), ok ? agree : null],
    );
  }
}

/** 표 검사(소문자·숫자·-·_ 40자)에 맞는 종류 코드만 남겨요. 아니면 error예요. */
function safeKind(kind: string | undefined): string {
  return kind && /^[a-z0-9_-]{1,40}$/.test(kind) ? kind : 'error';
}
