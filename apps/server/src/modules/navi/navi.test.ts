import type { AskResponse, Card, ChartPreviewResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiGateway, type LlmProvider, type StructuredRequest } from '../../core/ai/gateway';
import { pseudonymize } from '../../core/pseudonym';
import { createTestApp, MOCK } from '../../testing';
import { parseChart, toCsv } from './chart-csv';
import { demoChartCsv } from './fixtures';
import { pickRow, rankRows } from './service';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;

// 시험마다 새 PGlite를 띄워요. 전체 시험을 함께 돌리면 기본 5초를 넘길 때가 있어서 넉넉히 둬요.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

/** 시험 앱 + 담당·공지 가상 자료. 다른 모듈의 seed는 부르지 않아요. */
async function setup() {
  const t = await createTestApp();
  opened.push(t);
  for (const m of t.modules) if (m.kind === 'navi' || m.kind === 'notices') await m.seed?.();
  return t;
}

/** 묻기는 분당 횟수 제한이 있어서 부를 때마다 시계를 4초 돌려요. */
async function ask(t: TestApp, s: Session, text: string, kind?: string): Promise<AskResponse> {
  t.advance(4000);
  const res = await s.call('POST', '/api/ask', { text, ...(kind ? { kind } : {}) });
  expect(res.status, text).toBe(200);
  return res.body as AskResponse;
}

async function dumpDb(t: TestApp): Promise<string> {
  const { rows: tables } = await t.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'");
  const out: string[] = [];
  for (const { table_name } of tables) out.push(JSON.stringify((await t.db.query(`select * from ${table_name}`)).rows));
  return out.join('\n');
}

async function chartRows(t: TestApp) {
  return (await t.db.query('select * from navi_rows order by id')).rows;
}

const ROW_EVIDENCE = /^분장표 "(.+)" 행 · 개정일 (\d{4}-\d{2}-\d{2})$/;
const FIXTURE_NAMES = [...new Set([...demoChartCsv().matchAll(/가상 담당 [가-힣]+/g)].map((m) => m[0]))];

