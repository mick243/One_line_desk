import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { type LlmProvider, ProviderFailure, type ProviderResult, type StructuredRequest } from './gateway';

// 무보관 계약이 된 모델 하나로 고정해요(ADR-10). 거절 시 다른 모델로 넘기는 fallbacks는 쓰지 않아요.
// 다른 모델로 넘어가면 "모델 고정"이 깨지기 때문이에요. 거절이면 실패로 다뤄 화면이 다시 시도하게 해요.
// 무보관 대상이 아닌 기능(Files API·Batch·MCP connector)은 쓰지 않아요.
/**
 * 시간 제한(11/11 QA Q7): SDK 기본(10분, 다시 시도 2번)이면 화면이 15초에 포기한 뒤에도 서버가 계속 기다리고 비용을 써요.
 * Gemini 공급자(30초)보다 짧게 20초, 다시 시도는 한 번이에요(일시적인 429·5xx만 SDK가 다시 해요).
 */
export const ANTHROPIC_CLIENT_OPTIONS = { timeout: 20_000, maxRetries: 1 } as const;

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  private readonly client = new Anthropic(ANTHROPIC_CLIENT_OPTIONS);

  constructor(private readonly model: string) {}

  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    let res;
    try {
      res = await this.client.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        system: req.system,
        messages: [{ role: 'user', content: req.input }],
        output_config: { format: zodOutputFormat(req.schema), effort: req.effort ?? 'low' },
      });
    } catch (e) {
      // 실패 종류만 넘겨요(11/5). 오류 본문에는 모델 출력이 섞일 수 있어서 비용 표에 넣지 않아요.
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new ProviderFailure('timeout', '모델 응답이 늦어요');
      if (e instanceof Anthropic.APIError) throw new ProviderFailure(`http-${e.status ?? 'x'}`, '모델이 답하지 않았어요');
      if (e instanceof Error && /parse structured output/i.test(e.message)) throw new ProviderFailure('parse', '모델 답이 정해진 모양이 아니에요');
      throw new ProviderFailure('error', '모델을 부르지 못했어요');
    }
    if (res.stop_reason === 'refusal') throw new ProviderFailure('refusal', '모델이 답을 만들지 않았어요(refusal)');
    if (res.stop_reason === 'max_tokens') throw new ProviderFailure('max_tokens', '모델 답이 길이 상한에 걸렸어요');
    if (res.parsed_output == null) throw new ProviderFailure('no-output', `모델이 답을 만들지 않았어요(${res.stop_reason})`);
    return { output: res.parsed_output as T, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
  }
}
