import {
  type ChartApplyRequest,
  type ChartUploadRequest,
  INQUIRY_QUESTION_MAX,
  INQUIRY_REASON_MAX,
  type InquiryListResponse,
  type InquiryRequest,
  KINDS,
  NAVI_ROW_ID_PATTERN,
  type NaviRowCardRequest,
  WRONG_REASONS,
  type WrongFeedbackRequest,
} from '@one-line-desk/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { accessFrom } from '../../core/access-record';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import type { InquiryService } from './inquiries';
import type { NaviService } from './service';

// navi 경로. 묻기(/api/ask)와 따로인 피드백 경로·행 카드·S5(분장표 주인만)예요.

/** 분장표 파일은 글자로 받아요. 기본 본문 한도(64KB)보다 넉넉히 둬요. */
const CHART_BODY_LIMIT = 512 * 1024;
const CHART_CSV_MAX = 400_000;

const featureOff = () => new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');

const FEEDBACK_KEYS = ['predictedKind', 'correctedKind', 'predictedRowId', 'chosenRowId', 'reason'];

/**
 * "틀렸어요" 기록은 정해진 칸 말고 다른 칸(자유 문장 등)이 오면 거부해요(R8, ADR-09 시험).
 * 앱 전체 검사기도 모르는 칸을 거부하지만(removeAdditional: false), 이 기록은 익명성이 걸려 있어서 한 번 더 막아요.
 */
async function rejectUnknownFeedbackKeys(req: FastifyRequest, reply: FastifyReply) {
  const body = req.body;
  if (body && typeof body === 'object' && Object.keys(body).some((k) => !FEEDBACK_KEYS.includes(k))) {
    return reply.code(400).send({ error: 'bad-request', message: '요청 형식이 맞지 않아요' });
  }
  return undefined;
}

