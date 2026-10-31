import { checkInput, IT_HELP_TEXT_MAX, type ItHelpResponse } from '@one-line-desk/shared';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import { demoItFaqs } from './fixtures';
import * as repo from './repo';
import type { ItFaqRow } from './repo';
import { bigramSet, coverage, keywords, normalize } from './text';

// IT 오류 문장 → IT FAQ 원문 단계(10/31 넓힐 후보 ②).
// - 붙여 넣은 글은 화면이 공통 입력 검사로 가린 뒤 POST 본문으로만 와요. 서버도 같은 규칙으로 다시 검사하고, 어디에도 저장하지 않아요(ADR-10).
// - 고르기는 규칙만이에요: 오류 코드가 맞으면 먼저, 아니면 제목·다른 말의 두 글자 조각 점수. 파일럿 1단계는 AI가 가짜라 모델을 부르지 않고 "AI 정리"도 없어요.
// - FAQ 단계는 원문 그대로 보여 줘요. 고치거나 지어내지 않아요(ADR-09 근거 규칙).
// - 해결이 안 되면 분장표 IT지원팀 행으로 앱 안 문의(확인 시트 → [보내기])를 보내요. 복사 버튼은 없어요(10/31 사용자 결정).

const FOUND_MIN = 0.8;
const CANDIDATE_MIN = 0.4;
const MAX_OTHERS = 3;
const CODE_SCORE = 10;
const IT_TEAM_FALLBACK = 'IT지원팀';
const IT_TASK_FALLBACK = 'IT 오류';

// 0x8007…·AADSTS…·숫자 코드(809). 숫자 코드는 "오류 809"처럼 코드라는 말 근처이거나 FAQ에 적힌 값과 같을 때만 봐요.
const HEX_CODE = /0x[0-9a-f]{6,8}/gi;
const NAMED_CODE = /\b[A-Z]{3,8}\d{4,6}\b/g;
// 오류 글 어디에나 나오는 말. 이 말만으로는 FAQ를 고르지 않아요("오류"만 맞은 프린터 FAQ가 업데이트 오류 후보로 뜨던 문제).
const IT_GENERIC = new Set(['오류', '에러', '실패', '문제', '안됨', '안돼', 'error', 'failed', 'failure', 'windows', '윈도', '연결']);
// 경로를 붙여 쓴 긴 낱말(appdatalocaltemp…)은 두 글자 조각이 아무 데나 겹쳐서 빼요.
const MAX_KEYWORD = 16;
const MASK_WORDS = new Set(['사용자', '폴더', '이메일', 'ip']);
const NUMBER_NEAR_WORD = /(?:오류|에러|error|코드|code)\D{0,6}(\d{3,5})/gi;

/** 붙여 넣은 글에서 오류 코드 모양을 뽑아요(소문자). */
export function errorCodesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(HEX_CODE)) out.add(m[0].toLowerCase());
  for (const m of text.matchAll(NAMED_CODE)) out.add(m[0].toLowerCase());
  for (const m of text.matchAll(NUMBER_NEAR_WORD)) out.add(m[1]!);
  return out;
}

export interface ScoredFaq {
  faq: ItFaqRow;
  score: number;
}

/** FAQ 후보를 점수 순으로 줘요. 오류 코드가 맞으면 다른 무엇보다 앞서요. */
export function rankFaqs(text: string, faqs: ItFaqRow[]): ScoredFaq[] {
  const codes = errorCodesIn(text);
  // 코드는 위에서 따로 맞춰요. 16진수 조각(0x…)이 다른 코드와 두 글자씩 겹쳐 엉뚱한 후보가 되지 않게 빼요. 가림 자리표 낱말도 빼요.
  const keys = keywords(text).filter((k) => !IT_GENERIC.has(k) && !/^0x/.test(k) && !MASK_WORDS.has(k) && k.length <= MAX_KEYWORD);
  const lowered = normalize(text);
  return faqs
    .map((faq) => {
      const codeHit = faq.errorCodes.some((c) => codes.has(c.toLowerCase()) || (/^0x/i.test(c) && lowered.includes(c.toLowerCase())));
      const set = bigramSet(faq.title, ...faq.aliases);
      let score = 0;
      for (const k of keys) {
        const c = coverage(k, set);
        if (c >= 0.5) score += c;
      }
      return { faq, score: score + (codeHit ? CODE_SCORE : 0) };
    })
    .filter((s) => s.score >= CANDIDATE_MIN)
    .sort((a, b) => b.score - a.score || a.faq.id.localeCompare(b.faq.id));
}

