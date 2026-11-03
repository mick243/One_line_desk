import { z } from 'zod';
import type { LlmProvider, ProviderResult, StructuredRequest } from './gateway';

// Gemini 공급자(11/3 사용자 결정: Anthropic·Gemini 둘 다 쓸 수 있게, 기본은 Anthropic).
// Anthropic 공급자와 같은 약속을 지켜요: 무보관 계약이 된 모델 하나로 고정하고, 거절·빈 답이면 다른 모델로 넘기지 않고 실패로 다뤄요.
// 의존성을 더하지 않고 generateContent REST를 직접 불러요. 요청·응답 본문은 어디에도 기록하지 않아요.
// 결과는 JSON으로만 받아 zod로 다시 검사해요(스키마를 응답 형식으로도 같이 보내요).

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const TIMEOUT_MS = 30_000;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;

  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.input }] }],
        generationConfig: {
          maxOutputTokens: req.maxTokens ?? 4096,
          responseMimeType: 'application/json',
          responseJsonSchema: z.toJSONSchema(req.schema, { io: 'output', unrepresentable: 'any' }),
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 오류 응답 본문은 읽지 않아요. 입력이 되울려 나올 수 있어서 상태 번호만 남겨요.
    if (!res.ok) throw new Error(`Gemini가 답하지 않았어요(${res.status})`);
    const body = (await res.json()) as GeminiResponse;
    if (body.promptFeedback?.blockReason) throw new Error(`모델이 답을 만들지 않았어요(${body.promptFeedback.blockReason})`);
    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new Error(`모델이 답을 만들지 않았어요(${candidate?.finishReason ?? 'empty'})`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('모델 답이 JSON이 아니에요');
    }
    const output = req.schema.safeParse(parsed);
    if (!output.success) throw new Error('모델 답이 정해진 모양이 아니에요');
    return { output: output.data, inputTokens: body.usageMetadata?.promptTokenCount ?? 0, outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0 };
  }
}