export function registerNaviRoutes(app: FastifyInstance, ctx: AppContext, navi: NaviService, inquiries: InquiryService) {
  const owner = [ctx.guards.user, ctx.guards.role('chart-owner')];
  const assertNotOff = () => {
    if (ctx.ops.get().modules.navi === 'off') throw featureOff();
  };

  // "틀렸어요" 기록(R8). 자유 문장 칸은 없고, 다른 칸이 오면 거부해요. 사용자 ID는 받지도 남기지도 않아요.
  app.post<{ Body: WrongFeedbackRequest }>(
    '/api/navi/feedback',
    {
      preValidation: rejectUnknownFeedbackKeys,
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['predictedKind', 'reason'],
          additionalProperties: false,
          properties: {
            predictedKind: { enum: [...KINDS] },
            correctedKind: { enum: [...KINDS] },
            predictedRowId: { type: 'string', pattern: NAVI_ROW_ID_PATTERN },
            chosenRowId: { type: 'string', pattern: NAVI_ROW_ID_PATTERN },
            reason: { enum: [...WRONG_REASONS] },
          },
        },
      },
    },
    async (req, reply) => {
      assertNotOff();
      // 횟수는 서버 메모리에 피드백 칸으로 따로 세요(내용 없음).
      if (!ctx.rateLimiter.hit(req.deskUser!.pseudonymId, 'feedback')) {
        return reply.code(429).send({ error: 'rate-limited', message: '요청이 많아요. 잠시 뒤에 다시 보내 주세요.' });
      }
      await navi.recordFeedback(req.body);
      return { saved: true };
    },
  );

  // "다른 담당이에요"에서 고른 행 카드(읽기만). 행 ID가 주소·접근 기록에 남지 않게 POST 본문으로 받아요(R11).
  app.post<{ Body: NaviRowCardRequest }>(
    '/api/navi/rows/card',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: { type: 'object', required: ['rowId'], additionalProperties: false, properties: { rowId: { type: 'string', pattern: NAVI_ROW_ID_PATTERN } } },
      },
    },
    async (req) => {
      assertNotOff();
      // status를 같이 줘서 동점 카드의 업무 칩(고정 버튼)이 결과 카드로 바로 보여 줘요.
      return { status: 'done' as const, card: await navi.rowCard(req.body.rowId) };
    },
  );

  // S5 분장표 수정 제안함(분장표 주인만, 자기 부서 행만)
  app.get('/api/navi/chart', { preHandler: owner }, async (req) => {
    assertNotOff();
    return navi.listChart(req.deskUser!);
  });

  app.get('/api/navi/chart/export', { preHandler: owner }, async (req) => {
    assertNotOff();
    return navi.exportChart(req.deskUser!);
  });

  app.post<{ Body: ChartUploadRequest }>(
    '/api/navi/chart/preview',
    {
      preHandler: owner,
      bodyLimit: CHART_BODY_LIMIT,
      schema: {
        body: {
          type: 'object',
          required: ['csv'],
          additionalProperties: false,
          properties: { csv: { type: 'string', minLength: 1, maxLength: CHART_CSV_MAX } },
        },
      },
    },
    async (req) => {
      assertNotOff();
      return navi.previewChart(req.deskUser!, req.body.csv);
    },
  );

  app.post<{ Body: ChartApplyRequest }>(
    '/api/navi/chart/apply',
    {
      preHandler: owner,
      bodyLimit: CHART_BODY_LIMIT,
      schema: {
        body: {
          type: 'object',
          required: ['csv', 'baseVersion'],
          additionalProperties: false,
          properties: {
            csv: { type: 'string', minLength: 1, maxLength: CHART_CSV_MAX },
            baseVersion: { type: 'string', pattern: '^[0-9a-f]{24}$' },
          },
        },
      },
    },
    async (req) => navi.applyChart(req.deskUser!, req.body.csv, req.body.baseVersion),
  );

  // ── 담당 팀에 문의 보내기(ADR-16). 받는 곳은 분장표 행의 주인 부서예요. ──
  app.post<{ Body: InquiryRequest }>(
    '/api/navi/inquiries',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['rowId', 'question', 'reason', 'requestId'],
          additionalProperties: false,
          properties: {
            rowId: { anyOf: [{ type: 'string', pattern: NAVI_ROW_ID_PATTERN }, { type: 'null' }] },
            question: { type: 'string', minLength: 1, maxLength: INQUIRY_QUESTION_MAX },
            reason: { type: 'string', minLength: 1, maxLength: INQUIRY_REASON_MAX },
            requestId: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' },
          },
        },
      },
    },
    async (req, reply) => {
      // 명단 밖으로 넓힌 시연은 여러 사람이 같은 가상 직원으로 들어와서, 저장한 문의를 받는 팀 가상 직원으로 들어온 남이 봐요.
      // 그래서 저장하지 않고 알려 줘요(10/29 배포 준비 회의 쟁점 5).
      if (ctx.config.demoWide) return reply.code(409).send({ error: 'demo-locked', message: '시연에서는 보내지 않아요' });
      return inquiries.send(req.deskUser!, req.body);
    },
  );

  // 받은 문의함은 보낸 사람 이름·부서가 붙은 글을 봐요. 연 사람·접속지·연 문의 번호를 접속기록에 남겨요(ADR-20).
  app.get('/api/navi/inquiries/inbox', { preHandler: ctx.guards.user }, async (req): Promise<InquiryListResponse> => {
    const res = await inquiries.inbox(req.deskUser!);
    if (res.enabled) {
      await ctx.access.record({
        pseudonymId: req.deskUser!.pseudonymId,
        action: 'inquiry.inbox',
        subjectRefs: res.items.slice(0, 100).map((i) => `inquiry:${i.id}`),
        ...accessFrom(req),
      });
    }
    return res;
  });
  app.get('/api/navi/inquiries/mine', { preHandler: ctx.guards.user }, async (req): Promise<InquiryListResponse> => inquiries.mine(req.deskUser!));

  app.post<{ Params: { id: string }; Body: { state: 'seen' | 'done' } }>(
    '/api/navi/inquiries/:id/state',
    {
      preHandler: ctx.guards.user,
      schema: {
        params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^[0-9]{1,18}$' } } },
        body: { type: 'object', required: ['state'], additionalProperties: false, properties: { state: { enum: ['seen', 'done'] } } },
      },
    },
    async (req) => {
      const item = await inquiries.setState(req.deskUser!, req.params.id, req.body.state);
      await ctx.access.record({
        pseudonymId: req.deskUser!.pseudonymId,
        action: 'inquiry.update',
        subjectRefs: [`inquiry:${req.params.id}`],
        ...accessFrom(req),
      });
      return item;
    },
  );
}
