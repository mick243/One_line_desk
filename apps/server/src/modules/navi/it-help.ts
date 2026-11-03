import { createHash } from 'node:crypto';
import {
  checkInput,
  IT_FAQ_COLUMNS,
  IT_FAQ_LIST_SEPARATOR,
  IT_HELP_TEXT_MAX,
  type ItFaqApplyResponse,
  type ItFaqChange,
  type ItFaqColumn,
  type ItFaqListResponse,
  type ItFaqPreviewResponse,
  type ItHelpResponse,
  kstDate,
} from '@one-line-desk/shared';
import type { AppContext } from '../../context';
import type { Queryable } from '../../core/db';
import { DeskError } from '../../core/errors';
import type { DeskUser } from '../../core/user';
import { demoItFaqs } from './fixtures';
import { type ItFaqFileRow, itFaqFormatError, parseItFaqFile, toItFaqCsv } from './it-faq-csv';
import * as repo from './repo';
import type { ItFaqRow, OwnedItFaq } from './repo';
import { bigramSet, coverage, keywords, normalize, words } from './text';

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
// 소문자로 붙여 넣어도(aadsts50126) 같은 코드로 봐요(QA L1).
const NAMED_CODE = /\b[A-Z]{3,8}\d{4,6}\b/gi;
// "0x8007 0005"·"0x 80070005"처럼 띄어 쓴 16진수 코드를 붙여요(QA H1).
const SPACED_HEX = /0x\s*([0-9a-f]{4})[\s-]?([0-9a-f]{4})(?![0-9a-f])/gi;
// 오류 글 어디에나 나오는 말. 이 말만으로는 FAQ를 고르지 않아요("오류"만 맞은 프린터 FAQ가 업데이트 오류 후보로 뜨던 문제).
// 영어 오류 글의 흔한 말(cannot·unable 등)도 같이 빼요. "Cannot read properties"가 Outlook "cannot open"으로 가던 문제(QA H1).
const IT_GENERIC = new Set([
  '오류',
  '에러',
  '실패',
  '문제',
  '안됨',
  '안돼',
  'error',
  'failed',
  'failure',
  'windows',
  '윈도',
  '연결',
  'cannot',
  'can',
  'not',
  'unable',
  'could',
  'the',
  'at',
  'of',
  'to',
  'is',
  'exception',
  'typeerror',
]);
// 경로를 붙여 쓴 긴 낱말(appdatalocaltemp…)은 두 글자 조각이 아무 데나 겹쳐서 빼요.
const MAX_KEYWORD = 16;
const MASK_WORDS = new Set(['사용자', '폴더', '이메일', 'ip']);
const NUMBER_NEAR_WORD = /(?:오류|에러|error|코드|code)\D{0,6}(\d{3,5})/gi;

/** 띄어 쓴 16진수 코드를 한 덩어리로 붙여요. */
function compactCodes(text: string): string {
  return text.replace(SPACED_HEX, '0x$1$2');
}

/** 붙여 넣은 글에서 오류 코드 모양을 뽑아요(소문자). */
export function errorCodesIn(raw: string): Set<string> {
  const text = compactCodes(raw);
  const out = new Set<string>();
  for (const m of text.matchAll(HEX_CODE)) out.add(m[0].toLowerCase());
  for (const m of text.matchAll(NAMED_CODE)) out.add(m[0].toLowerCase());
  for (const m of text.matchAll(NUMBER_NEAR_WORD)) out.add(m[1]!);
  return out;
}

interface ScoredFaq {
  faq: ItFaqRow;
  score: number;
}

