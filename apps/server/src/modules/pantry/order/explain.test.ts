import { describe, expect, it } from 'vitest';
import { AiGateway, type LlmProvider, type ProviderResult, type StructuredRequest } from '../../../core/ai/gateway';
import type { Queryable } from '../../../core/db';
import { editedSentence, type ExplainLine, explainLines, hasKoreanNumeral, sentencePasses, templateSentence } from './explain';

// 주문안 설명 숫자 검사(ADR-08). 숫자가 그 줄 값이 아니거나 한글 수사가 있거나 줄이 빠지면 틀 문장이에요.

const LINES: ExplainLine[] = [
  { lineId: 'L1', itemName: '가상 탄산수 355', floor: '2층', votes: 9, amount: 12_000, reason: '층 최소 몫', rank: 1 },
  { lineId: 'L2', itemName: '가상 커피 믹스', floor: '2층', votes: 5, amount: 10_000, reason: '표 대비 값', rank: 2 },
  { lineId: 'L3', itemName: '가상 과자 상자', floor: '3층', votes: 6, amount: 24_000, reason: '예산 초과로 뺌', rank: 3 },
  { lineId: 'L4', itemName: '가상 초콜릿', floor: '3층', votes: 7, amount: 0, reason: '카탈로그에 없음', rank: 4 },
];

const noDb: Queryable = { query: async () => ({ rows: [] }) };

/** 정해 둔 문장을 돌려주고, 받은 입력을 기록하는 모의 모델 */
class ScriptedProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  inputs: string[] = [];
  constructor(private readonly reply: unknown) {}
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    this.inputs.push(req.input);
    return { output: req.schema.parse(this.reply), inputTokens: 1, outputTokens: 1 };
  }
}

describe('주문안 설명 틀 문장', () => {
  it('[ADR-08] 틀 문장은 모두 숫자 검사를 지나요', () => {
    for (const line of LINES) expect(sentencePasses(templateSentence(line), line)).toBe(true);
  });

  it('틀 문장은 이유 코드마다 달라요', () => {
    expect(templateSentence(LINES[0]!)).toBe('2층 최소 몫을 먼저 채우려고 넣었어요(층 안 표 대비 값 1위).');
    expect(templateSentence(LINES[1]!)).toBe('최소 몫을 채운 뒤 남은 예산으로 표 대비 값이 큰 순서대로 넣었어요(표 5개, 10,000원).');
    expect(templateSentence(LINES[2]!)).toBe('넣으면 예산을 넘어서 뺐어요(표 6개, 24,000원).');
    expect(templateSentence(LINES[3]!)).toBe('카탈로그에 없는 품목이라 단가를 몰라 넣지 않았어요.');
  });

  it('[ADR-08] 총무가 고친 줄은 고친 내용의 틀 문장이에요', () => {
    expect(editedSentence({ included: false, quantity: 24, amount: 12_000 })).toBe('총무가 주문안에서 뺐어요.');
    expect(editedSentence({ included: true, quantity: 48, amount: 24_000 })).toBe('총무가 수량을 48개로 고쳤어요(24,000원).');
  });
});

describe('[ADR-08] 근거 숫자 검사', () => {
  const line = LINES[0]!;

  it('그 줄 값(표·금액·순위·층·품목 이름 속 숫자)만 있으면 지나요', () => {
    expect(sentencePasses('2층 표 9개로 층 안 1위라 먼저 넣었어요.', line)).toBe(true);
    expect(sentencePasses('가상 탄산수 355는 12,000원이라 2층 몫으로 넣었어요.', line)).toBe(true);
    expect(sentencePasses('표가 많아서 먼저 넣었어요.', line)).toBe(true);
  });

  it('그 줄 값이 아닌 숫자가 있으면 걸려요', () => {
    expect(sentencePasses('표 10개를 받아 먼저 넣었어요.', line)).toBe(false);
    expect(sentencePasses('12,500원이라 넣었어요.', line)).toBe(false);
    expect(sentencePasses('표 대비 값이 1.5배 커요.', line)).toBe(false);
    expect(sentencePasses('２층에서 ３위예요.', line)).toBe(false);
  });

  it('한글 수사·한자 수사·"만 원" 표기가 있으면 걸려요', () => {
    for (const s of [
      '표 아홉 개를 받아 넣었어요.',
      '세 번째로 표 대비 값이 커요.',
      '첫 번째로 넣었어요.',
      '이층 최소 몫이라 넣었어요.',
      '층 안 일위라 넣었어요.',
      '만이천원이라 넣었어요.',
      '1만 2000원이라 넣었어요.',
      '표가 열 개예요.',
      '三층 몫이에요.',
      'nine votes라 넣었어요.',
    ]) {
      expect(hasKoreanNumeral(s), s).toBe(true);
      expect(sentencePasses(s, line), s).toBe(false);
    }
  });

  it('"이 층"·"이번"·"한정" 같은 흔한 말은 수사로 보지 않아요', () => {
    for (const s of ['이 층 최소 몫을 먼저 채우려고 넣었어요.', '이번 주기 요청이에요.', '한정 수량이에요.', '열린 요청 중 표가 많아요.', '세트 상품이에요.']) {
      expect(hasKoreanNumeral(s), s).toBe(false);
    }
  });

  it('여러 줄이거나 너무 긴 문장은 걸려요', () => {
    expect(sentencePasses('넣었어요.\n그리고 더 넣었어요.', line)).toBe(false);
    expect(sentencePasses('가'.repeat(161), line)).toBe(false);
    expect(sentencePasses('   ', line)).toBe(false);
  });
});