describe('[F1] 담당 카드', () => {
  it('[F1-4] 담당 질문은 분장표 행 원문으로 담당 카드를 줘요(사람 이름 없음)', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const res = await ask(t, me, '법인카드 잃어버렸어요');
    expect(res).toMatchObject({ kind: 'navi', confidence: 'high' });
    const card = res.cards[0]!;
    expect(card).toMatchObject({
      id: 'navi-FIN-01',
      kind: 'navi',
      label: '안내',
      fields: [
        { name: '업무 이름', value: '법인카드 분실 신고' },
        { name: '담당 팀·창구', value: '재무팀 · 재무팀 대표 메일 finance@corp.example · 채널 #재무-문의' },
        { name: '지금 할 일', value: expect.stringContaining('카드사 분실 신고 센터') },
        { name: '처리 기간', value: '재발급 7영업일' },
      ],
      evidence: { text: '분장표 "법인카드 분실 신고" 행 · 개정일 2026-09-01' },
      actions: { primary: { type: 'link', text: '창구 열기', href: 'mailto:finance@corp.example' } },
      wrong: { predictedKind: 'navi', predictedRowId: 'FIN-01' },
      tail: '질문 원문은 저장하지 않아요',
    });
    expect(card.wrong!.candidates.length).toBeLessThanOrEqual(3);
    expect(card.wrong!.candidates.map((c) => c.id)).not.toContain('FIN-01');
    for (const name of FIXTURE_NAMES) expect(JSON.stringify(res)).not.toContain(name);
  });

  it('[F1-4] 처리 기간이 비어 있으면 "분장표에 없음"이라고 적어요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const card = (await ask(t, me, '세금계산서 발행은 어디서 해요?', 'navi')).cards[0]!;
    expect(card.id).toBe('navi-FIN-04');
    expect(card.fields.find((f) => f.name === '처리 기간')?.value).toBe('분장표에 없음');
  });

  it('[F1-6] IT 질문은 IT 창구와 헬프데스크 링크가 담긴 담당 카드로 끝나요(해결 단계 없음)', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const card = (await ask(t, me, '노트북이 안 켜져요')).cards[0]!;
    expect(card.id).toBe('navi-IT-01');
    expect(card.actions.primary).toEqual({ type: 'link', text: '창구 열기', href: 'https://helpdesk.example.com/new?type=device' });
    expect(card.fields.map((f) => f.name)).toEqual(['업무 이름', '담당 팀·창구', '지금 할 일', '처리 기간']);
    const row = (await t.db.query<{ next_step: string }>("select next_step from navi_rows where id = 'IT-01'")).rows[0]!;
    expect(card.fields[2]!.value).toBe(row.next_step);
  });

  it('[F1-5] 맞는 행이 없으면 담당 카드 대신 "여기로 물어보세요"(총무 창구)이고, 감사 로그엔 "못 찾음"만 남아요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const res = await ask(t, me, '안녕하세요 반가워요');
    expect(res.kind).toBe('navi');
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]).toMatchObject({
      id: 'navi-ask-here',
      headline: '분장표에서 맞는 곳을 못 찾았어요',
      evidence: { text: '총무 창구 정보', aiSummarized: false },
      actions: { primary: { type: 'link', text: '총무 창구 열기' } },
    });
    expect(res.cards[0]!.wrong).toBeUndefined();
    const { rows } = await t.db.query<{ channel: string; module: string; result: string }>(
      'select channel, module, result from audit_log order by id desc limit 1',
    );
    expect(rows[0]).toEqual({ channel: 'ask', module: 'navi', result: 'not-found' });
  });

  it('[F1 완료 기준] 분장표·공지에 없는 질문을 섞어도 근거 행 없는 담당 카드 0건, 원문 링크 없는 공지 카드 0건', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const questions = [
      '법인카드 잃어버렸어요',
      '휴가 신청 어디서 해요',
      '재직증명서 떼려면 어디로 가요',
      '사원증 잃어버렸어요',
      '와이파이가 안 돼요',
      '수상한 메일이 왔어요',
      '명함 새로 만들고 싶어요',
      '우주선 발사 허가는 누가 해요',
      '점심 메뉴 추천해 주세요',
      '고양이 사료 어디서 사요',
      '건강검진 공지 언제였지',
      '주차 등록 공지 찾아줘',
      '와이파이 이름 바뀐다는 공지',
      '인사 발령 공지 보여줘',
      '강아지 분양 공지 있어?',
      '화성 이주 공지',
    ];
    const cards: Card[] = [];
    for (const q of questions) {
      cards.push(...(await ask(t, me, q)).cards);
      cards.push(...(await ask(t, me, q, 'navi')).cards);
      cards.push(...(await ask(t, me, q, 'notices')).cards);
    }
    const rows = new Map((await chartRows(t)).map((r) => [r.id as string, r]));
    // 내 남은 연차 카드(ADR-18)는 분장표 행이 아니라 인사 근태 기록이 근거예요.
    const leaveCards = cards.filter((c) => c.id === 'navi-my-leave');
    expect(leaveCards.length).toBeGreaterThan(0);
    for (const c of leaveCards) expect(c.evidence.text).toMatch(/^인사 근태 기록/);
    // 다른 기능으로 옮기는 카드(move-, 10/28)는 답 카드가 아니라 빼요.
    const naviCards = cards.filter(
      (c) => c.kind === 'navi' && !c.id.startsWith('move-') && !['navi-ask-here', 'navi-my-leave', 'navi-choose-row'].includes(c.id),
    );
    const noticeCards = cards.filter((c) => c.kind === 'notices' && !c.id.startsWith('move-') && c.id !== 'notices-not-found');
    expect(naviCards.length).toBeGreaterThan(5);
    expect(noticeCards.length).toBeGreaterThan(2);
    expect(cards.some((c) => c.id === 'navi-ask-here')).toBe(true);
    expect(cards.some((c) => c.id === 'notices-not-found')).toBe(true);

    for (const c of naviCards) {
      const m = c.evidence.text.match(ROW_EVIDENCE);
      expect(m, c.id).not.toBeNull();
      const row = rows.get(c.id.replace(/^navi-/, ''));
      expect(row, c.id).toBeDefined();
      expect(m![1]).toBe(row!.task);
      expect(c.fields.find((f) => f.name === '지금 할 일')?.value).toBe(row!.next_step);
      expect(c.fields.find((f) => f.name === '처리 기간')?.value).toBe(row!.processing_period ?? '분장표에 없음');
    }
    for (const c of noticeCards) {
      expect(c.evidence.href, c.id).toMatch(/^https:\/\/groupware\.example\.com\/board\/notice\/\d+$/);
      expect(c.actions.primary).toMatchObject({ type: 'link', text: '원문 열기', href: c.evidence.href });
      expect(c.fields.map((f) => f.name)).toEqual(['제목', '게시일']);
      expect(c.evidence.aiSummarized).toBe(false);
    }
    const all = JSON.stringify(cards);
    for (const name of FIXTURE_NAMES) expect(all).not.toContain(name);
    expect(all).not.toContain('본문카나리');
    expect(all).not.toContain('가상 인물');
  });

  it('[F1 완료 기준·ADR-10] 묻기 감사 로그에 분장표 행 ID·공지 ID가 없어요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    await ask(t, me, '법인카드 잃어버렸어요');
    await ask(t, me, '건강검진 공지 언제였지');
    const { rows } = await t.db.query('select * from audit_log');
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/FIN-01|N-1002|[A-Z]{2,5}-\d{2,3}/);
  });

  it('[R6] 무보관 계약 전에는 질문을 AI로 보내지 않고 결정적으로 골라요("AI 정리" 없음)', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const card = (await ask(t, me, '법인카드 잃어버렸어요')).cards[0]!;
    expect(card.evidence.aiSummarized).toBe(false);
    const { rows } = await t.db.query("select * from ai_usage where module = 'navi'");
    expect(rows).toEqual([]);
  });

  it('[F1 완료 기준·ADR-10] 담당·공지 질문과 틀렸어요를 거쳐도 질문 카나리가 DB에 0건이에요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const canary = '질문카나리ZK41';
    const navi = await ask(t, me, `법인카드 잃어버렸어요 ${canary}`);
    await ask(t, me, `건강검진 공지 언제였지 ${canary}`);
    await ask(t, me, `${canary} 어디서 해요`);
    const card = navi.cards[0]!;
    await me.call('POST', '/api/navi/feedback', {
      predictedKind: 'navi',
      predictedRowId: card.wrong!.predictedRowId,
      correctedKind: 'notices',
      reason: 'wrong-kind',
    });
    expect(await dumpDb(t)).not.toContain(canary);
  });
});

