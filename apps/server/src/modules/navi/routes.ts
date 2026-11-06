import {
  type ChartApplyRequest,
  type ChartUploadRequest,
  INQUIRY_QUESTION_MAX,
  INQUIRY_REASON_MAX,
  INQUIRY_REPLY_MAX,
  type InquiryStatsResponse,
  IT_HELP_TEXT_MAX,
  type ItFaqApplyResponse,
  type ItFaqListResponse,
  type ItHelpRequest,
  type InquiryDecisionRequest,
  type InquiryListResponse,
  type InquiryReplyRequest,
  type InquiryRequest,
  LEAVE_REJECT_REASON_MAX,
  LEAVE_REQUEST_MAX_DAYS,
  LEAVE_KINDS,
  LEAVE_TYPES,
  type LeaveCheckRequest,
  type LeaveCheckResponse,
  OFFICIAL_LEAVE_REASONS,
  SICK_LEAVE_REASONS,
  NAVI_ROW_ID_PATTERN,
  type LeaveStartResponse,
  type NaviRowCardRequest,
  type OnboardingResponse,
  kstDate,
} from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import { accessFrom } from '../../core/access-record';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import type { InquiryService } from './inquiries';
import type { ItHelpService } from './it-help';
import { findLeaveRequestRow, leaveCheckForLink, leaveLinkAction } from './leave';
import { checkLeaveLink } from './mcp-read';
import * as repo from './repo';
import type { NaviService } from './service';

// navi 경로. 묻기(/api/ask)와 따로인 행 카드·문의·S5(분장표 주인만)예요.
// 11/3: "틀렸어요" 경로(/api/navi/feedback)를 뺐어요. 받는 곳을 바꿔 보낸 기록은 문의 보내기가 남겨요(ADR-26).

/** 분장표 파일은 글자로 받아요. 기본 본문 한도(64KB)보다 넉넉히 둬요. */
const CHART_BODY_LIMIT = 512 * 1024;
const CHART_CSV_MAX = 400_000;

const featureOff = () => new DeskError('feature-off', 409, '지금은 이 기능이 꺼져 있어요');
/**
 * 11/6 사용자 결정(A안): 앱 안 휴가 결재(휴가 요청 보내기·승인·반려)는 DESK_LEAVE_IN_APP=true(개발·시험)일 때만 열려요.
 * 팀장 결재 단계가 없어서 운영에서는 켤 수 없어요(config.ts). 휴가 신청·결재는 회사 그룹웨어가 해요.
 */
const leaveInAppOff = () => new DeskError('leave-in-app-off', 409, '휴가 신청·결재는 그룹웨어에서 해요. 앱에서는 신청 전 확인만 해요');