// 품목 이름은 직원이 쓴 글이라 등급 1이에요. AI 문장을 받는 시험은 무보관 계약을 확인한 게이트웨이(contract=true)로 해요.
const CONTRACT = true;

describe('[ADR-08] 설명 받기', () => {
  it('[H1] 무보관 계약 전에는 공급자를 부르지 않고(등급 1 거절) 모든 줄이 틀 문장이에요', async () => {
    const provider = new ScriptedProvider({ lines: [{ lineId: 'L1', sentence: '2층에서 표 9개로 1위라 최소 몫을 채우려고 넣었어요.' }] });
    const result = await explainLines(new AiGateway(provider, false, noDb), LINES);
    expect(provider.inputs).toEqual([]);
    expect([...result.values()].map((e) => e.source)).toEqual(['template', 'template', 'template', 'template']);
  });

  it('LLM에는 줄 ID·품목 이름·층·표 수·금액·이유 코드·순위만 보내요(투표자 없음)', async () => {
    const provider = new ScriptedProvider({ lines: [] });
    await explainLines(new AiGateway(provider, CONTRACT, noDb), LINES);
    const sent = JSON.parse(provider.inputs[0]!) as { lines: Record<string, unknown>[] };
    for (const l of sent.lines) expect(Object.keys(l).sort()).toEqual(['amount', 'floor', 'itemName', 'lineId', 'rank', 'reason', 'votes']);
    expect(provider.inputs[0]).not.toMatch(/p_|pseudonym|author|voter/);
  });

  it('[ADR-08] 숫자가 다른 줄·한글 수사 줄·빠진 줄은 틀 문장, 맞는 줄은 AI 문장이에요', async () => {
    const provider = new ScriptedProvider({
      lines: [
        { lineId: 'L1', sentence: '2층에서 표 9개로 1위라 최소 몫을 채우려고 넣었어요.' },
        { lineId: 'L2', sentence: '표 50개를 받아 남은 예산으로 넣었어요.' },
        { lineId: 'L3', sentence: '넣으면 예산을 넘어서 표 여섯 개짜리 품목을 뺐어요.' },
        { lineId: 'L9', sentence: '없는 줄이에요.' },
      ],
    });
    const result = await explainLines(new AiGateway(provider, CONTRACT, noDb), LINES);
    expect(result.get('L1')).toEqual({ sentence: '2층에서 표 9개로 1위라 최소 몫을 채우려고 넣었어요.', source: 'ai' });
    expect(result.get('L2')).toEqual({ sentence: templateSentence(LINES[1]!), source: 'template' });
    expect(result.get('L3')).toEqual({ sentence: templateSentence(LINES[2]!), source: 'template' });
    expect(result.get('L4')).toEqual({ sentence: templateSentence(LINES[3]!), source: 'template' });
    expect(result.has('L9')).toBe(false);
  });

  it('모델 호출이 실패하면 모든 줄이 틀 문장이에요', async () => {
    const failing: LlmProvider = {
      name: 'anthropic',
      async complete() {
        throw new Error('네트워크 오류');
      },
    };
    const result = await explainLines(new AiGateway(failing, CONTRACT, noDb), LINES);
    expect([...result.values()].every((e) => e.source === 'template')).toBe(true);
  });

  it('모델 없이(FakeProvider 대안) 돌면 계약 뒤에도 틀 문장 그대로이고 AI 문장으로 세지 않아요', async () => {
    const { FakeProvider } = await import('../../../core/ai/gateway');
    const result = await explainLines(new AiGateway(new FakeProvider(), CONTRACT, noDb), LINES);
    expect([...result.values()].map((e) => e.source)).toEqual(['template', 'template', 'template', 'template']);
  });
});