/** FAQ 후보를 점수 순으로 줘요. 오류 코드가 맞으면 다른 무엇보다 앞서요. */
export function rankFaqs(raw: string, faqs: ItFaqRow[]): ScoredFaq[] {
  const text = compactCodes(raw);
  const codes = errorCodesIn(text);
  // 코드는 위에서 따로 맞춰요. 숫자가 든 낱말(줄 번호 691, 0x… 조각)은 FAQ 제목 속 코드와 두 글자씩 겹쳐
  // 엉뚱한 FAQ를 확정으로 띄워서(QA H1) 조각 점수에서 빼요. 가림 자리표 낱말도 빼요.
  const keys = keywords(text).filter((k) => !IT_GENERIC.has(k) && !/\d/.test(k) && !MASK_WORDS.has(k) && k.length <= MAX_KEYWORD);
  const lowered = normalize(text);
  return faqs
    .map((faq) => {
      const codeHit = faq.errorCodes.some((c) => codes.has(c.toLowerCase()) || (/^0x/i.test(c) && lowered.includes(c.toLowerCase())));
      const set = bigramSet(faq.title, ...faq.aliases);
      const latinWords = words([faq.title, ...faq.aliases].join(' ')).filter((w) => /^[a-z]+$/.test(w));
      let score = 0;
      for (const k of keys) {
        // 영어 낱말은 조각이 아니라 낱말로 맞춰요. "run"이 "account"의 "un"에 반쯤 걸리던 문제(QA H1).
        // 한국어는 조사·어미가 붙어서 지금처럼 조각 점수로 봐요.
        if (/^[a-z]+$/.test(k)) {
          if (latinWords.some((w) => w === k || (k.length >= 4 && w.startsWith(k)))) score += 1;
          continue;
        }
        const c = coverage(k, set);
        if (c >= 0.5) score += c;
      }
      return { faq, score: score + (codeHit ? CODE_SCORE : 0) };
    })
    .filter((s) => s.score >= CANDIDATE_MIN)
    .sort((a, b) => b.score - a.score || a.faq.id.localeCompare(b.faq.id));
}

// ── IT FAQ 파일 올리기(11/3) ───────────────────────────────────────
// 권한은 분장표와 같은 계산이에요: 분장표 주인(라우트 가드) + 부서. FAQ의 주인 부서는 그 FAQ "문의 행"이 가리키는 분장표 행의 주인 부서예요.
// 그래서 IT FAQ를 고치는 사람은 FAQ 주인 부서(지금은 IT지원팀)의 분장표 주인이에요. FAQ가 하나도 없으면 IT지원팀으로 봐요.

const FAQ_COMPARED: ItFaqColumn[] = ['title', 'aliases', 'errorCodes', 'steps', 'rowId'];

function showFaq(f: Pick<ItFaqRow, 'title' | 'aliases' | 'errorCodes' | 'steps' | 'rowId'>, key: ItFaqColumn): string {
  switch (key) {
    case 'aliases':
    case 'errorCodes':
      return f[key].join(IT_FAQ_LIST_SEPARATOR);
    case 'steps':
      return f.steps.map((step, i) => `${i + 1}) ${step}`).join(' ');
    case 'rowId':
      return f.rowId ?? '';
    case 'title':
      return f.title;
    default:
      return '';
  }
}

function faqFields(before: ItFaqRow | undefined, after: ItFaqFileRow): ItFaqChange['fields'] {
  return FAQ_COMPARED.filter((k) => !before || showFaq(before, k) !== showFaq(after, k))
    .filter((k) => before || showFaq(after, k) !== '')
    .map((k) => ({ name: IT_FAQ_COLUMNS[k], ...(before ? { before: showFaq(before, k) } : {}), after: showFaq(after, k) }));
}

interface FaqOwners {
  faqs: OwnedItFaq[];
  /** IT FAQ를 고칠 수 있는 부서(FAQ 문의 행의 주인 부서들) */
  departments: Set<string>;
}

async function faqOwners(q: Queryable): Promise<FaqOwners> {
  const faqs = await repo.itFaqsWithOwner(q);
  const departments = new Set(faqs.map((f) => f.ownerDepartment).filter((d): d is string => d !== null));
  if (departments.size === 0) departments.add(IT_TEAM_FALLBACK);
  return { faqs, departments };
}

