import { type AiEvalResponse, HOME_MOVE_LABEL, type HomeMoveTo, LOAN_KINDS, personNameWords, ROUTER_MODULES } from '@one-line-desk/shared';
import type { AiGateway } from '../core/ai/gateway';
import { interpretByRules as homeByRules, interpretHomeText } from '../core/home';
import { classifyText } from '../core/router';
import { matchRules } from '../core/router-rules';
import { chatReadLabel, interpretByRules as chatByRules, interpretChatText } from '../modules/rooms/chat';
import { type EvalTask, GOLDEN, type GoldenCase } from './ai-golden';

// 정답률 표(11/5 시험, AI 보완 1번). 같은 정답 단 문장을 "낱말 규칙"과 "AI"로 각각 나눠 보고 맞힌 수를 세요.
// 서버가 쓰는 해석 함수를 그대로 불러요(interpretHomeText·interpretChatText·classifyText). DB·감사·저장은 없어요.
// 되돌릴 기준: #30 머지 상태(이 폴더째 지워요).

/** 시험 시계: 2026-10-26(월) 09:00 KST(서버 시험과 같아요) */
export const EVAL_NOW = Date.parse('2026-10-26T09:00:00+09:00');
/** 홈 규칙이 직원 이름 낱말로 "서준 오늘 자리에 있어?"를 알아봐요. 가상 직원 이름만 써요. */
const NAMES = ['가상 직원 서준', '가상 직원 하은', '가상 직원 주원', '가상 직원 도윤'].flatMap((n) => personNameWords(n));

export interface CaseResult extends GoldenCase {
  rule: string;
  /** AI가 답한 것. 모델 없이 돌았거나 모델이 실패하면 'error'예요. AI를 안 돌렸으면 없어요. */
  ai?: string;
}

const homeKey = (r: { intent: string; moveTo: HomeMoveTo | null }) => (r.intent === 'move' ? `move:${r.moveTo}` : r.intent);
const chatKey = (r: { intent: string; kinds: readonly string[] }) => {
  const kinds = LOAN_KINDS.filter((k) => r.kinds.includes(k));
  return kinds.length ? `${r.intent}:${kinds.join('·')}` : r.intent;
};

function byRules(c: GoldenCase): string {
  switch (c.task) {
    case 'home':
      return homeKey(homeByRules(c.text, NAMES));
    case 'room-chat':
      return chatKey(chatByRules(c.text, EVAL_NOW));
    case 'router':
      return matchRules(c.text, ROUTER_MODULES)[0] ?? 'unknown';
  }
}

async function byModel(gateway: AiGateway, c: GoldenCase): Promise<string> {
  switch (c.task) {
    case 'home': {
      const r = await interpretHomeText(gateway, c.text, NAMES);
      return r.byModel ? homeKey(r) : 'error';
    }
    case 'room-chat': {
      const r = await interpretChatText(gateway, c.text, EVAL_NOW);
      return r.byModel ? chatKey(r) : 'error';
    }
    case 'router': {
      const r = await classifyText(gateway, c.text, matchRules(c.text, ROUTER_MODULES), EVAL_NOW);
      return r.byModel ? r.kind : 'error';
    }
  }
}

/** 정답 단 문장을 모두 돌려요. gateway가 있으면 AI도 돌려요(동시에 4개씩). */
export async function runGolden(gateway: AiGateway | null, cases: readonly GoldenCase[] = GOLDEN): Promise<CaseResult[]> {
  const out: CaseResult[] = cases.map((c) => ({ ...c, rule: byRules(c) }));
  if (!gateway) return out;
  for (let i = 0; i < out.length; i += 4) {
    await Promise.all(
      out.slice(i, i + 4).map(async (r) => {
        r.ai = await byModel(gateway, r).catch(() => 'error');
      }),
    );
  }
  return out;
}

