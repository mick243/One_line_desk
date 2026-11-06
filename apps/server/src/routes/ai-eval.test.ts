import type { AiEvalResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AiGateway, type LlmProvider, type ProviderResult, type StructuredRequest } from '../core/ai/gateway';
import { GOLDEN } from '../eval/ai-golden';
import { NOTICE_GOLDEN } from '../eval/notice-golden';
import { createTestApp, MOCK } from '../testing';

// 관리자 화면 AI 정답률(11/5 시험, R7 예외). 운영자만 보고, AI 재기는 뒤에서 한 번에 하나·1시간에 한 번이에요.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

/** 실제 모델 흉내: 부르는 쪽의 규칙 해석을 그대로 돌려줘요(호출 수만 세요). */
class EchoProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  calls: string[] = [];
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    this.calls.push(req.input);
    return { output: req.schema.parse(req.fallback()), inputTokens: 1, outputTokens: 1 };
  }
}

async function setup(o: { provider?: LlmProvider; contract?: boolean } = {}) {
  const t = await createTestApp(o.provider ? { provider: o.provider } : {});
  opened.push(t);
  if (o.provider) t.ctx.gateway = new AiGateway(o.provider, o.contract ?? true, t.db);
  return t;
}

async function untilDone(me: Awaited<ReturnType<TestApp['loginAs']>>): Promise<AiEvalResponse> {
  for (let i = 0; i < 200; i += 1) {
    const res = (await me.call('GET', '/api/ops/ai-eval')).body as AiEvalResponse;
    if (!res.run.running) return res;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('재기가 끝나지 않았어요');
}

describe('관리자 AI 정답률(11/5 시험)', () => {
  it('운영자만 봐요. 다른 역할은 보기도 재기도 403이에요', async () => {
    const t = await setup();
    for (const who of [MOCK.staff, MOCK.dev, MOCK.facilities, MOCK.hr]) {
      const me = await t.loginAs(who);
      expect((await me.call('GET', '/api/ops/ai-eval')).status, who).toBe(403);
      expect((await me.call('POST', '/api/ops/ai-eval/run')).status, who).toBe(403);
    }
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('GET', '/api/ops/ai-eval')).status).toBe(200);
  });

  it('모델이 없으면 낱말 규칙만 세고, [AI로 다시 재기]는 이유와 함께 막혀요', async () => {
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    const res = (await op.call('GET', '/api/ops/ai-eval')).body as AiEvalResponse;
    expect(res.scores.map((s) => [s.label, s.total, s.ai])).toEqual([
      ['홈 채팅(무엇을 하려는지)', 29, null],
      ['회의실 채팅(할 일·장비)', 14, null],
      ['기능 나누기(/ask)', 13, null],
    ]);
    expect(res.misses.find((m) => m.text === '회의실 TV가 안 켜져요')).toMatchObject({ expect: '문의함으로 옮기기', ruleOk: false, ai: null });
    // 공지 알림 대상(11/6): 가상 직원 17명으로 센 놓친 사람·더 받은 사람이에요. 이름은 없어요.
    expect(res.notices).toMatchObject({ total: NOTICE_GOLDEN.length, people: 17, ai: null });
    expect(res.notices.misses.find((m) => m.title === '택배 보관함 이전')).toMatchObject({
      expect: '모두',
      rule: { label: '1층', ok: false, missed: 16, extra: 0 },
      ai: null,
    });
    expect(JSON.stringify(res.notices)).not.toMatch(/가상 (직원|총무|인사|운영자)|mock\||@corp\.example/);
    expect(res).toMatchObject({ measured: null, run: { running: false, allowed: false, reason: 'AI 공급자가 연결되지 않아 낱말 규칙만 재요' } });
    expect((await op.call('POST', '/api/ops/ai-eval/run')).status).toBe(409);
  });

  it('무보관 계약 확인 전이면 모델이 있어도 재지 않아요', async () => {
    const provider = new EchoProvider();
    const t = await setup({ provider, contract: false });
    const op = await t.loginAs(MOCK.operator);
    expect(((await op.call('GET', '/api/ops/ai-eval')).body as AiEvalResponse).run.reason).toBe('무보관 계약 확인 전이라 AI로 재지 않아요');
    expect((await op.call('POST', '/api/ops/ai-eval/run')).status).toBe(409);
    expect(provider.calls).toEqual([]);
  });

  it('재기는 뒤에서 돌고, 끝나면 AI 칸·잰 때·모델이 채워져요. 1시간 안에는 다시 못 재고, 감사에는 맞힌 수만 남아요', async () => {
    const provider = new EchoProvider();
    const t = await setup({ provider });
    const op = await t.loginAs(MOCK.operator);
    const started = (await op.call('POST', '/api/ops/ai-eval/run')).body as AiEvalResponse;
    expect(started.run).toMatchObject({ running: true, allowed: false, reason: '지금 재는 중이에요' });
    const done = await untilDone(op);
    // 문장 다음 공지까지 같은 게이트웨이로 재요. 흉내 모델은 규칙 답을 돌려줘서 AI 칸이 규칙 칸과 같아요.
    expect(provider.calls).toHaveLength(GOLDEN.length + NOTICE_GOLDEN.length);
    expect(done.measured).toMatchObject({ model: t.ctx.config.aiModel });
    for (const s of done.scores) expect(s.ai, s.label).toBe(s.rule);
    expect(done.notices.ai).toEqual(done.notices.rule);
    expect(done.run).toMatchObject({ allowed: false, reason: '10:00부터 다시 잴 수 있어요' });
    expect((await op.call('POST', '/api/ops/ai-eval/run')).status).toBe(409);
    t.advance(59 * 60_000);
    expect((await op.call('POST', '/api/ops/ai-eval/run')).status).toBe(409);
    t.advance(60_000);
    expect(((await op.call('GET', '/api/ops/ai-eval')).body as AiEvalResponse).run).toMatchObject({ allowed: true, reason: null });

    const audit = (await t.ctx.audit.recent(5)).find((a) => a.action === 'ai-eval.run');
    expect(audit).toMatchObject({
      channel: 'ops',
      result: `ai:${done.scores.reduce((n, s) => n + (s.ai ?? 0), 0)}/${GOLDEN.length},notice:${done.notices.ai!.exact}/${NOTICE_GOLDEN.length}`,
    });
    expect(JSON.stringify(await t.ctx.audit.recent(20))).not.toContain('회의실 TV');
    expect(JSON.stringify(await t.ctx.audit.recent(20))).not.toContain('택배');
  });
});
