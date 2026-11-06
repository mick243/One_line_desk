import '../src/config';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { kstDate } from '@one-line-desk/shared';
import { AnthropicProvider } from '../src/core/ai/anthropic-provider';
import { AiGateway, type LlmProvider } from '../src/core/ai/gateway';
import { GeminiProvider } from '../src/core/ai/gemini-provider';
import type { Queryable } from '../src/core/db';
import { renderReport, runGolden, score, TASK_LABEL } from '../src/eval/ai-eval';
import { evalRoster, runNoticeGolden, scoreNotices } from '../src/eval/notice-eval';

// 정답률 표(11/5 시험, AI 보완 1번). 정답 단 가상 문장(src/eval/ai-golden.ts)을 낱말 규칙과 AI로 각각 나눠 보고 표로 보여 줘요.
// 11/6부터 가상 공지(src/eval/notice-golden.ts)의 알림 대상 제안도 같이 재요(놓친 사람·더 받은 사람, ADR-09).
//
//   npm run eval:ai                 표를 화면에 보여 줘요
//   npm run eval:ai -- --write      docs/AI정답률.md를 고쳐 써요
//
// - AI 쪽은 서버와 같은 설정일 때만 돌아요: DESK_AI_PROVIDER(anthropic|gemini) + 키 + NO_RETENTION_CONTRACT_CONFIRMED=true.
//   게이트웨이 등급 규칙을 그대로 지켜요(사람 글과 같은 등급 1로 보내요). 없으면 낱말 규칙만 재고 AI 칸은 "안 잼"이에요.
// - DB를 열지 않아요(비용 기록도 남기지 않아요). 개발 서버가 떠 있어도 돌릴 수 있어요.
// 되돌릴 기준: #30 머지 상태(이 파일째 지워요).

const env = process.env;
const write = process.argv.includes('--write');

function providerFromEnv(): { provider: LlmProvider; model: string } | null {
  if (env.DESK_AI_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) {
    const model = env.DESK_AI_MODEL ?? 'claude-opus-5-5';
    return { provider: new AnthropicProvider(model), model };
  }
  if (env.DESK_AI_PROVIDER === 'gemini' && env.GEMINI_API_KEY && env.DESK_AI_MODEL) {
    return { provider: new GeminiProvider(env.DESK_AI_MODEL, env.GEMINI_API_KEY, env.GEMINI_BASE_URL || undefined), model: env.DESK_AI_MODEL };
  }
  return null;
}

/** 비용 기록을 남기지 않는 빈 DB(게이트웨이가 ai_usage에 쓰려는 것을 받아만 둬요) */
const noDb: Queryable = { query: async () => ({ rows: [] }) };

async function main() {
  const picked = providerFromEnv();
  const contract = env.NO_RETENTION_CONTRACT_CONFIRMED === 'true';
  if (picked && !contract) console.error('무보관 계약 확인(NO_RETENTION_CONTRACT_CONFIRMED=true)이 없어 AI 쪽은 재지 않아요. 낱말 규칙만 재요.');
  if (!picked) console.error('AI 공급자·키가 없어 낱말 규칙만 재요(DESK_AI_PROVIDER, ANTHROPIC_API_KEY 또는 GEMINI_API_KEY·DESK_AI_MODEL).');
  const gateway = picked && contract ? new AiGateway(picked.provider, true, noDb) : null;

  const results = await runGolden(gateway);
  for (const s of score(results)) {
    const ai = s.ai === null ? '안 잼' : `${s.ai}/${s.total}`;
    console.error(`${TASK_LABEL[s.task]}: 낱말 규칙 ${s.rule}/${s.total} · AI ${ai}`);
  }
  // 공지 알림 대상(11/6): 가상 공지로 대상 제안을 재요. 사람 수는 앱에 든 가상 직원으로 세요.
  const notices = await runNoticeGolden(gateway);
  const n = scoreNotices(notices);
  const side = (x: typeof n.rule) =>
    `정확히 맞힘 ${x.exact}/${n.total} · 놓친 사람 0 ${x.missedNone}/${n.total} · 놓친 사람 ${x.missed} · 더 받은 사람 ${x.extra}`;
  console.error(`공지 알림 대상: 낱말 규칙 ${side(n.rule)} · AI ${n.ai === null ? '안 잼' : side(n.ai)}`);
  const people = (await evalRoster()).length;
  const report = renderReport(results, { model: gateway ? picked!.model : null, date: kstDate(Date.now()), notices: { results: notices, people } });
  if (write) {
    const path = resolve(process.cwd(), 'docs', 'AI정답률.md');
    writeFileSync(path, report, 'utf8');
    console.error(`썼어요: ${path}`);
  } else {
    console.log(report);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
