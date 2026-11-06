import { NOTICE_AUDIENCE_ROLE_LABEL, NOTICE_AUDIENCE_ROLES, NOTICE_TITLE_MAX_LENGTH, type NoticeAudience, personNameWords } from '@one-line-desk/shared';
import { describe, expect, it } from 'vitest';
import { AiGateway, type LlmProvider, type ProviderResult, type StructuredRequest } from '../core/ai/gateway';
import type { Queryable } from '../core/db';
import { modelInput, optionsOf } from '../modules/notices/audience';
import { renderReport, runGolden } from './ai-eval';
import { compareAudience, evalRoster, type NoticeCaseResult, noticeEvalView, runNoticeGolden, sameAudience, scoreNotices } from './notice-eval';
import { NOTICE_GOLDEN, NOTICE_GROUPS } from './notice-golden';

// 공지 알림 대상 정답률(11/6 사용자 결정 "정확도를 먼저 재 줘", ADR-09 개정). 실제 모델은 부르지 않아요.
// 정답 표 모양(이름이 가상 직원 명단에 있는지), 사람 단위 셈(놓친 사람·더 받은 사람), 낱말 규칙 바닥값, AI 칸을 세는 길을 봐요.

const noDb: Queryable = { query: async () => ({ rows: [] }) };
const ALL: NoticeAudience = { everyone: true, departments: [], floors: [], roles: [] };
const only = (o: Partial<Pick<NoticeAudience, 'departments' | 'floors' | 'roles'>>): NoticeAudience => ({
  everyone: false,
  departments: o.departments ?? [],
  floors: o.floors ?? [],
  roles: o.roles ?? [],
});

/** 정답을 아는 가짜 모델: 공지 제목으로 정답을 찾아 모델 답 모양(역할은 한글 이름)으로 돌려줘요. 받은 입력을 적어 둬요. */
class OracleProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly calls: { purpose: string; grade: number; input: string }[] = [];
  constructor(private readonly answer?: (expect: NoticeAudience) => NoticeAudience) {}
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    this.calls.push({ purpose: req.purpose, grade: req.grade, input: req.input });
    const title = req.input.split('\n')[0]!.replace('공지 제목: ', '');
    const c = NOTICE_GOLDEN.find((g) => g.title === title);
    if (!c) throw new Error(`정답 표에 없는 공지: ${title}`);
    const a = this.answer ? this.answer(c.expect) : c.expect;
    const output = { ...a, roles: a.roles.map((r) => NOTICE_AUDIENCE_ROLE_LABEL[r]), evidence: [] };
    return { output: req.schema.parse(output), inputTokens: 1, outputTokens: 1 };
  }
}

class FailingProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  async complete<T>(): Promise<ProviderResult<T>> {
    throw new Error('모델이 답하지 않았어요');
  }
}

describe('공지 알림 대상 정답 표(11/6)', () => {
  it('공지는 30~40건이고, 묶음마다 2건 이상이며, 제목이 겹치지 않아요', () => {
    expect(NOTICE_GOLDEN.length).toBeGreaterThanOrEqual(30);
    expect(NOTICE_GOLDEN.length).toBeLessThanOrEqual(40);
    expect(new Set(NOTICE_GOLDEN.map((g) => g.title)).size).toBe(NOTICE_GOLDEN.length);
    for (const group of NOTICE_GROUPS) expect(NOTICE_GOLDEN.filter((g) => g.group === group).length, group).toBeGreaterThanOrEqual(2);
    for (const g of NOTICE_GOLDEN) {
      expect(g.title.length, g.title).toBeLessThanOrEqual(NOTICE_TITLE_MAX_LENGTH);
      expect(g.body.trim(), g.title).not.toBe('');
    }
  });

  it('모든 공지에 정답이 있고, 정답의 부서·층·역할 이름은 가상 직원 명단에 있어요. 정답마다 받을 사람이 한 명 이상이에요', async () => {
    const roster = await evalRoster();
    expect(roster).toHaveLength(17);
    const options = optionsOf(roster);
    for (const g of NOTICE_GOLDEN) {
      const a = g.expect;
      expect(a, g.title).toBeDefined();
      if (a.everyone) {
        expect([a.departments, a.floors, a.roles], g.title).toEqual([[], [], []]);
      } else {
        expect(a.departments.length + a.floors.length + a.roles.length, g.title).toBeGreaterThan(0);
        for (const d of a.departments) expect(options.departments, g.title).toContain(d);
        for (const f of a.floors) expect(options.floors, g.title).toContain(f);
        for (const r of a.roles) expect(NOTICE_AUDIENCE_ROLES as readonly string[], g.title).toContain(r);
      }
    }
    // 받을 사람이 없는 정답이면 놓친 사람을 셀 수 없어요.
    for (const r of await runNoticeGolden(null)) expect(r.shouldGet, r.title).toBeGreaterThan(0);
  });

  it('헷갈릴 만한 묶음(곁말·지하 층·문의처·주입)에는 "왜 이 정답인지"가 있어요', () => {
    for (const g of NOTICE_GOLDEN.filter((x) => ['곁말', '지하 층', '문의처', '주입'].includes(x.group))) expect(g.why, g.title).toBeTruthy();
  });

  it('공지 글에 가상 직원 이름·메일이 없어요(모델에 가는 글이에요)', async () => {
    const roster = await evalRoster();
    const words = roster.flatMap((p) => personNameWords(p.displayName));
    for (const g of NOTICE_GOLDEN) {
      const text = `${g.title}\n${g.body}`;
      for (const w of words) expect(text, g.title).not.toContain(w);
      for (const p of roster) expect(text, g.title).not.toContain(p.email!);
    }
  });
});