/** 문의 행이 비어 주인을 모르는 FAQ는 IT FAQ 주인 부서 누구나 고쳐요. */
const ownsFaq = (f: OwnedItFaq, department: string, owners: FaqOwners) =>
  f.ownerDepartment === department || (f.ownerDepartment === null && owners.departments.has(department));

const notFaqOwner = (owners: FaqOwners) => new DeskError('forbidden', 403, `IT FAQ는 ${[...owners.departments].join('·')} 분장표 주인만 올려요`);
const OTHER_FAQ = () => new DeskError('other-department', 422, '다른 부서 IT FAQ는 바뀌지 않아요');

function faqVersion(faqs: OwnedItFaq[]): string {
  return createHash('sha256').update(JSON.stringify(faqs)).digest('hex').slice(0, 24);
}

/**
 * 올린 파일과 지금 IT FAQ를 견줘요. 바뀌는 것은 우리 부서 FAQ뿐이에요.
 * 다른 부서 FAQ를 바꾸거나, 문의 행을 우리 부서 분장표 행이 아닌 곳으로 두면 거부해요. 파일에 없는 FAQ는 지우지 않아요.
 */
async function diffFaqs(q: Queryable, department: string, fileRows: ItFaqFileRow[]) {
  const owners = await faqOwners(q);
  if (!owners.departments.has(department)) throw notFaqOwner(owners);
  const current = new Map(owners.faqs.map((f) => [f.id, f]));
  const ownRows = new Set((await repo.rowsOfDepartment(q, department)).map((r) => r.id));
  const changes: ItFaqChange[] = [];
  const rows: ItFaqFileRow[] = [];
  const seenOwn = new Set<string>();
  let unchanged = 0;
  for (const f of fileRows) {
    const existing = current.get(f.id);
    if (existing && !ownsFaq(existing, department, owners)) {
      if (faqFields(existing, f).length > 0) throw OTHER_FAQ();
      continue;
    }
    if (!f.rowId || !ownRows.has(f.rowId)) throw itFaqFormatError(`${f.id} 행 "${IT_FAQ_COLUMNS.rowId}" 칸은 우리 부서(${department}) 분장표 행 ID를 써요`);
    seenOwn.add(f.id);
    const fields = faqFields(existing, f);
    if (existing && fields.length === 0) {
      unchanged += 1;
      continue;
    }
    changes.push({ faqId: f.id, title: f.title, type: existing ? 'changed' : 'added', fields });
    rows.push(f);
  }
  const owned = owners.faqs.filter((f) => ownsFaq(f, department, owners));
  const untouched = owned.filter((f) => !seenOwn.has(f.id)).length;
  return { changes, rows, unchanged, untouched, version: faqVersion(owned) };
}

