import { type AiEvalResponse, formatKstDateTime, kstTime } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { DeskError } from '../core/errors';
import { type CaseResult, evalView, runGolden, score } from '../eval/ai-eval';

// 관리자 화면 "AI 정답률"(11/5 시험, AI 보완 1번). 운영자(관리자)만 봐요. R7 예외: 운영자 웹 화면은 이 읽기 전용 화면 하나예요.
// - 표는 정답 단 가상 문장(src/eval/ai-golden.ts)으로만 재요. 직원이 쓴 글·사람 자료는 쓰지 않아요.
//   남는 것은 게이트웨이 비용 표(본문 없음, 7일)와 감사 한 줄(맞힌 수만)뿐이에요.
// - 낱말 규칙 칸은 열 때마다 바로 세요(모델 호출 없음).
// - [AI로 다시 재기]는 서버와 같은 게이트웨이로 문장 48개를 모델에 보내요(등급 1 규칙 그대로: 무보관 계약 확인 전이면 막혀요).
//   뒤에서 돌고(화면은 몇 초마다 다시 불러요), 한 번에 하나, 1시간에 한 번만이에요. 결과는 서버 메모리에만 있어서 다시 켜면 비어요.
// - 시연 웹(Vercel)은 운영자 API(/api/ops/*)를 넘기지 않는데, 이 두 경로만 예외로 넘겨요(11/5 사용자 결정, vercel.json).
//   시연은 누구나 가상 운영자로 들어올 수 있어서 재기 간격을 1시간으로 둬요(모델 호출 하루 최대 약 1,150번).
// 되돌릴 기준: #30 머지 상태(이 파일째 지워요).

const COOLDOWN_MS = 60 * 60_000;

export function registerAiEvalRoutes(app: FastifyInstance, ctx: AppContext) {
  const operator = [ctx.guards.user, ctx.guards.role('operator')];
  let last: { at: number; model: string; results: CaseResult[] } | null = null;
  let running = false;

  function runState(): AiEvalResponse['run'] {
    if (running) return { running, allowed: false, reason: '지금 재는 중이에요' };
    if (!ctx.gateway.modelBacked) return { running, allowed: false, reason: 'AI 공급자가 연결되지 않아 낱말 규칙만 재요' };
    if (!ctx.gateway.allowsInternal) return { running, allowed: false, reason: '무보관 계약 확인 전이라 AI로 재지 않아요' };
    if (last && ctx.now() - last.at < COOLDOWN_MS) return { running, allowed: false, reason: `${kstTime(last.at + COOLDOWN_MS)}부터 다시 잴 수 있어요` };
    return { running, allowed: true, reason: null };
  }

  async function view(): Promise<AiEvalResponse> {
    const results = last?.results ?? (await runGolden(null));
    return {
      ...evalView(results),
      measured: last ? { at: formatKstDateTime(last.at), model: last.model } : null,
      run: runState(),
    };
  }

  app.get('/api/ops/ai-eval', { preHandler: operator }, async () => view());

  app.post('/api/ops/ai-eval/run', { preHandler: operator }, async (req) => {
    const state = runState();
    if (!state.allowed) throw new DeskError('ai-eval-unavailable', 409, state.reason ?? '지금은 잴 수 없어요');
    running = true;
    const by = req.deskUser!.pseudonymId;
    // 뒤에서 재요. 끝나면 결과를 메모리에 두고, 감사에는 맞힌 수만 남겨요(문장·답 없음).
    void runGolden(ctx.gateway)
      .then(async (results) => {
        last = { at: ctx.now(), model: ctx.config.aiModel, results };
        const ai = score(results).reduce((n, s) => n + (s.ai ?? 0), 0);
        await ctx.audit.record({ pseudonymId: by, channel: 'ops', module: 'router', action: 'ai-eval.run', result: `ai:${ai}/${results.length}` });
      })
      .catch(async () => {
        await ctx.audit.record({ pseudonymId: by, channel: 'ops', module: 'router', action: 'ai-eval.run', result: 'failed' }).catch(() => undefined);
      })
      .finally(() => {
        running = false;
      });
    return view();
  });
}