describe('사람 단위 셈', () => {
  it('놓친 사람은 받아야 하는데 못 받는 사람, 더 받은 사람은 받지 않아도 되는데 받는 사람이에요', async () => {
    const roster = await evalRoster();
    // 3층 4명. 2층·4층(3명·3명)을 더 붙이면 놓친 사람 0 · 더 받은 사람 6이에요.
    expect(compareAudience(only({ floors: ['3층'] }), only({ floors: ['3층', '2층', '4층'] }), roster)).toMatchObject({
      exact: false,
      missed: 0,
      extra: 6,
    });
    // 모두(17명)에게 갈 공지를 팀장(2명)에게만 보내면 15명을 놓쳐요.
    expect(compareAudience(ALL, only({ roles: ['team-lead'] }), roster)).toMatchObject({ exact: false, missed: 15, extra: 0 });
    // 2층·3층(7명)을 3층만이면 2층 3명을 놓쳐요.
    expect(compareAudience(only({ floors: ['2층', '3층'] }), only({ floors: ['3층'] }), roster)).toMatchObject({ missed: 3, extra: 0 });
    // 개발팀(4명) 대신 모두면 13명이 더 받아요.
    expect(compareAudience(only({ departments: ['개발팀'] }), ALL, roster)).toMatchObject({ exact: false, missed: 0, extra: 13 });
    expect(compareAudience(ALL, ALL, roster)).toMatchObject({ exact: true, missed: 0, extra: 0 });
  });

  it('정확히 맞힘은 조건이 같은지예요. 순서는 보지 않고, 같은 사람이어도 조건이 다르면 틀림이에요', async () => {
    const roster = await evalRoster();
    expect(compareAudience(only({ departments: ['재무팀', '영업팀'] }), only({ departments: ['영업팀', '재무팀'] }), roster)).toMatchObject({
      exact: true,
      missed: 0,
      extra: 0,
    });
    // 카페팀과 1층, 총무팀과 총무 역할은 이 명단에서 같은 한 사람이에요.
    expect(compareAudience(only({ departments: ['카페팀'] }), only({ floors: ['1층'] }), roster)).toMatchObject({ exact: false, missed: 0, extra: 0 });
    expect(compareAudience(only({ departments: ['총무팀'] }), only({ roles: ['facilities'] }), roster)).toMatchObject({ exact: false, missed: 0, extra: 0 });
    expect(sameAudience(ALL, only({ floors: ['1층', '2층', '3층', '4층', '5층'] }))).toBe(false);
  });

  it('합계: 답 못 한 공지는 "정확히 맞힘·놓친 사람 0"에 세지 않고 따로 세요', async () => {
    const roster = await evalRoster();
    const base = NOTICE_GOLDEN.slice(0, 3);
    const results: NoticeCaseResult[] = [
      { ...base[0]!, expect: ALL, shouldGet: 17, rule: compareAudience(ALL, ALL, roster), ai: compareAudience(ALL, ALL, roster) },
      {
        ...base[1]!,
        expect: ALL,
        shouldGet: 17,
        rule: compareAudience(ALL, only({ roles: ['team-lead'] }), roster),
        ai: compareAudience(ALL, only({ floors: ['3층'] }), roster),
      },
      {
        ...base[2]!,
        expect: only({ floors: ['3층'] }),
        shouldGet: 4,
        rule: compareAudience(only({ floors: ['3층'] }), only({ floors: ['3층', '2층'] }), roster),
        ai: 'error',
      },
    ];
    expect(scoreNotices(results)).toEqual({
      total: 3,
      shouldGet: 38,
      rule: { exact: 1, missedNone: 2, missed: 15, extra: 3, failed: 0 },
      ai: { exact: 1, missedNone: 1, missed: 13, extra: 0, failed: 1 },
    });
    const view = noticeEvalView(results, 17);
    expect(view.misses.map((m) => [m.rule, m.ai])).toEqual([
      [
        { label: '팀장', ok: false, missed: 15, extra: 0 },
        { label: '3층', ok: false, missed: 13, extra: 0 },
      ],
      [
        { label: '3층 · 2층', ok: false, missed: 0, extra: 3 },
        { label: '답 못 함', ok: false, missed: null, extra: null },
      ],
    ]);
    // AI를 안 돌렸으면 AI 칸은 null이에요("안 잼").
    expect(scoreNotices(results.map(({ ai: _ai, ...r }) => r)).ai).toBeNull();
  });
});