describe('잘못 고른 기능 페이지(10/28 사용성 점검)', () => {
  it('담당 찾기·공지에서 못 찾았는데 다른 기능 문장이면 그 페이지로 옮기는 카드를 맨 앞에 줘요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const rooms = await ask(t, me, '내일 3시 회의실 6명', 'navi');
    expect(rooms.cards[0]).toMatchObject({
      id: 'move-rooms',
      kind: 'rooms',
      label: '안내',
      headline: '회의실 일 같아요',
      actions: { primary: { type: 'reask', kind: 'rooms', text: '회의실에서 찾기' } },
    });
    // 총무 창구 안내는 그 뒤에 그대로 있어요(규칙이 틀릴 수도 있어서요).
    expect(rooms.cards.map((c) => c.id)).toContain('navi-ask-here');

    const pantry = await ask(t, me, '탕비실에 제로콜라 떨어졌어요', 'navi');
    expect(pantry.cards[0]).toMatchObject({ id: 'move-pantry', actions: { primary: { type: 'reask', kind: 'pantry', text: '같이 채워요에 올리기' } } });

    // 공지 못 찾음 카드가 이미 [담당 찾기에서 찾기]를 주면 같은 버튼을 또 만들지 않아요.
    const fromNotices = await ask(t, me, '내일 3시 회의실 6명', 'notices');
    expect(fromNotices.cards.map((c) => c.id)).toEqual(['move-rooms', 'notices-not-found']);

    // 찾았으면 옮기기 카드가 없어요.
    const found = await ask(t, me, '법인카드 잃어버렸어요', 'navi');
    expect(found.cards.some((c) => c.id.startsWith('move-'))).toBe(false);
  });
});

