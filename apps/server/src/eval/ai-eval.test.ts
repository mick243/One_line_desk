import { HOME_MOVE_TO, KINDS, LOAN_KINDS } from '@one-line-desk/shared';
import { describe, expect, it } from 'vitest';
import { AiGateway, type LlmProvider, type ProviderResult, type StructuredRequest } from '../core/ai/gateway';
import type { Queryable } from '../core/db';
import { CHAT_INTENTS } from '../modules/rooms/chat';
import { renderReport, runGolden, score } from './ai-eval';
import { GOLDEN, type GoldenCase } from './ai-golden';

// 정답률 표(11/5 시험, AI 보완 1번). 실제 모델은 부르지 않아요. 문장 표 모양, 낱말 규칙 바닥값, 표를 세는 길만 봐요.

const noDb: Queryable = { query: async () => ({ rows: [] }) };

/** 정답을 아는 가짜 모델: 문장을 찾아 정답 모양으로 돌려줘요(입력이 해석 함수까지 바르게 가는지 봐요). */
class OracleProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    const text = req.purpose === 'home-ask' ? req.input : req.input.slice(req.input.indexOf('문장: ') + 4);
    const task = req.purpose === 'home-ask' ? 'home' : req.purpose === 'chat-intent' ? 'room-chat' : 'router';
    const c = GOLDEN.find((g) => g.task === task && g.text === text);
    if (!c) throw new Error(`정답 표에 없는 문장: ${text}`);
    return { output: req.schema.parse(answerOf(c)), inputTokens: 1, outputTokens: 1 };
  }
}

function answerOf(c: GoldenCase): unknown {
  if (c.task === 'home') {
    const [intent, moveTo] = c.expect.split(':');
    return { intent, period: 'recent', kinds: [], moveTo: moveTo ?? null };
  }
  if (c.task === 'room-chat') {
    const [intent, kinds] = c.expect.split(':');
    return { intent, command: false, kinds: kinds ? kinds.split('·') : [] };
  }
  const slots = { date: null, start: null, minutes: null, people: null, equipment: [], floor: null, itemName: null };
  return { kind: c.expect, ambiguous: false, slots };
}

class FailingProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  async complete<T>(): Promise<ProviderResult<T>> {
    throw new Error('모델이 답하지 않았어요');
  }
}

describe('정답률 표(11/5 시험)', () => {
  it('정답 표는 해석하는 곳마다 10문장 넘고, 겹치지 않고, 정답 꼴이 맞아요', () => {
    for (const task of ['home', 'room-chat', 'router'] as const) {
      const rows = GOLDEN.filter((g) => g.task === task);
      expect(rows.length, task).toBeGreaterThanOrEqual(10);
      expect(new Set(rows.map((r) => r.text)).size, task).toBe(rows.length);
    }
    expect(GOLDEN.length).toBeGreaterThanOrEqual(30);
    expect(GOLDEN.length).toBeLessThanOrEqual(60);
    for (const g of GOLDEN) {
      if (g.task === 'home') {
        const [intent, moveTo] = g.expect.split(':') as [string, string | undefined];
        expect(['mine', 'team-schedule', 'unknown', 'move'], g.text).toContain(intent);
        if (intent === 'move') expect(HOME_MOVE_TO as readonly string[], g.text).toContain(moveTo);
      } else if (g.task === 'room-chat') {
        const [intent, kinds] = g.expect.split(':') as [string, string | undefined];
        expect(CHAT_INTENTS as readonly string[], g.text).toContain(intent);
        for (const k of kinds ? kinds.split('·') : []) expect(LOAN_KINDS as readonly string[], g.text).toContain(k);
      } else {
        expect(KINDS as readonly string[], g.text).toContain(g.expect);
      }
    }
  });

  it('낱말 규칙 맞힌 수는 바닥값(11/5 처음 잰 값) 밑으로 내려가지 않아요', async () => {
    const scores = score(await runGolden(null));
    expect(scores.map((s) => [s.task, s.ai])).toEqual([
      ['home', null],
      ['room-chat', null],
      ['router', null],
    ]);
    // 11/5 처음 48문장: 16·12·10. 같은 날 홈 처음 보는 문장 3개·회의실 "빔프로젝터 남았어?"를 더해 16·13·10이에요.
    // 11/6 사내 카페 홈 문장 4개(주문 둘·커피값·탕비실 채우기)를 더했고 규칙이 넷 다 맞혀서 홈 바닥값을 20으로 올려요.
    const floor = { home: 20, 'room-chat': 13, router: 10 };
    for (const s of scores) expect(s.rule, s.task).toBeGreaterThanOrEqual(floor[s.task]);
  });

  it('AI 칸은 서버와 같은 해석 함수로 세요. 정답을 아는 모델이면 모두 맞고, 표에 "AI만 맞힘"이 나와요', async () => {
    const results = await runGolden(new AiGateway(new OracleProvider(), true, noDb));
    const scores = score(results);
    for (const s of scores) expect(s.ai, s.task).toBe(s.total);
    expect(scores.reduce((a, s) => a + s.aiOnly, 0)).toBe(scores.reduce((a, s) => a + s.total - s.rule, 0));
    const report = renderReport(results, { model: 'claude-test', date: '2026-11-05' });
    expect(report).toContain('| 홈 채팅(무엇을 하려는지) | 29 |');
    expect(report).toContain('회의실 TV가 안 켜져요');
    expect(report).toContain('모델: claude-test');
  });

  it('모델이 실패하거나 무보관 계약 확인 전이면 AI 칸은 "답 못 함"으로 세고 규칙 답을 AI 답으로 세지 않아요', async () => {
    for (const gateway of [new AiGateway(new FailingProvider(), true, noDb), new AiGateway(new OracleProvider(), false, noDb)]) {
      const results = await runGolden(gateway, GOLDEN.slice(0, 3));
      expect(results.map((r) => r.ai)).toEqual(['error', 'error', 'error']);
    }
  });
});