describe('낱말 규칙과 AI로 재기', () => {
  it('낱말 규칙 바닥값(11/6 처음 잰 값) 밑으로 내려가지 않아요. 모델 없이 돌면 AI 칸은 "안 잼"이에요', async () => {
    const s = scoreNotices(await runNoticeGolden(null));
    expect(s.ai).toBeNull();
    expect(s.total).toBe(NOTICE_GOLDEN.length);
    // 11/6 처음 40건: 정확히 맞힘 21 · 놓친 사람 0인 공지 29 · 놓친 사람 142명(받아야 할 사람 357명 가운데) · 더 받은 사람 74명.
    expect(s.shouldGet).toBe(357);
    expect(s.rule.exact).toBeGreaterThanOrEqual(21);
    expect(s.rule.missedNone).toBeGreaterThanOrEqual(29);
    expect(s.rule.missed).toBeLessThanOrEqual(142);
  });

  it('AI 칸은 서버와 같은 제안 함수로 세요. 모델 입력은 공지 글과 부서·층·역할 이름뿐이에요(등급 1, 사람 이름·인원 수 0건)', async () => {
    const provider = new OracleProvider();
    const results = await runNoticeGolden(new AiGateway(provider, true, noDb));
    const s = scoreNotices(results);
    expect(s.ai).toEqual({ exact: s.total, missedNone: s.total, missed: 0, extra: 0, failed: 0 });

    const roster = await evalRoster();
    const options = optionsOf(roster);
    expect(provider.calls).toHaveLength(NOTICE_GOLDEN.length);
    expect(provider.calls.map((c) => c.input)).toEqual(NOTICE_GOLDEN.map((g) => modelInput(g.title, g.body, options)));
    for (const c of provider.calls) {
      expect(c).toMatchObject({ purpose: 'notice-audience', grade: 1 });
      for (const p of roster) {
        expect(c.input).not.toContain(p.displayName);
        expect(c.input).not.toContain(p.displayName.split(' ').at(-1)!);
        expect(c.input).not.toContain(p.email!);
      }
      expect(c.input).not.toMatch(/\d+\s*명/);
    }

    const report = renderReport(await runGolden(null), { model: 'claude-test', date: '2026-11-06', notices: { results, people: roster.length } });
    expect(report).toContain('## 공지 알림 대상');
    expect(report).toContain(`| AI | ${s.total} | ${s.total}/${s.total} (100%) | ${s.total}/${s.total} (100%) | 0 / 357 | 0 |`);
    expect(report).toContain('놓친 사람 0인 공지');
  });

  it('모델이 넓게 답하면 더 받은 사람, 좁게 답하면 놓친 사람으로 세요', async () => {
    const wide = scoreNotices(await runNoticeGolden(new AiGateway(new OracleProvider(() => ALL), true, noDb)));
    expect(wide.ai).toMatchObject({ missed: 0, missedNone: wide.total, failed: 0 });
    expect(wide.ai!.extra).toBeGreaterThan(0);
    const narrow = scoreNotices(await runNoticeGolden(new AiGateway(new OracleProvider(() => only({ roles: ['team-lead'] })), true, noDb)));
    expect(narrow.ai!.missed).toBeGreaterThan(0);
    expect(narrow.ai!.missedNone).toBeLessThan(narrow.total);
  });

  it('모델이 실패하거나 무보관 계약 확인 전이면 AI 칸은 "답 못 함"이고, 규칙 제안을 AI 답으로 세지 않아요', async () => {
    for (const gateway of [new AiGateway(new FailingProvider(), true, noDb), new AiGateway(new OracleProvider(), false, noDb)]) {
      const results = await runNoticeGolden(gateway, NOTICE_GOLDEN.slice(0, 3));
      expect(results.map((r) => r.ai)).toEqual(['error', 'error', 'error']);
      expect(scoreNotices(results).ai).toEqual({ exact: 0, missedNone: 0, missed: 0, extra: 0, failed: 3 });
    }
  });

  it('모델 없이 만든 표는 공지 칸의 AI가 "안 잼"이고, 규칙이 틀린 공지와 이유가 보여요', async () => {
    const results = await runNoticeGolden(null);
    const report = renderReport(await runGolden(null), { model: null, date: '2026-11-06', notices: { results, people: 17 } });
    expect(report).toContain(`| AI | ${NOTICE_GOLDEN.length} | 안 잼 | 안 잼 | 안 잼 | 안 잼 |`);
    expect(report).toMatch(/\| \*\*택배 보관함 이전\*\* .* \| 모두 \| ✗ 1층 \(놓침 16 · 더 받음 0\) \| — \|/);
    expect(report).toContain('자동 보내기를 켤지 볼 때 중요한 숫자는 "놓친 사람 0인 공지"와 "놓친 사람(합)"이에요');
    // notices를 안 주면 공지 칸이 없어요(이전 표와 같아요).
    expect(renderReport(await runGolden(null), { model: null, date: '2026-11-06' })).not.toContain('공지 알림 대상');
  });
});
