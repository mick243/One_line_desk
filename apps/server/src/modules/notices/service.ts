import { type Card, NOTICE_QUERY_MAX_LENGTH, NOTICE_SEARCH_MAX_HITS, NOTICE_TITLE_MAX_LENGTH, type NoticeHit } from '@one-line-desk/shared';
import type { AppContext } from '../../context';
import { makeCard } from '../../core/cards';
import type { AskInput, AskOutcome } from '../../core/module';
import { ALLOWED_BOARDS, type BoardNotice, MOCK_BOARD } from './fixtures';
import { type NoticeQuote, quoteFor } from './quote';
import * as repo from './repo';
import { bigramSet, bigramsOf, coverage, keywords } from './text';

// F1 공지 찾기(ADR-09·14, M6). 찾기는 규칙·색인 검색이에요.
// 내보내는 것은 허용 게시판 공지의 제목·게시일·원문 링크, 그리고 11/5부터 질문에 맞는 원문 한 줄이에요(사용자 결정).
// 원문 한 줄은 본문 문장 하나를 고쳐 쓰지 않고 그대로 옮겨요. AI는 문장 번호만 골라요(quote.ts). 본문은 DB에 두지 않고,
// 요약은 만들지 않아요. MCP notices_search(search)는 그대로 제목·게시일·원문 링크만이에요.

const ASK_TAIL = '질문 원문은 저장하지 않아요';
const QUOTE_TAIL = '공지 문장을 고치지 않고 그대로 옮겼어요 · 질문 원문은 저장하지 않아요';
/** 말 하나가 맞았다고 보는 조각 비율 */
const KEY_MATCH = 0.66;
/** 본문에서만 맞으면 제목보다 덜 쳐줘요. */
const BODY_WEIGHT = 0.7;
const URL_OK = /^https?:\/\/[^\s"'<>]+$/;
const DATE_OK = /^\d{4}-\d{2}-\d{2}$/;
// 제어 문자는 내보내지 않아요(ADR-14).
const CONTROL = /[\u0000-\u001F\u007F]/g;

function isAllowedBoard(board: string): boolean {
  return (ALLOWED_BOARDS as readonly string[]).includes(board);
}

/** 게시판 사본 한 건을 색인 한 줄로 바꿔요. 허용 밖 게시판·양식이 틀린 공지는 null이에요. 본문은 조각으로만 남아요. */
export function indexNotice(n: BoardNotice): repo.IndexedNotice | null {
  if (!isAllowedBoard(n.board)) return null;
  if (!URL_OK.test(n.url) || !DATE_OK.test(n.postedOn) || n.title.trim().length === 0 || n.title.length > 200) return null;
  return { id: n.id, board: n.board, title: n.title.trim(), postedOn: n.postedOn, url: n.url, terms: [...bigramSet(n.title, n.body)].sort() };
}

function cleanTitle(title: string): string {
  return title.replace(CONTROL, ' ').trim().slice(0, NOTICE_TITLE_MAX_LENGTH);
}

function noticeCard(hit: NoticeHit, quote: NoticeQuote | null): Card {
  return makeCard({
    id: `notice-${hit.id}`,
    kind: 'notices',
    label: '안내',
    headline: '공지에서 찾았어요',
    fields: [
      { name: '제목', value: hit.title },
      { name: '게시일', value: hit.postedOn },
      ...(quote ? [{ name: '원문 한 줄', value: `“${quote.sentence}”` }] : []),
    ],
    // 찾기는 규칙·색인이에요. "AI 정리"는 원문 한 줄을 실제 모델이 골랐을 때만 붙여요. 원문 링크는 꼭 있어요.
    evidence: {
      text: quote?.byModel ? `AI가 질문에 맞는 문장을 골랐어요 · 공지 원문 · ${hit.board}` : `공지 원문 · ${hit.board}`,
      href: hit.url,
      aiSummarized: quote?.byModel ?? false,
    },
    primary: { type: 'link', text: '원문 열기', href: hit.url },
    wrong: { predictedKind: 'notices', candidates: [] },
    tail: quote ? QUOTE_TAIL : ASK_TAIL,
  });
}

function notFoundCard(): Card {
  return makeCard({
    id: 'notices-not-found',
    kind: 'notices',
    label: '안내',
    headline: '공지에서 찾지 못했어요',
    evidence: { text: `찾아본 범위: ${ALLOWED_BOARDS.join(' · ')}`, aiSummarized: false },
    primary: { type: 'reask', text: '문의하기에서 찾기', kind: 'navi' },
    tail: ASK_TAIL,
  });
}

export function createNoticesService(ctx: AppContext) {
  // 게시판 사본(지금은 가상 공지) 본문. DB에는 넣지 않고, 원문 한 줄을 고를 때만 이 공지 본문을 읽어요.
  let bodies = new Map(MOCK_BOARD.filter((n) => isAllowedBoard(n.board)).map((n) => [n.id, n.body]));

  /** 허용 게시판에서 제목·게시일·원문 링크만 찾아요. MCP notices_search도 이걸 불러요(LLM 없음, DB 읽기만). */
  async function search(query: string, limit: number): Promise<{ mock: boolean; hits: NoticeHit[] }> {
    const keys = keywords(query.slice(0, NOTICE_QUERY_MAX_LENGTH));
    const max = Math.max(1, Math.min(NOTICE_SEARCH_MAX_HITS, Math.floor(limit)));
    if (keys.length === 0) return { mock: true, hits: [] };
    const grams = [...new Set(keys.flatMap(bigramsOf))];
    const found = await repo.candidates(ctx.db, ALLOWED_BOARDS, grams);
    const need = Math.max(BODY_WEIGHT, keys.length * 0.5);
    const scored = found
      .filter((n) => isAllowedBoard(n.board))
      .map((n) => {
        const inTitle = bigramSet(n.title);
        const inAll = new Set(n.terms);
        let score = 0;
        for (const k of keys) {
          const t = coverage(k, inTitle);
          const a = coverage(k, inAll);
          score += t >= KEY_MATCH ? t : a >= KEY_MATCH ? a * BODY_WEIGHT : 0;
        }
        return { n, score };
      })
      .filter((s) => s.score >= need)
      .sort((a, b) => b.score - a.score || b.n.postedOn.localeCompare(a.n.postedOn) || a.n.id.localeCompare(b.n.id))
      .slice(0, max);
    return {
      mock: true,
      hits: scored.map(({ n }) => ({ id: n.id, title: cleanTitle(n.title), postedOn: n.postedOn, url: n.url, board: n.board })),
    };
  }

  return {
    search,

    async ask(input: AskInput): Promise<AskOutcome> {
      const { hits } = await search(input.text, 1);
      const hit = hits[0];
      if (!hit) return { cards: [notFoundCard()], found: false };
      const body = bodies.get(hit.id);
      const quote = body ? await quoteFor(ctx.gateway, input.text, hit.title, body) : null;
      return { cards: [noticeCard(hit, quote)], found: true };
    },

    /** 비어 있을 때만 허용 게시판 사본을 색인해요. 여러 번 불러도 한 번만 들어가요. */
    async seed(source: BoardNotice[] = MOCK_BOARD): Promise<void> {
      bodies = new Map(source.filter((n) => isAllowedBoard(n.board)).map((n) => [n.id, n.body]));
      if ((await repo.countNotices(ctx.db)) > 0) return;
      await ctx.db.tx(async (q) => {
        for (const n of source) {
          const indexed = indexNotice(n);
          if (indexed) await repo.insertNoticeIfAbsent(q, indexed);
        }
      });
    },
  };
}

export type NoticesService = ReturnType<typeof createNoticesService>;
