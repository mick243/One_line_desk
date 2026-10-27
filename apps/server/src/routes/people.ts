import { PEOPLE_SEARCH_LIMIT, type PeopleSearchResponse, roomsWriteOn } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { DeskError } from '../core/errors';
import { personRef } from '../core/person-ref';

// 참석자 고르기용 직원 검색(ADR-17). 이름·부서·층만 몇 명까지 줘요. 명단을 통째로 주지 않아요.
// 검색어는 주소에 남지 않게 POST 본문으로 받고, 로그·감사 기록에 넣지 않아요. LLM은 부르지 않아요.
// 참석자 초대가 꺼져 있으면(회의실이 `켬`이 아니거나 회의실 쓰기 끔) 검색도 닫아요(QA-27, 보안 4.5절 1).
export function registerPeopleRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post<{ Body: { query: string } }>(
    '/api/people/search',
    {
      preHandler: ctx.guards.user,
      schema: { body: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: { type: 'string', maxLength: 30 } } } },
    },
    async (req): Promise<PeopleSearchResponse> => {
      const user = req.deskUser!;
      if (!roomsWriteOn(ctx.ops.get())) throw new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
      const query = req.body.query.trim();
      if (!query) return { items: [] };
      if (!ctx.rateLimiter.hit(user.pseudonymId, 'people.search')) throw new DeskError('rate-limited', 429, '요청이 많아요. 잠시 뒤에 다시 찾아 주세요');
      const found = await ctx.adapters.directory.search(query, PEOPLE_SEARCH_LIMIT + 1);
      return {
        items: found
          .filter((p) => p.idpSubject !== user.idpSubject)
          .slice(0, PEOPLE_SEARCH_LIMIT)
          .map((p) => ({ ref: personRef(ctx.config.pseudonymSecret, p.idpSubject), name: p.displayName, department: p.department, floor: p.floor })),
      };
    },
  );
}
