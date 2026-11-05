import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderFailure, type StructuredRequest } from './gateway';
import { GeminiProvider } from './gemini-provider';

// Gemini 공급자(11/3): 요청 모양, 답 검사, 실패를 오류 본문 없이 다루는지 봐요. 실제 네트워크는 부르지 않아요.

const schema = z.object({ kind: z.enum(['navi', 'rooms']), sure: z.boolean() }).strict();
const req = (input = '회의실 잡아 줘'): StructuredRequest<z.infer<typeof schema>> => ({
  module: 'router',
  purpose: 'classify',
  grade: 0,
  system: '종류를 골라요',
  input,
  schema,
  fallback: () => ({ kind: 'navi', sure: false }),
});

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

const ok = (text: string, usage = { promptTokenCount: 12, candidatesTokenCount: 5 }) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: usage }), { status: 200 });

describe('Gemini 공급자', () => {
  it('정해진 모델 하나로 generateContent를 부르고, 키는 머리에만 넣고, JSON 모양으로 받아 zod로 검사해요', async () => {
    const { impl, calls } = fakeFetch(() => ok('{"kind":"rooms","sure":true}'));
    const provider = new GeminiProvider('gemini-3.5-flash', 'g-key', 'https://gemini.test/', impl);
    const res = await provider.complete(req());
    expect(res).toEqual({ output: { kind: 'rooms', sure: true }, inputTokens: 12, outputTokens: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gemini.test/v1beta/models/gemini-3.5-flash:generateContent');
    expect(calls[0]!.url).not.toContain('g-key');
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.systemInstruction.parts[0].text).toBe('종류를 골라요');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '회의실 잡아 줘' }] }]);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema).toMatchObject({ type: 'object' });
    // 도구는 보내지 않아요(LLM에는 쓰기 도구가 없어요).
    expect(body).not.toHaveProperty('tools');
  });

  it('막힘·빈 답·JSON 아님·모양 틀림은 다른 모델로 넘기지 않고 실패예요', async () => {
    const cases = [
      new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 }),
      new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }), { status: 200 }),
      ok('그냥 글이에요'),
      ok('{"kind":"pantry","sure":true}'),
    ];
    const kinds: string[] = [];
    for (const response of cases) {
      const { impl, calls } = fakeFetch(() => response);
      const err = await new GeminiProvider('gemini-3.5-flash', 'k', undefined, impl).complete(req()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderFailure);
      kinds.push((err as ProviderFailure).kind);
      expect(calls).toHaveLength(1);
    }
    // 비용 표에 남는 실패 종류(11/5)
    expect(kinds).toEqual(['refusal', 'max_tokens', 'parse', 'parse']);
  });

  it('오류 응답은 상태 번호만 남기고, 본문(입력이 되울려 나올 수 있어요)은 읽지 않아요', async () => {
    const canary = '카나리-GEMINI-ERR';
    const { impl } = fakeFetch(() => new Response(JSON.stringify({ error: { message: `bad input: ${canary}` } }), { status: 400 }));
    const err = await new GeminiProvider('gemini-3.5-flash', 'k', undefined, impl).complete(req(canary)).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderFailure);
    expect((err as ProviderFailure).kind).toBe('http-400');
    expect((err as Error).message).toContain('400');
    expect((err as Error).message).not.toContain(canary);
  });
});
