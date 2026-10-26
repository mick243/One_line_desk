import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { LlmProvider, ProviderResult, StructuredRequest } from './gateway';

// 무보관 계약이 된 모델 하나로 고정해요(ADR-10). 거절 시 다른 모델로 넘기는 fallbacks는 쓰지 않아요.
// 다른 모델로 넘어가면 "모델 고정"이 깨지기 때문이에요. 거절이면 실패로 다뤄 화면이 다시 시도하게 해요.
// 무보관 대상이 아닌 기능(Files API·Batch·MCP connector)은 쓰지 않아요.
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  private readonly client = new Anthropic();

  constructor(private readonly model: string) {}

  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages: [{ role: 'user', content: req.input }],
      output_config: { format: zodOutputFormat(req.schema), effort: req.effort ?? 'low' },
    });
    if (res.stop_reason === 'refusal' || res.parsed_output == null) {
      throw new Error(`모델이 답을 만들지 않았어요(${res.stop_reason})`);
    }
    return { output: res.parsed_output as T, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
  }
}