export function createItHelpService(ctx: AppContext) {
  let realFaqs = true;
  const refreshSource = async () => {
    realFaqs = await repo.hasUploadedItFaqs(ctx.db);
  };

  return {
    hasRealFaqs: () => realFaqs,
    refreshSource,

    /** 가상 IT FAQ를 넣거나 맞춰요. 분장표 seed 뒤에 불러요(FAQ가 분장표 행을 가리켜요). */
    async seed(): Promise<void> {
      // 가상 FAQ는 늘 고정 파일 내용으로 맞춰요(시연 DB에 나중에 고친 행 연결·다른 말이 들어가게). 회사가 올린 FAQ는 그대로예요.
      await ctx.db.tx(async (q) => {
        for (const f of demoItFaqs()) await repo.upsertDemoItFaq(q, f);
      });
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
      // 못 찾았으면 IT지원팀의 "IT 오류 문의" 같은 일반 오류 행으로 보내요. 첫 행("노트북·PC 고장")으로 가던 문제(11/1 QA M3).
      const inquiryRow = rows.find((r) => r.id === found?.faq.rowId) ?? rows.find((r) => r.task.includes('오류')) ?? rows[0] ?? null;
      return {
        ...(found ? { faq: { id: found.faq.id, title: found.faq.title, steps: found.faq.steps, revisedOn: found.faq.revisedOn } } : {}),
        others,
        inquiryRowId: inquiryRow?.id ?? null,
        inquiryTeam: inquiryRow?.team ?? IT_TEAM_FALLBACK,
        inquiryTask: inquiryRow?.task ?? IT_TASK_FALLBACK,
      };
    },

    /** IT FAQ 올리기 화면 목록: 우리 부서 FAQ. IT FAQ 주인 부서가 아니면 enabled: false예요(화면이 칸을 숨겨요). */
    async listFaqs(user: DeskUser): Promise<ItFaqListResponse> {
      const owners = await faqOwners(ctx.db);
      if (!owners.departments.has(user.department)) return { department: user.department, enabled: false, faqs: [] };
      const faqs = owners.faqs
        .filter((f) => ownsFaq(f, user.department, owners))
        .map((f) => ({
          id: f.id,
          title: f.title,
          aliases: f.aliases,
          errorCodes: f.errorCodes,
          steps: f.steps,
          revisedOn: f.revisedOn,
          rowId: f.rowId,
          source: f.source,
        }));
      return { department: user.department, enabled: true, faqs };
    },

    /** IT FAQ 파일 받기: 우리 부서 FAQ만 IT FAQ 양식으로 내보내요. 사람 이름 칸은 없어요. */
    async exportFaqs(user: DeskUser): Promise<{ filename: string; csv: string }> {
      const owners = await faqOwners(ctx.db);
      if (!owners.departments.has(user.department)) throw notFaqOwner(owners);
      const own = owners.faqs.filter((f) => ownsFaq(f, user.department, owners));
      return { filename: `IT-FAQ-${user.department}-${kstDate(ctx.now())}.csv`, csv: toItFaqCsv(own) };
    },

    /** IT FAQ 미리보기: 바뀌는 FAQ·칸만 보여 줘요. DB는 바꾸지 않아요. */
    async previewFaqs(user: DeskUser, csv: string): Promise<ItFaqPreviewResponse> {
      const file = parseItFaqFile(csv);
      const diff = await diffFaqs(ctx.db, user.department, file);
      return { department: user.department, baseVersion: diff.version, changes: diff.changes, unchanged: diff.unchanged, untouched: diff.untouched };
    },

    /**
     * IT FAQ 반영(확인 시트 뒤). 고정 버튼 쓰기 실행기(ctx.fixed.run)를 거쳐요: 스위치·멱등 키·감사 로그(내용 없음).
     * 실행 순간 다시 검사해요: 미리보기 뒤 우리 부서 FAQ가 바뀌었으면 반영하지 않아요. 바뀐 FAQ는 개정일이 오늘로 올라가요.
     */
    async applyFaqs(user: DeskUser, csv: string, baseVersion: string): Promise<ItFaqApplyResponse> {
      const file = parseItFaqFile(csv);
      const key = createHash('sha256').update(['it-faq', user.department, baseVersion, csv].join('\n')).digest('hex').slice(0, 32);
      const result = await ctx.fixed.run(user, {
        module: 'navi',
        action: 'it-faq-apply',
        idempotencyKey: key,
        resultCode: (r: ItFaqApplyResponse) => (r.applied > 0 ? 'done' : 'no-change'),
        run: async (q, now) => {
          const diff = await diffFaqs(q, user.department, file);
          if (diff.version !== baseVersion) throw new DeskError('faq-changed', 409, '그사이 IT FAQ가 바뀌었어요. 다시 미리 봐 주세요');
          const revisedOn = kstDate(now);
          for (const row of diff.rows) await repo.upsertUploadedItFaq(q, { ...row, revisedOn });
          return {
            applied: diff.rows.length,
            revisedOn,
            message: diff.rows.length > 0 ? '반영했어요. 개정일이 올라갔어요.' : '바뀌는 FAQ가 없어서 그대로 뒀어요.',
          };
        },
      });
      await refreshSource();
      return result;
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
