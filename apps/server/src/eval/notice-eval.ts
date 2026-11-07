import { NOTICE_AUDIENCE_ROLE_LABEL, type NoticeAudience, type NoticeEvalAnswer, type NoticeEvalSide, type NoticeEvalView } from '@one-line-desk/shared';
import { MockEmployees } from '../adapters/mock/employees';
import type { EmployeeProfile } from '../adapters/types';
import type { AiGateway } from '../core/ai/gateway';
import { matchesAudience, optionsOf, proposeAudience, proposeByRules, rolesOfProfile } from '../modules/notices/audience';
import { NOTICE_GOLDEN, NOTICE_GROUPS, type NoticeGoldenCase } from './notice-golden';

// 공지 알림 대상 정답률(11/6 사용자 결정 "정확도를 먼저 재 줘", ADR-09 개정). 자동 보내기(noticeAutoSend)를 운영에서 켜기 전에 보는 표예요.
// 서버가 쓰는 제안 함수를 그대로 불러요(proposeByRules·proposeAudience). 모델 입력은 공지 글과 부서·층·역할 이름 목록뿐이에요(modelInput).
// 사람 수는 앱에 든 가상 직원 17명으로 세요. 이 배포의 직원 명단(디렉터리)은 읽지 않아요(정답이 이 명단의 이름으로 적혀 있어서요).
// DB·감사·저장은 없어요. 관리자 화면에서 AI로 잴 때만 게이트웨이 비용 줄(본문 없음)이 남아요.
// AI 보완 1번 시험(#30)을 되돌릴 때도 이 표(notice-golden.ts·notice-eval.ts)는 남겨요. 자동 보내기를 켤지 정하는 근거예요.

/** 앱에 든 가상 직원 17명(시연·개발 기본 명단) */
export async function evalRoster(): Promise<EmployeeProfile[]> {
  const directory = new MockEmployees();
  const out: EmployeeProfile[] = [];
  for (const department of await directory.departments()) out.push(...(await directory.departmentMembers(department, 1000)));
  return out;
}

/** 제안 하나를 정답과 견준 것 */
export interface AudienceCheck {
  audience: NoticeAudience;
  /** 조건(모두·부서·층·역할)이 정답과 같은지. 같은 사람에게 가도 조건이 다르면 아니에요. */
  exact: boolean;
  /** 받아야 하는데 못 받는 사람 수 */
  missed: number;
  /** 받지 않아도 되는데 받는 사람 수 */
  extra: number;
}

export interface NoticeCaseResult extends NoticeGoldenCase {
  /** 받아야 할 사람 수 */
  shouldGet: number;
  rule: AudienceCheck;
  /** AI가 낸 것. 모델 없이 돌았거나 모델이 실패하면 'error'(답 못 함)예요. AI를 안 돌렸으면 없어요. */
  ai?: AudienceCheck | 'error';
}

