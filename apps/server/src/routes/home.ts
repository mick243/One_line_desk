import { checkInput, HOME_ASK_MAX, type HomeAskResponse, type HomeTodayResponse } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { accessFrom } from '../core/access-record';
import { HomeDesk } from '../core/home';

// 홈 AI 채팅 "나에게 해당하는 일"(ADR-27, 개선 회의 D8 해제).
// - POST /api/home/ask: 질문 글은 POST 본문과 이 요청 메모리에서만 다뤄요. DB·로그·감사·응답에 넣지 않아요(ADR-10, R13).
// - GET /api/home/today: 홈을 열 때 한 번 부르는 "오늘·이번 주 내 일". 칸이 없고 AI를 부르지 않아요.
// 두 경로 모두 읽기만 해요. 예약·신청·표 만들기는 하지 않고, 다른 일이면 옮기기 카드만 줘요(D8 조건).
const HOME_OFF = { error: 'home-off', message: '지금은 홈에서 찾지 않아요. 기능 페이지에서 찾아 주세요' };

export function registerHomeRoutes(app: FastifyInstance, ctx: AppContext) {
  const home = new HomeDesk(ctx);

  app.post<{ Body: { text: string } }>(
    '/api/home/ask',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: HOME_ASK_MAX } },
        },
      },
    },
    async (req, reply): Promise<HomeAskResponse | undefined> => {
      const user = req.deskUser!;
      if (!ctx.ops.get().homeAsk) return reply.code(409).send(HOME_OFF);
      if (!ctx.rateLimiter.hit(user.pseudonymId, 'home-ask')) {
        return reply.code(429).send({ error: 'rate-limited', message: '요청이 많아요. 잠시 뒤에 다시 보내 주세요.' });
      }
      // 브라우저와 같은 규칙으로 다시 검사해요. 걸리면 내용 없이 버리고 "잠김"만 남겨요(ADR-11).
      const checked = checkInput(req.body.text);
      if (checked.locks.length > 0) {
        await ctx.audit.record({ pseudonymId: user.pseudonymId, channel: 'ask', module: 'home', result: 'locked' });
        return reply.code(422).send({ error: 'locked', message: checked.locks[0]!.message, locks: checked.locks, rulesVersion: checked.rulesVersion });
      }
      // 팀 부재를 보여 주면 접속기록에 접속지·요청 번호가 같이 남아요(ADR-20).
      return home.ask(user, checked.text, accessFrom(req));
    },
  );

  app.get('/api/home/today', { preHandler: ctx.guards.user }, async (req): Promise<HomeTodayResponse> => home.today(req.deskUser!));
}
