import { randomBytes } from 'node:crypto';
import {
  checkInput,
  DEMO_BOARD_BODY_MAX,
  DEMO_BOARD_NAME,
  DEMO_BOARD_TITLE_MAX,
  type DemoBoardPost,
  type DemoBoardPostRequest,
  type DemoBoardPostResponse,
  type DemoBoardResponse,
  formatKstDateTime,
  kstDate,
  recordCutoff,
} from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { DeskError } from '../core/errors';

// 시연 전용 가상 그룹웨어 게시판(11/6 사용자 요청, 새 공지 알림 대상 시연). 가상 그룹웨어 전자결재(demo-groupware.ts)와 같은 시연 전용 장치예요.
// 한 줄 데스크가 아니라 "회사 그룹웨어 게시판" 자리에 서는 흉내예요. 시연 한 바퀴: 여기 공지 올리기 → 한 줄 데스크 공지 사본에 들어옴
// (게시판 사본 갱신과 같은 길, ctx.services.notices.ingest) → AI가 알림 대상 제안 → 총무 확인 → 대상자에게 알림.
// - 11/6 사용자 결정: 가상 그룹웨어는 "시연 무대"로만 두고 키우지 않아요. 제목·본문 올리기와 읽기 목록뿐이에요
//   (게시판 고르기·댓글·첨부·수정·삭제·권한 없음). 글은 늘 허용 게시판 '전사 공지'로 들어가요.
// - 시연 설정(config.demo)일 때만 경로를 붙여요. 운영에는 경로가 없어요(404, 시험으로 지켜요).
// - 게시 글은 서버 메모리에만 둬요(DEMO_BOARD_MAX_POSTS건, 만든 지 7일 지나면 지움, 서버가 다시 뜨면 비워짐). 새 표·마이그레이션이 없어요.
// - 제목·본문은 공통 입력 검사(등급 3·키·건강 정보 잠금, 이메일·IP 가림)를 지나요. 올린 사람 이름은 두지 않아요(같은 요청 두 번 막기에만 IdP 주체를 메모리에 써요).
// - 한 줄 데스크 쪽은 공지 사본 규칙 그대로예요: 제목·게시일·원문 링크와 색인 조각만 DB에 두고, 본문은 메모리에만 둬요.
// - 이 경로는 감사 로그·알림·AI 호출을 하지 않아요. 사본에 들어간 뒤의 일(대상 제안·알림)은 공지 모듈이 해요.

/** 메모리에 둘 게시 글 수 상한(넘으면 오래된 것부터 지워요) */
export const DEMO_BOARD_MAX_POSTS = 50;

interface Post extends DemoBoardPost {
  at: number;
  requestKey: string;
  copy: DemoBoardPostResponse['copy'];
}

/** 게시 글 보관함(서버 메모리). 시연 전용이라 서버가 다시 뜨면 비워져요. */
export class DemoBoardStore {
  private readonly posts = new Map<string, Post>();

  constructor(private readonly now: () => number) {}

  /** 만든 지 7일 지난 글을 지워요. 열 때마다, 그리고 한 시간 보관 회차마다 불러요. */
  purge(): void {
    const cutoff = recordCutoff(this.now());
    for (const [id, p] of this.posts) if (p.at < cutoff) this.posts.delete(id);
  }

  all(): Post[] {
    this.purge();
    return [...this.posts.values()];
  }

  byRequest(key: string): Post | undefined {
    return this.all().find((p) => p.requestKey === key);
  }

  add(post: Post): void {
    this.purge();
    while (this.posts.size >= DEMO_BOARD_MAX_POSTS) this.posts.delete(this.posts.keys().next().value!);
    this.posts.set(post.id, post);
  }

  get size(): number {
    return this.posts.size;
  }
}

const view = ({ at: _at, requestKey: _key, copy: _copy, ...post }: Post): DemoBoardPost => post;

/** 공통 입력 검사를 지난 글. 잠기는 글자가 있으면 400이에요. 이메일·IP는 가린 글로 둬요. */
function checked(raw: string, label: string, max: number): string {
  const text = raw.trim();
  if (!text) throw new DeskError('bad-request', 400, `${label}을 적어 주세요`);
  if (text.length > max) throw new DeskError('bad-request', 400, `${label}은 ${max}자까지 적을 수 있어요`);
  const result = checkInput(text);
  if (result.locks.length) throw new DeskError('locked', 400, `올릴 수 없는 글자가 있어요: ${[...new Set(result.locks.map((l) => l.message))].join(' · ')}`);
  return result.text;
}

/**
 * 가상 게시판 경로를 붙여요. 시연이 아니면 아무것도 붙이지 않고 null이에요(운영은 404).
 * 돌려준 보관함은 서버의 한 시간 보관 회차가 purge()로 지워요.
 */
export function registerDemoBoardRoutes(app: FastifyInstance, ctx: AppContext): DemoBoardStore | null {
  if (!ctx.config.demo) return null;
  const store = new DemoBoardStore(ctx.now);
  const base = ctx.config.publicBaseUrl.replace(/\/+$/, '');

  app.get('/api/demo/groupware/board', { preHandler: ctx.guards.user }, async (): Promise<DemoBoardResponse> => ({
    posts: store
      .all()
      .sort((a, b) => b.at - a.at)
      .map(view),
  }));

  // 공지 올리기: 올리면 한 줄 데스크 공지 사본에 들어가요(게시판 사본 갱신과 같은 길). 같은 요청 번호로 두 번 와도 한 번만 올라가요.
  app.post<{ Body: DemoBoardPostRequest }>(
    '/api/demo/groupware/board/posts',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['title', 'body', 'requestId'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', maxLength: DEMO_BOARD_TITLE_MAX },
            body: { type: 'string', maxLength: DEMO_BOARD_BODY_MAX },
            requestId: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' },
          },
        },
      },
    },
    async (req): Promise<DemoBoardPostResponse> => {
      const user = req.deskUser!;
      if (!ctx.rateLimiter.hit(user.pseudonymId, 'demo-groupware')) throw new DeskError('rate-limited', 429, '요청이 많아요. 잠시 뒤에 다시 해 주세요');
      const requestKey = `${user.idpSubject}|${req.body.requestId}`;
      const again = store.byRequest(requestKey);
      if (again) return { post: view(again), copy: again.copy };
      const title = checked(req.body.title, '제목', DEMO_BOARD_TITLE_MAX);
      const body = checked(req.body.body, '본문', DEMO_BOARD_BODY_MAX);
      const at = ctx.now();
      const id = `GB-${randomBytes(4).toString('hex')}`;
      const post: Post = {
        id,
        title,
        body,
        postedOn: kstDate(at),
        createdAt: formatKstDateTime(at),
        at,
        requestKey,
        copy: { copied: false, audience: null },
      };
      store.add(post);
      // 한 줄 데스크 공지 사본에 넣어요. 본문은 그쪽에서도 DB에 두지 않아요. 실패해도 게시 글은 그대로예요.
      const ingest = ctx.services.notices?.ingest;
      if (ingest) {
        post.copy = await ingest({ id, board: DEMO_BOARD_NAME, title, postedOn: post.postedOn, url: `${base}/demo/groupware/board?post=${id}`, body }).catch(
          () => ({ copied: false, audience: null }),
        );
      }
      return { post: view(post), copy: post.copy };
    },
  );

  return store;
}