describe('[ADR-09] LLM은 후보 번호 하나나 none만 골라요', () => {
  function recorder(answer: (req: StructuredRequest<unknown>) => unknown) {
    const seen: StructuredRequest<unknown>[] = [];
    // 실제 모델 흉내예요. 이름이 fake면 게이트웨이가 "AI 정리"를 붙이지 않아요(modelBacked).
    const provider: LlmProvider = {
      name: 'anthropic',
      async complete<T>(req: StructuredRequest<T>) {
        seen.push(req as StructuredRequest<unknown>);
        return { output: req.schema.parse(answer(req as StructuredRequest<unknown>)), inputTokens: 1, outputTokens: 1 };
      },
    };
    return { provider, seen };
  }

  it('계약 확인 뒤에는 후보 행만 보내고, 스키마에는 번호만 있어요(행 ID·사람 이름 없음)', async () => {
    const t = await setup();
    const rows = parseChart(demoChartCsv()).map((r) => ({ ...r, revisedOn: r.revisedOn! }));
    const candidates = rankRows('휴가 신청 어디서 해요', rows);
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.length).toBeLessThanOrEqual(4);

    const { provider, seen } = recorder(() => ({ choice: '2' }));
    const pick = await pickRow(new AiGateway(provider, true, t.db), '휴가 신청 어디서 해요', candidates);
    expect(pick).toEqual({ index: 1, ai: true });
    const req = seen[0]!;
    expect(req).toMatchObject({ module: 'navi', purpose: 'pick-row', grade: 1 });
    const schemaJson = JSON.stringify(z.toJSONSchema(req.schema));
    expect(schemaJson).not.toMatch(/[A-Z]{2,5}-\d{2}/);
    expect(schemaJson).toContain('none');
    for (const name of FIXTURE_NAMES) expect(req.input).not.toContain(name);
    for (const c of candidates) expect(req.input).toContain(c.row.task);
  });

  it('후보 밖 값을 돌려주면 받지 않고 결정적으로 골라요', async () => {
    const t = await setup();
    const rows = parseChart(demoChartCsv()).map((r) => ({ ...r, revisedOn: r.revisedOn! }));
    const candidates = rankRows('법인카드 잃어버렸어요', rows);
    const { provider } = recorder(() => ({ choice: 'FIN-99' }));
    const pick = await pickRow(new AiGateway(provider, true, t.db), '법인카드 잃어버렸어요', candidates);
    expect(pick).toEqual({ index: 0, ai: false });
  });

  it('none을 고르면 담당 카드를 만들지 않아요', async () => {
    const t = await setup();
    const rows = parseChart(demoChartCsv()).map((r) => ({ ...r, revisedOn: r.revisedOn! }));
    const candidates = rankRows('법인카드 잃어버렸어요', rows);
    const { provider } = recorder(() => ({ choice: 'none' }));
    expect(await pickRow(new AiGateway(provider, true, t.db), '법인카드 잃어버렸어요', candidates)).toEqual({ index: null, ai: true });
  });
});