export interface TaskScore {
  task: EvalTask;
  total: number;
  rule: number;
  ai: number | null;
  /** AI만 맞힌 문장 수 / 규칙만 맞힌 문장 수 */
  aiOnly: number;
  ruleOnly: number;
}

export const TASKS: readonly EvalTask[] = ['home', 'room-chat', 'router'];
export const TASK_LABEL: Record<EvalTask, string> = { home: '홈 채팅(무엇을 하려는지)', 'room-chat': '회의실 채팅(할 일·장비)', router: '기능 나누기(/ask)' };

export function score(results: readonly CaseResult[]): TaskScore[] {
  return TASKS.map((task) => {
    const rows = results.filter((r) => r.task === task);
    const ran = rows.some((r) => r.ai !== undefined);
    return {
      task,
      total: rows.length,
      rule: rows.filter((r) => r.rule === r.expect).length,
      ai: ran ? rows.filter((r) => r.ai === r.expect).length : null,
      aiOnly: rows.filter((r) => r.ai === r.expect && r.rule !== r.expect).length,
      ruleOnly: rows.filter((r) => r.ai !== undefined && r.rule === r.expect && r.ai !== r.expect).length,
    };
  });
}

const HOME_WORD: Record<string, string> = { mine: '내 일', 'team-schedule': '같은 팀 일정', unknown: '모르는 말' };
const CHAT_INTENTS_FOR_LABEL = new Set(['reserve', 'rent', 'my', 'overview', 'equipment', 'cancel', 'help']);
const ROUTER_WORD: Record<string, string> = { navi: '문의함', notices: '공지', rooms: '회의실', pantry: '같이 채워요', unknown: '모르는 말' };

/** "문의함" → "문의함으로", "회의실" → "회의실로": 받침이 있으면(ㄹ 받침 빼고) "으로"예요(11/5 문의함으로 이름이 바뀌며). */
function toward(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  const jong = code >= 0 && code < 11172 ? code % 28 : 0;
  return `${word}${jong === 0 || jong === 8 ? '로' : '으로'}`;
}

/** 정답 꼴을 화면 말로 바꿔요("move:navi" → "문의함으로 옮기기") */
export function keyLabel(task: EvalTask, key: string | undefined): string {
  if (key === undefined) return '—';
  if (key === 'error') return '답 못 함';
  if (task === 'home')
    return key.startsWith('move:') ? `${toward(HOME_MOVE_LABEL[key.slice(5) as HomeMoveTo] ?? key.slice(5))} 옮기기` : (HOME_WORD[key] ?? key);
  if (task === 'room-chat') {
    const [intent, kinds] = key.split(':') as [string, string | undefined];
    return CHAT_INTENTS_FOR_LABEL.has(intent) ? chatReadLabel({ intent: intent as never, kinds: kinds ? kinds.split('·') : [] } as never) : key;
  }
  return ROUTER_WORD[key] ?? key;
}

/** 관리자 화면(GET /api/ops/ai-eval)에 보낼 표: 맞힌 수와 틀린 문장(라벨로 바꿔요) */
export function evalView(results: readonly CaseResult[]): Pick<AiEvalResponse, 'scores' | 'misses'> {
  return {
    scores: score(results).map((s) => ({ ...s, label: TASK_LABEL[s.task] })),
    misses: results
      .filter((r) => r.rule !== r.expect || (r.ai !== undefined && r.ai !== r.expect))
      .map((r) => ({
        label: TASK_LABEL[r.task],
        text: r.text,
        expect: keyLabel(r.task, r.expect),
        rule: keyLabel(r.task, r.rule),
        ruleOk: r.rule === r.expect,
        ai: r.ai === undefined ? null : keyLabel(r.task, r.ai),
        aiOk: r.ai === undefined ? null : r.ai === r.expect,
        why: r.why ?? null,
      })),
  };
}

const pct = (n: number, total: number) => `${n}/${total} (${Math.round((n / total) * 100)}%)`;

