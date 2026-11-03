import {
  addDays,
  awayOn,
  AWAY_KINDS,
  AWAY_MAX_DAYS,
  AWAY_MAX_ITEMS,
  type AwayListResponse,
  type AwaySetRequest,
  kstDate,
  KST_OFFSET,
} from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import type { NaviAwayRead } from '../../core/services';
import * as repo from './repo';

// 자리비움(11/3 사용자 결정). 직원이 자기 외근·출장·재택·자리비움을 알리고, 같은 부서 사람이 홈 채팅 "같은 팀 일정"에서 봐요.
// - 칸은 종류 코드·시작·끝뿐이에요. 자유 글(사유·장소)은 받지 않아요(경로 스키마가 다른 칸을 막아요).
// - 정하기·지우기는 본인만, 고정 버튼(ctx.fixed.run, 멱등 키)으로만 해요. 감사에는 모듈·동작·결과만 남아요.
// - 오늘부터 7일 안의 구간만 받아요. 표는 7일 보관(ADR-21)이고 navi 보관 회차가 지워요.
// - 보는 곳이 같은 팀 일정뿐이라, 같은 팀 일정(teamSchedule)이나 담당 찾기가 꺼지면 이 기능도 닫혀요.

const ID = '^[0-9]{1,18}$';
const startOf = (date: string) => Date.parse(`${date}T00:00:00${KST_OFFSET}`);

export function createAwayRead(ctx: AppContext): NaviAwayRead {
  return {
    async ofPeople(pseudonymIds, from, to) {
      return (await repo.awayOf(ctx.db, pseudonymIds, from, to)).map((r) => ({ pseudonymId: r.pseudonymId, kind: r.kind, start: r.start, end: r.end }));
    },
  };
}

export function registerAwayRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/navi/away', { preHandler: ctx.guards.user }, async (req): Promise<AwayListResponse> => {
    if (!awayOn(ctx.ops.get())) return { enabled: false, items: [] };
    const rows = await repo.myAway(ctx.db, req.deskUser!.pseudonymId, ctx.now());
    return { enabled: true, items: rows.map((r) => ({ id: r.id, kind: r.kind, start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() })) };
  });

  app.post<{ Body: AwaySetRequest }>(
    '/api/navi/away',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['kind', 'start', 'end', 'requestId'],
          additionalProperties: false,
          properties: {
            kind: { enum: [...AWAY_KINDS] },
            start: { type: 'string', format: 'date-time', maxLength: 40 },
            end: { type: 'string', format: 'date-time', maxLength: 40 },
            requestId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (req): Promise<AwayListResponse> => {
      const user = req.deskUser!;
      if (!awayOn(ctx.ops.get())) throw new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
      const now = ctx.now();
      const start = Date.parse(req.body.start);
      const end = Date.parse(req.body.end);
      const today = kstDate(now);
      if (!(end > start)) throw new DeskError('bad-request', 400, '끝나는 때를 시작보다 뒤로 골라 주세요');
      if (start < startOf(today) || end <= now) throw new DeskError('bad-request', 400, '오늘부터 고를 수 있어요');
      if (end > startOf(addDays(today, AWAY_MAX_DAYS))) throw new DeskError('bad-request', 400, `오늘부터 ${AWAY_MAX_DAYS}일 안에서 골라 주세요`);
      await ctx.fixed.run(user, {
        module: 'navi',
        action: 'away.set',
        idempotencyKey: req.body.requestId,
        enabled: awayOn,
        run: async (q, at) => {
          if ((await repo.myAway(q, user.pseudonymId, at)).length >= AWAY_MAX_ITEMS) {
            throw new DeskError('too-many', 409, `자리비움은 ${AWAY_MAX_ITEMS}개까지 둘 수 있어요. 지난 것을 지워 주세요`);
          }
          return repo.insertAway(q, { pseudonymId: user.pseudonymId, kind: req.body.kind, start, end, now: at });
        },
      });
      const rows = await repo.myAway(ctx.db, user.pseudonymId, ctx.now());
      return {
        enabled: true,
        items: rows.map((r) => ({ id: r.id, kind: r.kind, start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() })),
      };
    },
  );

  // 지우기: 본인 줄만. 줄 번호는 주소에 남지 않게 POST 본문으로 받아요.
  app.post<{ Body: { id: string; requestId: string } }>(
    '/api/navi/away/clear',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['id', 'requestId'],
          additionalProperties: false,
          properties: { id: { type: 'string', pattern: ID }, requestId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req): Promise<AwayListResponse> => {
      const user = req.deskUser!;
      const removed = await ctx.fixed.run(user, {
        module: 'navi',
        action: 'away.clear',
        idempotencyKey: req.body.requestId,
        enabled: awayOn,
        resultCode: (n: number) => (n ? 'done' : 'not-found'),
        run: (q) => repo.deleteAway(q, req.body.id, user.pseudonymId),
      });
      if (!removed) throw new DeskError('not-found', 404, '그 자리비움을 찾지 못했어요');
      const rows = await repo.myAway(ctx.db, user.pseudonymId, ctx.now());
      return {
        enabled: true,
        items: rows.map((r) => ({ id: r.id, kind: r.kind, start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() })),
      };
    },
  );
}