export function registerNaviRoutes(app: FastifyInstance, ctx: AppContext, navi: NaviService, inquiries: InquiryService, itHelp: ItHelpService) {
  const owner = [ctx.guards.user, ctx.guards.role('chart-owner')];
  const assertNotOff = () => {
    if (ctx.ops.get().modules.navi === 'off') throw featureOff();
  };

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

  // 휴가 신청 바로 가기(11/5): 홈·문의하기의 [휴가 신청하기]가 날 없이 본인 양식을 열어요. 보내기는 양식의 확인 시트예요(ADR-24).
  // 남은 연차는 이 요청에서만 계산해 본인에게만 주고 저장하지 않아요(ADR-18). 읽기만이라 감사·접속기록은 없어요.
  // 11/6 A안: 앱 안 휴가 결재가 꺼져 있으면(운영 기본) 양식 대신 신청 전 카드(남은 연차·[그룹웨어에서 신청하기])예요.
  app.get('/api/navi/leave/start', { preHandler: ctx.guards.user }, async (req): Promise<LeaveStartResponse> => {
    assertNotOff();
    if (!ctx.config.leaveInApp) return { action: null, card: await leaveCheckForLink(ctx, req.deskUser!, [], 'annual') };
    const target = findLeaveRequestRow(await repo.allRows(ctx.db));
    return { action: target ? await leaveLinkAction(ctx, req.deskUser!, target, [], 'annual') : null };
  });

  // [이 날로 보기](11/6 A안 신청 전 카드): 걸린 일이 없는 가까운 날로 카드를 다시 계산해요. 읽기만이고 저장·감사·AI 호출이 없어요.
  // 날짜·종류 코드만 POST 본문으로 받아요(글 없음). 날 검사는 MCP 휴가 준비 링크와 같아요(평일·공휴일·회사 휴일 아님·1년 안·병가는 지난 3일까지).
  app.post<{ Body: LeaveCheckRequest }>(
    '/api/navi/leave/check',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['type', 'days'],
          additionalProperties: false,
          properties: {
            type: { enum: [...LEAVE_KINDS] },
            days: {
              type: 'array',
              minItems: 1,
              maxItems: LEAVE_REQUEST_MAX_DAYS,
              items: {
                type: 'object',
                required: ['date', 'kind'],
                additionalProperties: false,
                properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, kind: { enum: ['full', 'half'] }, half: { enum: ['am', 'pm'] } },
              },
            },
          },
        },
      },
    },
    async (req): Promise<LeaveCheckResponse> => {
      assertNotOff();
      if (ctx.config.leaveInApp) throw new DeskError('not-found', 404, '앱 안 휴가 결재가 켜져 있으면 휴가 신청 양식에서 날을 골라요');
      const checked = checkLeaveLink(req.body, kstDate(ctx.now()), ctx.ops.get().companyHolidays);
      if (!checked.ok) throw new DeskError('bad-request', 400, checked.message);
      return { card: await leaveCheckForLink(ctx, req.deskUser!, checked.days, req.body.type) };
    },
  );

  // 신규 입사자 첫 2주 할 일(넓힐 후보 ①). 누구나 읽어요. 진행은 저장하지 않아요.
  app.get('/api/navi/onboarding', { preHandler: ctx.guards.user }, async (): Promise<OnboardingResponse> => {
    assertNotOff();
    return navi.onboarding();
  });

  // IT 오류 문장 → IT FAQ(넓힐 후보 ②). 가린 글이 POST 본문으로만 오고 저장하지 않아요. 감사 로그도 남기지 않아요(글·FAQ 번호 없음).
  app.post<{ Body: ItHelpRequest }>(
    '/api/navi/it-help',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: IT_HELP_TEXT_MAX } },
        },
      },
    },
    async (req, reply) => {
      assertNotOff();
      if (!ctx.rateLimiter.hit(req.deskUser!.pseudonymId, 'it-help')) {
        return reply.code(429).send({ error: 'rate-limited', message: '요청이 많아요. 잠시 뒤에 다시 보내 주세요.' });
      }
      return itHelp.match(req.body.text);
    },
  );

  // 다른 후보 제목을 눌렀을 때 그 FAQ 원문 단계(읽기만). FAQ 번호도 주소에 남지 않게 POST 본문으로 받아요.
  app.post<{ Body: { id: string } }>(
    '/api/navi/it-help/faq',
    {
      preHandler: ctx.guards.user,
      schema: { body: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^ITF-[0-9]{2,3}$' } } } },
    },
    async (req, reply) => {
      assertNotOff();
      // 붙여넣기와 같은 횟수 상한을 같이 써요(11/1 QA L3).
      if (!ctx.rateLimiter.hit(req.deskUser!.pseudonymId, 'it-help')) {
        return reply.code(429).send({ error: 'rate-limited', message: '요청이 많아요. 잠시 뒤에 다시 보내 주세요.' });
      }
      return itHelp.faq(req.body.id);
    },
  );

  // 받은 문의 주간 셈(넓힐 후보 ④). 분장표 주인이 자기 부서 것만 봐요. 사람·글 없는 건수예요.
  app.get('/api/navi/inquiry-stats', { preHandler: owner }, async (req): Promise<InquiryStatsResponse> => {
    assertNotOff();
    return navi.inquiryStats(req.deskUser!);
  });

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

  // IT FAQ 파일 올리기(11/3). 분장표 주인 가드 뒤에, 서비스가 IT FAQ 주인 부서(FAQ 문의 행의 주인 부서)인지 다시 봐요.
  app.get('/api/navi/it-faq', { preHandler: owner }, async (req): Promise<ItFaqListResponse> => {
    assertNotOff();
    return itHelp.listFaqs(req.deskUser!);
  });

  app.get('/api/navi/it-faq/export', { preHandler: owner }, async (req) => {
    assertNotOff();
    return itHelp.exportFaqs(req.deskUser!);
  });

  app.post<{ Body: ChartUploadRequest }>(
    '/api/navi/it-faq/preview',
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
      return itHelp.previewFaqs(req.deskUser!, req.body.csv);
    },
  );

  app.post<{ Body: ChartApplyRequest }>(
    '/api/navi/it-faq/apply',
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
    async (req): Promise<ItFaqApplyResponse> => {
      const res = await itHelp.applyFaqs(req.deskUser!, req.body.csv, req.body.baseVersion);
      // FAQ가 가리키는 분장표 행(담당 카드의 [오류 창 글로 해결 방법 찾기] 버튼)이 바뀌었을 수 있어서 메모리 분장표도 다시 읽어요.
      await navi.refreshSource();
      return res;
    },
  );

  // ── 담당 팀에 문의 보내기(ADR-16). 받는 곳은 분장표 행의 주인 부서예요. ──
  app.post<{ Body: InquiryRequest }>(
    '/api/navi/inquiries',
    {
      preHandler: ctx.guards.user,
      schema: {
        body: {
          type: 'object',
          // reason(자유 글 사유)은 병가 요청에는 오지 않아요(11/3). 그 밖에는 서비스가 꼭 있는지 봐요.
          required: ['rowId', 'question', 'requestId'],
          additionalProperties: false,
          properties: {
            rowId: { anyOf: [{ type: 'string', pattern: NAVI_ROW_ID_PATTERN }, { type: 'null' }] },
            suggestedRowId: { anyOf: [{ type: 'string', pattern: NAVI_ROW_ID_PATTERN }, { type: 'null' }] },
            question: { type: 'string', minLength: 1, maxLength: INQUIRY_QUESTION_MAX },
            reason: { type: 'string', minLength: 1, maxLength: INQUIRY_REASON_MAX },
            requestId: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' },
            // 휴가 요청(ADR-24): 쓸 날과 하루·반차. 11/3: 반차는 half(오전 am · 오후 pm)가 꼭 있어야 해요(서비스가 검사해요).
            leave: {
              type: 'object',
              required: ['days'],
              additionalProperties: false,
              properties: {
                days: {
                  type: 'array',
                  minItems: 1,
                  maxItems: LEAVE_REQUEST_MAX_DAYS,
                  items: {
                    type: 'object',
                    required: ['date', 'kind'],
                    additionalProperties: false,
                    properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, kind: { enum: ['full', 'half'] }, half: { enum: ['am', 'pm'] } },
                  },
                },
                // 11/1 공가: 종류가 없으면 연차예요. 공가 사유는 정해진 코드만 받아요.
                type: { enum: [...LEAVE_TYPES] },
                officialReason: { enum: [...OFFICIAL_LEAVE_REASONS] },
                // 11/3 병가: 사유는 정해진 코드만 받아요(자유 글 없음).
                sickReason: { enum: [...SICK_LEAVE_REASONS] },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      // 명단 밖으로 넓힌 시연은 여러 사람이 같은 가상 직원으로 들어와서, 저장한 문의를 받는 팀 가상 직원으로 들어온 남이 봐요.
      // 그래서 저장하지 않고 알려 줘요(10/29 배포 준비 회의 쟁점 5).
      if (ctx.config.demoWide) return reply.code(409).send({ error: 'demo-locked', message: '시연에서는 보내지 않아요' });
      // 휴가 요청(ADR-24)은 앱 안 휴가 결재가 켜졌을 때만이에요(11/6 A안). 일반 문의는 그대로예요.
      if (req.body.leave && !ctx.config.leaveInApp) throw leaveInAppOff();
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

  const ID_PARAMS = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^[0-9]{1,18}$' } } };

  // 휴가 요청 승인·반려(ADR-24). 받은 부서 사람이 누른 고정 버튼이에요. 반려는 사유가 꼭 있어야 해요. 접속기록에 남겨요(ADR-20).
  app.post<{ Params: { id: string }; Body: InquiryDecisionRequest }>(
    '/api/navi/inquiries/:id/decision',
    {
      preHandler: ctx.guards.user,
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          required: ['decision'],
          additionalProperties: false,
          properties: { decision: { enum: ['approved', 'rejected'] }, reason: { type: 'string', maxLength: LEAVE_REJECT_REASON_MAX } },
        },
      },
    },
    async (req) => {
      // 승인·반려도 앱 안 휴가 결재가 켜졌을 때만이에요(11/6 A안). 앱은 결재 권한이 없어요.
      if (!ctx.config.leaveInApp) throw leaveInAppOff();
      const item = await inquiries.decide(req.deskUser!, req.params.id, req.body);
      await ctx.access.record({
        pseudonymId: req.deskUser!.pseudonymId,
        action: 'inquiry.update',
        subjectRefs: [`inquiry:${req.params.id}`],
        ...accessFrom(req),
      });
      return item;
    },
  );

  // 받은 팀의 답장(ADR-24). 글은 POST 본문으로만 오고 7일 보관해요.
  app.post<{ Params: { id: string }; Body: InquiryReplyRequest }>(
    '/api/navi/inquiries/:id/reply',
    {
      preHandler: ctx.guards.user,
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          required: ['text', 'requestId'],
          additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: INQUIRY_REPLY_MAX }, requestId: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' } },
        },
      },
    },
    async (req, reply) => {
      if (ctx.config.demoWide) return reply.code(409).send({ error: 'demo-locked', message: '시연에서는 보내지 않아요' });
      const out = await inquiries.reply(req.deskUser!, req.params.id, req.body);
      await ctx.access.record({
        pseudonymId: req.deskUser!.pseudonymId,
        action: 'inquiry.update',
        subjectRefs: [`inquiry:${req.params.id}`],
        ...accessFrom(req),
      });
      return out;
    },
  );
}