/** 마크다운 표. model은 표에 적는 모델 이름이에요(없으면 AI 칸이 "안 잼"). */
export function renderReport(results: readonly CaseResult[], o: { model: string | null; date: string }): string {
  const scores = score(results);
  const lines = [
    '# AI 정답률 표',
    '',
    `> 11/5 시험 기능(AI 보완 1번). 마음에 안 들면 #30 머지 상태로 되돌려요. 만든 명령: \`npm run eval:ai -- --write\` · 잰 날: ${o.date} · 모델: ${o.model ?? '안 잼(키 없음)'}`,
    '',
    '같은 정답 단 문장을 **낱말 규칙**(모델 없이 도는 해석기)과 **AI**(서버가 쓰는 같은 해석 함수 + 모델)로 나눠 보고 맞힌 수를 셌어요.',
    '문장은 개발자가 지은 가상 문장이에요(`apps/server/src/eval/ai-golden.ts`). 정답은 "이렇게 나눠야 맞다"이고, 지금 규칙이 하는 대로 적지 않았어요.',
    '',
    '| 해석하는 곳 | 문장 | 낱말 규칙 | AI | AI만 맞힘 | 규칙만 맞힘 |',
    '|---|---|---|---|---|---|',
    ...scores.map(
      (s) =>
        `| ${TASK_LABEL[s.task]} | ${s.total} | ${pct(s.rule, s.total)} | ${s.ai === null ? '안 잼' : pct(s.ai, s.total)} | ${s.ai === null ? '—' : s.aiOnly} | ${s.ai === null ? '—' : s.ruleOnly} |`,
    ),
  ];
  const total = scores.reduce((a, s) => a + s.total, 0);
  const ruleAll = scores.reduce((a, s) => a + s.rule, 0);
  const aiAll = scores.every((s) => s.ai !== null) ? scores.reduce((a, s) => a + (s.ai ?? 0), 0) : null;
  lines.push(`| **모두** | ${total} | ${pct(ruleAll, total)} | ${aiAll === null ? '안 잼' : pct(aiAll, total)} | | |`, '');

  const differ = results.filter((r) => r.rule !== r.expect || (r.ai !== undefined && r.ai !== r.expect));
  lines.push('## 틀린 문장', '', '| 해석하는 곳 | 문장 | 정답 | 낱말 규칙 | AI | 왜 이 정답인지 |', '|---|---|---|---|---|---|');
  for (const r of differ) {
    const mark = (k: string | undefined) => (k === undefined ? '—' : `${k === r.expect ? '✓' : '✗'} ${keyLabel(r.task, k)}`);
    lines.push(`| ${TASK_LABEL[r.task]} | ${r.text} | ${keyLabel(r.task, r.expect)} | ${mark(r.rule)} | ${mark(r.ai)} | ${r.why ?? ''} |`);
  }
  if (!differ.length) lines.push('| — | 틀린 문장이 없어요 | | | | |');
  lines.push(
    '',
    '## 읽는 법',
    '',
    '- AI는 문장 뜻만 구조 값으로 나눠요. 날짜 계산·회의실 고르기·실행은 서버 규칙이 해요. 모델이 없거나 무보관 계약 확인 전이면 낱말 규칙으로 돌아요.',
    '- 회의실 채팅 바로 실행은 AI와 낱말 규칙이 같은 일로 볼 때만이에요(10/29 회의 A1). 그래서 AI가 맞히고 규칙이 틀린 문장은 카드로만 보여 줘요.',
    '- 화면의 "알아들은 것" 줄(AI 보완 2번)은 AI가 낱말 규칙과 다르게 본 문장에서 "낱말로만 보면 ○○"를 같이 보여 줘요.',
    '- 운영자는 앱 마이 페이지 > [운영자 · AI 정답률]에서 같은 표를 보고, [AI로 다시 재기]로 시연 모델의 AI 칸을 채워요(1시간에 한 번).',
    '',
  );
  return lines.join('\n');
}