export function createItHelpService(ctx: AppContext) {
  let realFaqs = true;
  const refreshSource = async () => {
    realFaqs = await repo.hasUploadedItFaqs(ctx.db);
  };

  return {
    hasRealFaqs: () => realFaqs,
    refreshSource,

    /** 비어 있을 때만 가상 IT FAQ를 넣어요. 분장표 seed 뒤에 불러요(FAQ가 분장표 행을 가리켜요). */
    async seed(): Promise<void> {
      if ((await repo.countItFaqs(ctx.db)) === 0) {
        await ctx.db.tx(async (q) => {
          for (const f of demoItFaqs()) await repo.insertItFaqIfAbsent(q, f);
        });
      }
      await refreshSource();
    },

    /** 가린 오류 글로 FAQ를 찾아요. 글은 응답에 다시 싣지 않고, 저장하지 않아요. */
    async match(text: string): Promise<ItHelpResponse> {
      const trimmed = text.trim();
      if (!trimmed) throw new DeskError('bad-request', 400, '오류 창의 글을 붙여 넣어 주세요');
      if (trimmed.length > IT_HELP_TEXT_MAX) throw new DeskError('bad-request', 400, `${IT_HELP_TEXT_MAX}자까지 붙여 넣을 수 있어요`);
      const checked = checkInput(trimmed);
      if (checked.locks.length) throw new DeskError('locked', 422, checked.locks[0]!.message);

      const faqs = await repo.allItFaqs(ctx.db);
      const ranked = rankFaqs(checked.text, faqs);
      const top = ranked[0];
      // 1등이 근거 점수를 넘고 2등과 같지 않을 때만 골라요. 동점이면 사람이 제목을 보고 골라요.
      const found = top && top.score >= FOUND_MIN && ranked[1]?.score !== top.score ? top : undefined;
      // 다른 후보도 근거 점수를 넘은 것만 보여 줘요. 조각 하나 겹친 FAQ까지 띄우면 헷갈려요(10/31 화면 확인).
      const others = ranked
        .filter((s) => s !== found && s.score >= FOUND_MIN)
        .slice(0, MAX_OTHERS)
        .map((s) => ({ id: s.faq.id, title: s.faq.title }));

      const rows = await repo.findRows(
        ctx.db,
        [found?.faq.rowId, ...faqs.map((f) => f.rowId)].filter((x): x is string => typeof x === 'string'),
      );
      const inquiryRow = rows.find((r) => r.id === found?.faq.rowId) ?? rows[0] ?? null;
      return {
        ...(found ? { faq: { id: found.faq.id, title: found.faq.title, steps: found.faq.steps, revisedOn: found.faq.revisedOn } } : {}),
        others,
        inquiryRowId: inquiryRow?.id ?? null,
        inquiryTeam: inquiryRow?.team ?? IT_TEAM_FALLBACK,
        inquiryTask: inquiryRow?.task ?? IT_TASK_FALLBACK,
      };
    },

    /** 다른 후보 제목을 눌렀을 때. 사람이 고른 FAQ의 원문 단계예요. */
    async faq(id: string): Promise<ItHelpResponse> {
      const faqs = await repo.allItFaqs(ctx.db);
      const f = faqs.find((x) => x.id === id);
      if (!f) throw new DeskError('not-found', 404, 'IT FAQ에서 그 항목을 찾지 못했어요');
      const [row] = f.rowId ? await repo.findRows(ctx.db, [f.rowId]) : [];
      return {
        faq: { id: f.id, title: f.title, steps: f.steps, revisedOn: f.revisedOn },
        others: [],
        inquiryRowId: row?.id ?? null,
        inquiryTeam: row?.team ?? IT_TEAM_FALLBACK,
        inquiryTask: row?.task ?? IT_TASK_FALLBACK,
      };
    },
  };
}

export type ItHelpService = ReturnType<typeof createItHelpService>;