describe('[F1-8·R8] 틀렸어요 기록', () => {
  it('[F1 완료 기준] 기록은 여섯 칸뿐이고 사용자 ID·가명 ID가 없어요. 감사 로그도 남기지 않아요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const card = (await ask(t, me, '법인카드 잃어버렸어요')).cards[0]!;
    const auditBefore = (await t.db.query('select count(*)::int as n from audit_log')).rows[0];

    const res = await me.call('POST', '/api/navi/feedback', { predictedKind: 'navi', predictedRowId: card.wrong!.predictedRowId, reason: 'content-changed' });
    expect(res).toEqual({ status: 200, body: { saved: true } });

    const { rows } = await t.db.query('select * from navi_feedback');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(['at', 'chosen_row', 'corrected_kind', 'id', 'predicted_kind', 'predicted_row', 'reason_code']);
    const json = JSON.stringify(rows);
    expect(json).not.toContain(pseudonymize(t.ctx.config.pseudonymSecret, MOCK.dev));
    expect(json).not.toContain(MOCK.dev);
    expect(json).not.toContain('도윤');
    // 시각은 날 단위(한국 시간 0시)예요.
    expect(new Date(rows[0]!.at as string).toISOString()).toBe(new Date('2026-10-26T00:00:00+09:00').toISOString());
    expect((await t.db.query('select count(*)::int as n from audit_log')).rows[0]).toEqual(auditBefore);
  });

  it('[ADR-09 시험] 정해진 칸 말고 다른 칸(자유 문장)이 오면 거부해요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    for (const extra of [{ comment: '이거 틀렸어요' }, { pseudonymId: 'p_x' }, { question: '법인카드 잃어버렸어요' }]) {
      const res = await me.call('POST', '/api/navi/feedback', { predictedKind: 'navi', predictedRowId: 'FIN-01', reason: 'not-listed', ...extra });
      expect(res.status).toBe(400);
    }
    expect((await t.db.query('select * from navi_feedback')).rows).toEqual([]);
  });

  it('칸 조합이 이유와 맞지 않거나 없는 행이면 거부해요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const bad = [
      { predictedKind: 'navi', predictedRowId: 'FIN-01', reason: 'other-owner' },
      { predictedKind: 'navi', predictedRowId: 'FIN-01', chosenRowId: 'FIN-01', reason: 'other-owner' },
      { predictedKind: 'navi', predictedRowId: 'FIN-01', reason: 'wrong-kind' },
      { predictedKind: 'navi', predictedRowId: 'FIN-01', correctedKind: 'navi', reason: 'wrong-kind' },
      { predictedKind: 'navi', predictedRowId: 'FIN-77', reason: 'not-listed' },
      { predictedKind: 'navi', predictedRowId: 'FIN-01', chosenRowId: 'HR-99', reason: 'other-owner' },
      { predictedKind: 'notices', reason: 'not-listed' },
      { predictedKind: 'navi', predictedRowId: 'drop table', reason: 'not-listed' },
    ];
    for (const body of bad) expect((await me.call('POST', '/api/navi/feedback', body)).status, JSON.stringify(body)).toBe(400);
    expect((await t.db.query('select * from navi_feedback')).rows).toEqual([]);
  });

  it('[F1-8] [다른 담당이에요]에서 고른 행은 그 행의 담당 카드로 바뀌어요(읽기만)', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const card = (await ask(t, me, '휴가 신청 어디서 해요')).cards[0]!;
    const other = card.wrong!.candidates[0]!;
    expect(other).toBeDefined();
    const before = await chartRows(t);
    const auditBefore = (await t.db.query('select count(*)::int as n from audit_log')).rows[0];

    expect(
      (
        await me.call('POST', '/api/navi/feedback', {
          predictedKind: 'navi',
          predictedRowId: card.wrong!.predictedRowId,
          chosenRowId: other.id,
          reason: 'other-owner',
        })
      ).status,
    ).toBe(200);
    const res = await me.call('POST', '/api/navi/rows/card', { rowId: other.id });
    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({ id: `navi-${other.id}`, kind: 'navi', label: '안내', evidence: { aiSummarized: false } });
    expect(res.body.card.wrong).toBeUndefined();
    expect(await chartRows(t)).toEqual(before);
    // 기록·행 카드 모두 감사 로그를 남기지 않아요(누가 어떤 행을 골랐나가 남지 않게).
    expect((await t.db.query('select count(*)::int as n from audit_log')).rows[0]).toEqual(auditBefore);

    expect((await me.call('POST', '/api/navi/rows/card', { rowId: 'ZZ-99' })).status).toBe(404);
  });

  it('[F1 완료 기준·R9] 기록이 쌓여도 주인이 파일을 다시 올리기 전에는 분장표·안내가 그대로예요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const before = await chartRows(t);
    const cardBefore = (await ask(t, me, '법인카드 잃어버렸어요')).cards[0];
    for (const reason of ['not-listed', 'content-changed', 'content-changed'] as const) {
      expect((await me.call('POST', '/api/navi/feedback', { predictedKind: 'navi', predictedRowId: 'FIN-01', reason })).status).toBe(200);
    }
    expect(
      (await me.call('POST', '/api/navi/feedback', { predictedKind: 'navi', predictedRowId: 'FIN-01', chosenRowId: 'GA-01', reason: 'other-owner' })).status,
    ).toBe(200);
    expect(
      (await me.call('POST', '/api/navi/feedback', { predictedKind: 'navi', predictedRowId: 'FIN-01', correctedKind: 'notices', reason: 'wrong-kind' })).status,
    ).toBe(200);
    expect(await chartRows(t)).toEqual(before);
    expect((await ask(t, me, '법인카드 잃어버렸어요')).cards[0]).toEqual(cardBefore);
  });

  it('[ADR-13] 피드백도 요청 횟수 제한을 받아요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1)
      statuses.push((await me.call('POST', '/api/navi/feedback', { predictedKind: 'navi', predictedRowId: 'FIN-01', reason: 'not-listed' })).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('[F1-9·R9] S5 분장표 수정 제안함', () => {
  it('[R17] 분장표에 행을 가진 부서만 분장표 주인이에요', async () => {
    const t = await setup();
    expect((await t.loginAs(MOCK.staff)).me.roles).toContain('chart-owner');
    expect((await t.loginAs(MOCK.operator)).me.roles).toContain('chart-owner');
    expect((await t.loginAs(MOCK.dev)).me.roles).not.toContain('chart-owner');
  });

  it('[F1-9] 자기 부서 행과 이유 넷별 기록 묶음을 보여 줘요(기록이 쌓인 행 먼저, 누가 눌렀는지 없음)', async () => {
    const t = await setup();
    const dev = await t.loginAs(MOCK.dev);
    const fb = (body: Record<string, unknown>) => dev.call('POST', '/api/navi/feedback', { predictedKind: 'navi', ...body });
    await fb({ predictedRowId: 'FIN-03', reason: 'not-listed' });
    await fb({ predictedRowId: 'FIN-03', reason: 'not-listed' });
    await fb({ predictedRowId: 'FIN-03', chosenRowId: 'HR-06', reason: 'other-owner' });
    await fb({ predictedRowId: 'FIN-03', correctedKind: 'notices', reason: 'wrong-kind' });
    await fb({ predictedRowId: 'HR-02', reason: 'content-changed' });

    const staff = await t.loginAs(MOCK.staff);
    const res = await staff.call('GET', '/api/navi/chart');
    expect(res.status).toBe(200);
    expect(res.body.department).toBe('재무팀');
    expect(res.body.rows.every((r: { id: string }) => r.id.startsWith('FIN-'))).toBe(true);
    expect(res.body.rows[0]).toMatchObject({
      id: 'FIN-03',
      feedback: { 'other-owner': 1, 'not-listed': 2, 'content-changed': 0, 'wrong-kind': 1 },
      total: 4,
    });
    expect(res.body.rows.slice(1).every((r: { total: number }) => r.total === 0)).toBe(true);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(pseudonymize(t.ctx.config.pseudonymSecret, MOCK.dev));
    expect(json).not.toContain('HR-02');
    for (const name of FIXTURE_NAMES) expect(json).not.toContain(name);
  });

  it('[F1 완료 기준] 분장표 주인이 아닌 사람의 S5·미리보기·반영은 거부돼요', async () => {
    const t = await setup();
    const dev = await t.loginAs(MOCK.dev);
    const before = await chartRows(t);
    expect((await dev.call('GET', '/api/navi/chart')).status).toBe(403);
    expect((await dev.call('GET', '/api/navi/chart/export')).status).toBe(403);
    expect((await dev.call('POST', '/api/navi/chart/preview', { csv: demoChartCsv() })).status).toBe(403);
    expect((await dev.call('POST', '/api/navi/chart/apply', { csv: demoChartCsv(), baseVersion: '0'.repeat(24) })).status).toBe(403);
    expect(await chartRows(t)).toEqual(before);
  });

  it('[F1 완료 기준·R9] 다른 부서 행을 바꾸거나 더하거나 옮긴 파일은 거부돼요', async () => {
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const before = await chartRows(t);
    const base = (await staff.call('POST', '/api/navi/chart/preview', { csv: demoChartCsv() })).body as ChartPreviewResponse;
    expect(base.changes).toEqual([]);

    const whole = parseChart(demoChartCsv());
    const edits = [
      whole.map((r) => (r.id === 'HR-02' ? { ...r, nextStep: '다른 부서가 바꿈' } : r)),
      whole.map((r) => (r.id === 'FIN-01' ? { ...r, ownerDepartment: '인사팀' } : r)),
      [...whole, { ...whole[0]!, id: 'HR-77', ownerDepartment: '인사팀' }],
    ];
    for (const rows of edits) {
      const csv = toCsv(rows);
      const preview = await staff.call('POST', '/api/navi/chart/preview', { csv });
      expect(preview).toMatchObject({ status: 422, body: { error: 'other-department', message: '다른 부서 행은 바뀌지 않아요' } });
      const apply = await staff.call('POST', '/api/navi/chart/apply', { csv, baseVersion: base.baseVersion });
      expect(apply.status).toBe(422);
    }
    expect(await chartRows(t)).toEqual(before);
    const { rows } = await t.db.query("select * from audit_log where channel = 'write'");
    expect(rows).toEqual([]);
  });

  it('[F1-9] 읽을 수 없는 파일은 "분장표 양식으로 올려 주세요"예요', async () => {
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    for (const csv of ['그냥 메모예요', '행 ID,업무\nFIN-01,a']) {
      expect(await staff.call('POST', '/api/navi/chart/preview', { csv })).toMatchObject({ status: 422, body: { message: '분장표 양식으로 올려 주세요' } });
    }
  });

  it('[F1-9·R9] 파일 다시 올리기: 미리보기는 바꾸지 않고, 반영하면 자기 부서 행만 바뀌고 개정일이 올라가요', async () => {
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const before = await chartRows(t);
    const exported = (await staff.call('GET', '/api/navi/chart/export')).body as { filename: string; csv: string };
    expect(exported.filename).toBe('분장표-재무팀-2026-10-26.csv');
    const mine = parseChart(exported.csv);
    expect(mine.every((r) => r.ownerDepartment === '재무팀')).toBe(true);

    const edited = mine.map((r) =>
      r.id === 'FIN-04'
        ? { ...r, processingPeriod: '3영업일' }
        : r.id === 'FIN-01'
          ? { ...r, aliases: [...r.aliases, '카드 도난'], nextStep: '카드사에 먼저 정지를 요청하고 재무팀 채널에 알려 주세요.' }
          : r,
    );
    const csv = toCsv([...edited, { ...edited[0]!, id: 'FIN-06', task: '법인 계좌 이체 확인', aliases: ['계좌 이체'] }]);
    const preview = await staff.call('POST', '/api/navi/chart/preview', { csv });
    expect(preview.status).toBe(200);
    const body = preview.body as ChartPreviewResponse;
    expect(body.changes.map((c) => [c.rowId, c.type])).toEqual([
      ['FIN-01', 'changed'],
      ['FIN-04', 'changed'],
      ['FIN-06', 'added'],
    ]);
    expect(body.changes[1]!.fields).toEqual([{ name: '처리 기간', before: '', after: '3영업일' }]);
    expect(body.unchanged).toBe(3);
    expect(await chartRows(t)).toEqual(before);

    const applied = await staff.call('POST', '/api/navi/chart/apply', { csv, baseVersion: body.baseVersion });
    expect(applied).toEqual({ status: 200, body: { applied: 3, revisedOn: '2026-10-26', message: '반영했어요. 개정일이 올라갔어요.' } });
    // 같은 요청이 다시 와도(버튼 연타) 한 번만 반영돼요.
    expect((await staff.call('POST', '/api/navi/chart/apply', { csv, baseVersion: body.baseVersion })).body).toEqual(applied.body);

    const after = new Map((await chartRows(t)).map((r) => [r.id as string, r]));
    expect(after.get('FIN-04')).toMatchObject({ processing_period: '3영업일' });
    expect(after.get('FIN-06')).toMatchObject({ owner_department: '재무팀' });
    for (const r of before) if (!(r.id as string).startsWith('FIN-')) expect(after.get(r.id as string)).toEqual(r);

    const dev = await t.loginAs(MOCK.dev);
    const card = (await ask(t, dev, '세금계산서 발행은 어디서 해요?', 'navi')).cards[0]!;
    expect(card.fields.find((f) => f.name === '처리 기간')?.value).toBe('3영업일');
    expect(card.evidence.text).toBe('분장표 "세금계산서 발행 요청" 행 · 개정일 2026-10-26');

    const { rows } = await t.db.query("select channel, module, action, result from audit_log where channel = 'write'");
    expect(rows).toEqual([{ channel: 'write', module: 'navi', action: 'chart-apply', result: 'done' }]);
  });

  it('미리보기 뒤에 우리 부서 행이 바뀌었으면 반영하지 않아요', async () => {
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const mine = parseChart(((await staff.call('GET', '/api/navi/chart/export')).body as { csv: string }).csv);
    const a = toCsv(mine.map((r) => (r.id === 'FIN-02' ? { ...r, processingPeriod: '5영업일' } : r)));
    const b = toCsv(mine.map((r) => (r.id === 'FIN-03' ? { ...r, processingPeriod: '매월 20일' } : r)));
    const va = ((await staff.call('POST', '/api/navi/chart/preview', { csv: a })).body as ChartPreviewResponse).baseVersion;
    const vb = ((await staff.call('POST', '/api/navi/chart/preview', { csv: b })).body as ChartPreviewResponse).baseVersion;
    expect((await staff.call('POST', '/api/navi/chart/apply', { csv: a, baseVersion: va })).status).toBe(200);
    expect(await staff.call('POST', '/api/navi/chart/apply', { csv: b, baseVersion: vb })).toMatchObject({ status: 409 });
    const { rows } = await t.db.query<{ processing_period: string }>("select processing_period from navi_rows where id = 'FIN-03'");
    expect(rows[0]!.processing_period).toBe('매월 25일 일괄 지급');
  });

  it('[F1 완료 기준·D9] 사람 이름 칸이 든 분장표를 가져와도 그 이름이 DB·응답에 0건이에요', async () => {
    const t = await setup();
    const staff = await t.loginAs(MOCK.staff);
    const marker = '홍길동시험이름QZ';
    const header = '행 ID,업무,다른 말,담당 팀,창구,창구 링크,지금 할 일,처리 기간,개정일,주인 부서,담당자 이름';
    const csv = `${header}\nFIN-08,외화 송금 요청,해외 송금|외화,재무팀,재무팀 대표 메일 finance@corp.example,,송금 요청서를 올려 주세요.,,2026-10-01,재무팀,${marker}\n`;
    const responses: unknown[] = [];
    const preview = await staff.call('POST', '/api/navi/chart/preview', { csv });
    responses.push(preview.body);
    responses.push((await staff.call('POST', '/api/navi/chart/apply', { csv, baseVersion: (preview.body as ChartPreviewResponse).baseVersion })).body);
    responses.push((await staff.call('GET', '/api/navi/chart')).body);
    responses.push((await staff.call('GET', '/api/navi/chart/export')).body);
    const dev = await t.loginAs(MOCK.dev);
    const asked = await ask(t, dev, '외화 송금은 어디서 해요', 'navi');
    expect(asked.cards[0]!.id).toBe('navi-FIN-08');
    responses.push(asked);
    responses.push((await dev.call('POST', '/api/navi/rows/card', { rowId: 'FIN-08' })).body);

    const db = await dumpDb(t);
    for (const name of [marker, ...FIXTURE_NAMES]) {
      expect(db).not.toContain(name);
      expect(JSON.stringify(responses)).not.toContain(name);
    }
  });

  it('가상 자료는 비어 있을 때 한 번만 들어가요', async () => {
    const t = await setup();
    for (const m of t.modules) if (m.kind === 'navi' || m.kind === 'notices') await m.seed?.();
    expect((await t.db.query('select count(*)::int as n from navi_rows')).rows[0]).toEqual({ n: 25 });
  });
});

describe('동점·두루 쓰이는 말(AI 접목 회의 QA 2차)', () => {
  it('1등이 동점이면 고르지 않고, 업무 칩을 눌러 사람이 고른 담당 카드를 받아요', async () => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    const [card] = (await ask(t, me, '법카 잃어버렸어요', 'navi')).cards;
    expect(card).toMatchObject({ id: 'navi-choose-row', kind: 'navi', label: '안내', headline: '어느 업무인지 골라 주세요' });
    const chips = card!.actions.secondary.filter((a) => a.type === 'fixed');
    expect(chips.map((a) => a.text)).toEqual(['법인카드 분실 신고 · 재무팀', '출입카드 분실·재발급 · 총무팀']);
    expect(card!.actions.secondary.at(-1)).toMatchObject({ type: 'inquire', team: '총무팀' });

    const chip = chips[0] as Extract<(typeof chips)[number], { type: 'fixed' }>;
    const res = await me.call(chip.method, chip.path, chip.body);
    expect(res.body).toMatchObject({ status: 'done', card: { id: 'navi-FIN-01', evidence: { aiSummarized: false } } });
  });

  it.each([
    ['대출 서류 어디서 떼요', 'navi-ask-here'],
    ['메일 용량이 꽉 찼어요', 'navi-ask-here'],
    ['출장 숙소 예약은 누가 해요', 'navi-ask-here'],
    ['수상한 메일 열어봤어요', 'navi-SEC-01'],
    ['출장비 정산 어디서 해요', 'navi-FIN-03'],
    ['연말정산 서류 언제 내요', 'navi-FIN-05'],
  ])('두루 쓰이는 말만 맞으면 담당 카드를 만들지 않아요: %s → %s', async (text, id) => {
    const t = await setup();
    const me = await t.loginAs(MOCK.dev);
    expect((await ask(t, me, text, 'navi')).cards[0]!.id).toBe(id);
  });
});