const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();
const sameList = (a: readonly string[], b: readonly string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** 조건이 같은지(순서는 보지 않아요) */
export function sameAudience(a: NoticeAudience, b: NoticeAudience): boolean {
  if (a.everyone || b.everyone) return a.everyone === b.everyone;
  return sameList(a.departments, b.departments) && sameList(a.floors, b.floors) && sameList(a.roles, b.roles);
}

const receivers = (roster: readonly EmployeeProfile[], a: NoticeAudience) =>
  new Set(roster.filter((p) => matchesAudience({ department: p.department, floor: p.floor, roles: rolesOfProfile(p) }, a)).map((p) => p.idpSubject));

/** 정답과 제안을 사람 단위로 견줘요(놓친 사람·더 받은 사람). */
export function compareAudience(expect: NoticeAudience, got: NoticeAudience, roster: readonly EmployeeProfile[]): AudienceCheck {
  const want = receivers(roster, expect);
  const have = receivers(roster, got);
  return {
    audience: got,
    exact: sameAudience(expect, got),
    missed: [...want].filter((s) => !have.has(s)).length,
    extra: [...have].filter((s) => !want.has(s)).length,
  };
}

/** 정답 단 공지를 모두 돌려요. gateway가 있으면 AI도 돌려요(동시에 4개씩). */
export async function runNoticeGolden(gateway: AiGateway | null, cases: readonly NoticeGoldenCase[] = NOTICE_GOLDEN): Promise<NoticeCaseResult[]> {
  const roster = await evalRoster();
  const options = optionsOf(roster);
  const out: NoticeCaseResult[] = cases.map((c) => ({
    ...c,
    shouldGet: receivers(roster, c.expect).size,
    rule: compareAudience(c.expect, proposeByRules(c.title, c.body, options).audience, roster),
  }));
  if (!gateway) return out;
  for (let i = 0; i < out.length; i += 4) {
    await Promise.all(
      out.slice(i, i + 4).map(async (r) => {
        // proposeAudience는 실패·계약 전이면 규칙 제안(byModel 아님)을 돌려줘요. 그건 AI 답으로 세지 않아요.
        const p = await proposeAudience(gateway, { title: r.title, body: r.body }, options).catch(() => null);
        r.ai = p?.byModel ? compareAudience(r.expect, p.audience, roster) : 'error';
      }),
    );
  }
  return out;
}

function side(checks: readonly (AudienceCheck | 'error')[]): NoticeEvalSide {
  const answered = checks.filter((c): c is AudienceCheck => c !== 'error');
  return {
    exact: answered.filter((c) => c.exact).length,
    missedNone: answered.filter((c) => c.missed === 0).length,
    missed: answered.reduce((n, c) => n + c.missed, 0),
    extra: answered.reduce((n, c) => n + c.extra, 0),
    failed: checks.length - answered.length,
  };
}

export interface NoticeScore {
  total: number;
  /** 받아야 할 사람 합(공지마다 센 수를 더해요) */
  shouldGet: number;
  rule: NoticeEvalSide;
  /** AI로 아직 안 쟀으면 null */
  ai: NoticeEvalSide | null;
}

export function scoreNotices(results: readonly NoticeCaseResult[]): NoticeScore {
  const ran = results.some((r) => r.ai !== undefined);
  return {
    total: results.length,
    shouldGet: results.reduce((n, r) => n + r.shouldGet, 0),
    rule: side(results.map((r) => r.rule)),
    ai: ran ? side(results.map((r) => r.ai ?? 'error')) : null,
  };
}

/** "개발팀 · 5층 · 팀장" 또는 "모두" */
export function audienceLabel(a: NoticeAudience): string {
  if (a.everyone) return '모두';
  return [...a.departments, ...a.floors, ...a.roles.map((r) => NOTICE_AUDIENCE_ROLE_LABEL[r])].join(' · ');
}

const answerOf = (c: AudienceCheck | 'error'): NoticeEvalAnswer =>
  c === 'error'
    ? { label: '답 못 함', ok: false, missed: null, extra: null }
    : { label: audienceLabel(c.audience), ok: c.exact, missed: c.missed, extra: c.extra };

const isMiss = (r: NoticeCaseResult) => !r.rule.exact || (r.ai !== undefined && (r.ai === 'error' || !r.ai.exact));

/** 관리자 화면(GET /api/ops/ai-eval)에 보낼 공지 칸: 셈과 틀린 공지(라벨로 바꿔요). 사람 이름은 없고 수만이에요. */
export function noticeEvalView(results: readonly NoticeCaseResult[], people: number): NoticeEvalView {
  const s = scoreNotices(results);
  return {
    ...s,
    people,
    misses: results.filter(isMiss).map((r) => ({
      group: r.group,
      title: r.title,
      body: r.body,
      expect: audienceLabel(r.expect),
      rule: answerOf(r.rule),
      ai: r.ai === undefined ? null : answerOf(r.ai),
      why: r.why ?? null,
    })),
  };
}

const pct = (n: number, total: number) => `${n}/${total} (${total ? Math.round((n / total) * 100) : 0}%)`;

function mark(c: AudienceCheck | 'error' | undefined): string {
  if (c === undefined) return '—';
  if (c === 'error') return '✗ 답 못 함';
  if (c.exact) return `✓ ${audienceLabel(c.audience)}`;
  const people = c.missed || c.extra ? `놓침 ${c.missed} · 더 받음 ${c.extra}` : '같은 사람';
  return `✗ ${audienceLabel(c.audience)} (${people})`;
}

/** 마크다운 표의 "공지 알림 대상" 칸(docs/AI정답률.md) */
export function renderNoticeSection(results: readonly NoticeCaseResult[], people: number): string[] {
  const s = scoreNotices(results);
  const row = (name: string, x: NoticeEvalSide | null) =>
    x === null
      ? `| ${name} | ${s.total} | 안 잼 | 안 잼 | 안 잼 | 안 잼 |`
      : `| ${name} | ${s.total} | ${pct(x.exact, s.total)} | ${pct(x.missedNone, s.total)} | ${x.missed} / ${s.shouldGet} | ${x.extra} |`;
  const lines = [
    '## 공지 알림 대상',
    '',
    '> 11/6 사용자 결정("정확도를 먼저 재 줘", ADR-09 개정). 새 공지 알림 자동 보내기(`noticeAutoSend`)를 운영에서 켜기 전에 봐요.',
    '',
    `개발자가 지은 가상 공지 ${s.total}건(\`apps/server/src/eval/notice-golden.ts\`)에 받아야 할 사람(부서·층·역할 또는 모두)을 정답으로 달고, 서버가 쓰는 같은 제안 함수(\`proposeByRules\`·\`proposeAudience\`)로 **낱말 규칙**과 **AI**가 낸 대상을 견줬어요.`,
    `사람 수는 앱에 든 가상 직원 ${people}명으로 공지마다 세서 더했어요. 정답은 "이 공지를 받아야 할 사람"이고, 지금 규칙이 하는 대로 적지 않았어요.`,
    '',
    '| 제안하는 곳 | 공지 | 정확히 맞힘 | 놓친 사람 0인 공지 | 놓친 사람 / 받아야 할 사람(합) | 더 받은 사람(합) |',
    '|---|---|---|---|---|---|',
    row('낱말 규칙', s.rule),
    row('AI', s.ai),
  ];
  if (s.ai?.failed) lines.push('', `AI가 답하지 못한 공지가 ${s.ai.failed}건이에요. 이 공지는 정확히 맞힘·놓친 사람 0에 세지 않았어요.`);

  lines.push(
    '',
    '### 묶음별',
    '',
    '| 묶음 | 공지 | 낱말 규칙 정확히 맞힘 | 낱말 규칙 놓친 사람 0 | AI 정확히 맞힘 | AI 놓친 사람 0 |',
    '|---|---|---|---|---|---|',
  );
  for (const g of NOTICE_GROUPS) {
    const rows = results.filter((r) => r.group === g);
    if (!rows.length) continue;
    const gs = scoreNotices(rows);
    const ai = gs.ai === null ? ['안 잼', '안 잼'] : [`${gs.ai.exact}/${gs.total}`, `${gs.ai.missedNone}/${gs.total}`];
    lines.push(`| ${g} | ${gs.total} | ${gs.rule.exact}/${gs.total} | ${gs.rule.missedNone}/${gs.total} | ${ai[0]} | ${ai[1]} |`);
  }

  lines.push('', '### 공지마다', '', '| # | 묶음 | 공지 | 정답 | 낱말 규칙 | AI | 왜 이 정답인지 |', '|---|---|---|---|---|---|---|');
  results.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.group} | **${r.title}** ${r.body} | ${audienceLabel(r.expect)} | ${mark(r.rule)} | ${mark(r.ai)} | ${r.why ?? ''} |`);
  });

  lines.push(
    '',
    '### 읽는 법(공지 알림 대상)',
    '',
    '- **정확히 맞힘**: 제안한 조건(모두·부서·층·역할)이 정답과 같은 공지 수예요. 같은 사람에게 가도 조건이 다르면 틀림으로 세요(이 명단에서는 총무팀과 총무 역할이 같은 한 사람이에요). 표의 "같은 사람"이 그런 경우예요.',
    '- **놓친 사람**: 받아야 하는데 알림을 못 받는 사람이에요. **더 받은 사람**: 받지 않아도 되는데 알림을 받는 사람이에요. 조건은 "또는"이라, 정답에 없는 부서·층·역할이 하나 붙으면 더 받은 사람이 생기고, 정답 조건을 하나 빠뜨리면 놓친 사람이 생겨요.',
    '- **자동 보내기를 켤지 볼 때 중요한 숫자는 "놓친 사람 0인 공지"와 "놓친 사람(합)"이에요.** 확인 없이 보내면 놓친 사람은 자기에게 해당하는 공지가 있는지 모르고 지나가요. 더 받은 사람은 알림 한 건을 더 받는 것이라 덜 나빠요(조건을 "또는"으로 둔 까닭과 같아요). 보낸 알림은 되돌릴 수 없어요.',
    '- 자동 보내기를 켜도 모델이 실패하거나 무보관 계약 확인 전이면 **낱말 규칙 제안대로** 보내요. 그래서 AI 줄만이 아니라 낱말 규칙 줄도 같이 봐요.',
    `- 운영에서 켤 기준(제안, 사용자가 정해요): AI 줄의 놓친 사람 0인 공지가 모두(${s.total}/${s.total})이고 답 못 함이 0건일 때만 켜요.${
      s.rule.missedNone < s.total
        ? ' 낱말 규칙 줄은 지금 그 기준에 못 미쳐서, 켜기 전에 모델이 답하지 못하면 자동으로 보내지 않고 총무 확인으로 돌리게 바꿀지 같이 정해요(ADR-09).'
        : ''
    }`,
    '- AI 칸은 키가 있는 곳에서 재요. 시연에서는 [운영자 · AI 정답률] > [AI로 다시 재기]가 이 공지들도 같이 모델에 보내요(1시간에 한 번). 모델에는 공지 글과 부서·층·역할 이름만 가요.',
    '',
  );
  return lines;
}
