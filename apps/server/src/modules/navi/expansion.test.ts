import type { InquiryStatsResponse, ItHelpResponse, OnboardingResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { parseChart, toCsv } from './chart-csv';
import { demoChartCsv } from './fixtures';
import { errorCodesIn, rankFaqs } from './it-help';

// 10/31 넓힐 후보 회의에서 이번에 만든 것:
// - 분장표 출처(demo/upload): 실제 분장표를 올렸는데도 "가상 분장표"로 보이던 구멍(MCP 모의 자료 판정까지 같이 틀렸어요)
// - ① 신규 입사자 첫 2주 할 일(분장표 "온보딩 주차" 칸, 진행 저장 없음)
// - ② IT 오류 문장 → IT FAQ 원문 단계(규칙만, 붙여 넣은 글 저장 안 함, 복사 버튼 없음)
// - ④ 받은 부서 주간 문의 셈(지울 때 세요, 10건 미만 접기, 7일 보관)

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  await t.modules.find((m) => m.kind === 'navi')!.seed!();
  return t;
}

const chartAdapter = (t: TestApp) => t.ctx.dataAdapters().find((a) => a.name === 'chart' || a.name === 'mock-chart')!;
const FIXTURE_NAMES = [...new Set([...demoChartCsv().matchAll(/가상 담당 [가-힣]+/g)].map((m) => m[0]))];
const DAY = 24 * 60 * 60 * 1000;

let n = 0;
const requestId = () => `req-${Date.now().toString(36)}-${(n += 1)}`;

describe('분장표 출처(10/31)', () => {
  it('가상 분장표만 있으면 모의이고, 분장표 주인이 반영하면 실제 분장표로 바뀌어요', async () => {
    const t = await setup();
    expect(chartAdapter(t)).toEqual({ name: 'mock-chart', label: '업무 분장표(가상 분장표)', mock: true });

    const staff = await t.loginAs(MOCK.staff);
    const rows = parseChart(demoChartCsv()).map((r) => (r.id === 'FIN-04' ? { ...r, processingPeriod: '3영업일' } : r));
    const csv = toCsv(rows);
    const preview = await staff.call('POST', '/api/navi/chart/preview', { csv });
    expect((await staff.call('POST', '/api/navi/chart/apply', { csv, baseVersion: preview.body.baseVersion })).status).toBe(200);
    expect(chartAdapter(t)).toEqual({ name: 'chart', label: '업무 분장표', mock: false });
    const { rows: sources } = await t.db.query<{ id: string; source: string }>("select id, source from navi_rows where source = 'upload'");
    expect(sources).toEqual([{ id: 'FIN-04', source: 'upload' }]);
  });

  it('출처를 모르는 행(마이그레이션 기본값)은 실제 자료로 보고, seed가 가상 분장표와 같은 행만 되돌려요', async () => {
    const t = await setup();
    await t.db.query("update navi_rows set source = 'upload'");
    await t.db.query("update navi_rows set next_step = '회사가 고친 안내' where id = 'GA-02'");
    await t.modules.find((m) => m.kind === 'navi')!.init!();
    expect(chartAdapter(t).mock).toBe(false);

    await t.modules.find((m) => m.kind === 'navi')!.seed!();
    const { rows } = await t.db.query<{ id: string }>("select id from navi_rows where source = 'upload'");
    expect(rows).toEqual([{ id: 'GA-02' }]);
    expect(chartAdapter(t).mock).toBe(false);
  });
});

describe('① 신규 입사자 첫 2주 할 일', () => {
  it('누구나 1·2주차 목록을 읽고, 사람 이름은 없어요', async () => {
    const t = await setup();
    const dev = await t.loginAs(MOCK.dev);
    const res = await dev.call('GET', '/api/navi/onboarding');
    expect(res.status).toBe(200);
    const body = res.body as OnboardingResponse;
    expect(body.weeks.map((w) => w.week)).toEqual([1, 2]);
    expect(body.weeks[0]!.items.map((i) => i.rowId)).toEqual(['GA-01', 'GA-02', 'GA-05', 'HR-03', 'IT-02', 'IT-04']);
    expect(body.weeks[0]!.items[0]).toMatchObject({ task: '출입카드 분실·재발급', team: '총무팀' });
    const json = JSON.stringify(body);
    for (const name of FIXTURE_NAMES) expect(json).not.toContain(name);
    // 진행(누가 무엇을 했는지)을 담는 표는 없어요.
    const { rows } = await t.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_name like '%onboarding%'");
    expect(rows).toEqual([]);
  });

  it('"온보딩 주차" 칸은 비우거나 1·2(1주차·2주차)만 받아요', () => {
    const head = '행 ID,업무,담당 팀,창구,지금 할 일,주인 부서,온보딩 주차';
    const parse = (week: string) => parseChart(`${head}\nFIN-09,시험,재무팀,창구,할 일,재무팀,${week}`)[0]!.onboardingWeek;
    expect(parse('')).toBeNull();
    expect(parse('1')).toBe(1);
    expect(parse('2주차')).toBe(2);
    for (const bad of ['3', '첫 주', '0']) expect(() => parse(bad)).toThrow('분장표 양식으로 올려 주세요');
    // 칸이 없는 옛 양식도 그대로 읽어요.
    expect(parseChart('행 ID,업무,담당 팀,창구,지금 할 일,주인 부서\nFIN-09,시험,재무팀,창구,할 일,재무팀')[0]!.onboardingWeek).toBeNull();
  });
});

describe('② IT 오류 문장 → IT FAQ', () => {
  it('오류 코드를 뽑아요(16진수·이름 붙은 코드·"오류" 근처 숫자)', () => {
    expect([...errorCodesIn('0x80070005 접근 거부 AADSTS50126 오류 809')].sort()).toEqual(['0x80070005', '809', 'aadsts50126']);
    expect([...errorCodesIn('3층 회의실 2026년')]).toEqual([]);
  });

  it('오류 코드가 맞는 FAQ를 원문 단계 그대로 주고, 붙여 넣은 글은 응답·DB에 남지 않아요', async () => {
    const t = await setup();
    const dev = await t.loginAs(MOCK.dev);
    const text = 'ITHELPCANARY 업데이트 설치 실패 0x80070005 (C:\\Users\\doyun\\AppData\\Local\\Temp)';
    const res = await dev.call('POST', '/api/navi/it-help', { text });
    expect(res.status).toBe(200);
    const body = res.body as ItHelpResponse;
    expect(body.faq).toMatchObject({ id: 'ITF-01', revisedOn: '2026-10-20' });
    expect(body.faq!.steps[0]).toBe('작업 중인 파일을 저장하고 PC를 다시 시작해 주세요.');
    expect(body).toMatchObject({ inquiryRowId: 'IT-03', inquiryTeam: 'IT지원팀' });
    // 코드 조각·"오류" 같은 흔한 말만 겹친 FAQ는 다른 후보로 띄우지 않아요.
    expect(body.others).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('ITHELPCANARY');
    expect(JSON.stringify(body)).not.toContain('doyun');

    // DB 어디에도(감사 로그·AI 사용 기록 포함) 붙여 넣은 글이 없어요.
    const { rows: tables } = await t.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'");
    for (const { table_name } of tables) {
      const { rows } = await t.db.query(`select * from "${table_name}"`);
      expect(JSON.stringify(rows), table_name).not.toContain('ITHELPCANARY');
    }
  });

  it('코드가 없어도 제목·다른 말로 찾고, 못 찾으면 FAQ 없이 IT지원팀 문의 행만 줘요', async () => {
    const t = await setup();
    const dev = await t.loginAs(MOCK.dev);
    const vpn = (await dev.call('POST', '/api/navi/it-help', { text: 'VPN 연결 실패라고 떠요' })).body as ItHelpResponse;
    expect(vpn.faq?.id).toBe('ITF-03');
    expect(vpn.inquiryRowId).toBe('IT-05');

    const none = (await dev.call('POST', '/api/navi/it-help', { text: '점심 메뉴 추천해 주세요' })).body as ItHelpResponse;
    expect(none.faq).toBeUndefined();
    expect(none.others).toEqual([]);
    expect(none.inquiryRowId).toMatch(/^IT-0\d$/);
  });

  it('키·주민번호처럼 잠기는 글은 422이고, 다른 후보는 POST 본문의 번호로만 열어요', async () => {
    const t = await setup();
    const dev = await t.loginAs(MOCK.dev);
    expect((await dev.call('POST', '/api/navi/it-help', { text: '토큰 ghp_abcdefghijklmnopqrstuvwxyz0123456789 오류' })).status).toBe(422);
    expect((await dev.call('POST', '/api/navi/it-help', { text: 'x'.repeat(1001) })).status).toBe(400);
    const faq = await dev.call('POST', '/api/navi/it-help/faq', { id: 'ITF-05' });
    expect(faq.body).toMatchObject({ faq: { id: 'ITF-05', title: '계정이 잠겼거나 로그인이 안 돼요' }, inquiryRowId: 'IT-02' });
    expect((await dev.call('POST', '/api/navi/it-help/faq', { id: 'ITF-99' })).status).toBe(404);
    expect((await dev.call('POST', '/api/navi/it-help/faq', { id: "ITF-01' or 1=1" })).status).toBe(400);
  });

  it('동점이면 하나를 고르지 않고 제목 후보로 보여 줘요', () => {
    const faq = (id: string, title: string) => ({ id, title, aliases: [], errorCodes: [], steps: ['a'], revisedOn: '2026-10-20', rowId: null });
    const ranked = rankFaqs('프린터 오류', [faq('ITF-01', '프린터 연결'), faq('ITF-02', '프린터 용지')]);
    expect(ranked[0]!.score).toBe(ranked[1]!.score);
  });
});

describe('④ 받은 부서 주간 문의 셈', () => {
  async function sendMany(t: TestApp, count: number, done: number) {
    const dev = await t.loginAs(MOCK.dev);
    for (let i = 0; i < count; i += 1) {
      const res = await dev.call('POST', '/api/navi/inquiries', { rowId: 'HR-01', question: `STATSCANARY 문의 ${i}`, reason: '사유', requestId: requestId() });
      expect(res.status).toBe(200);
    }
    const hr = await t.loginAs(MOCK.hr);
    const inbox = (await hr.call('GET', '/api/navi/inquiries/inbox')).body.items as { id: string }[];
    for (const item of inbox.slice(0, done)) expect((await hr.call('POST', `/api/navi/inquiries/${item.id}/state`, { state: 'done' })).status).toBe(200);
    return hr;
  }

  it('지울 때 보낸 주 × 받은 부서로 세고, 다 센 주만 보여 주고, 7일 뒤 셈도 지워요', async () => {
    const t = await setup();
    let hr = await sendMany(t, 10, 2);

    // 아직 지워지지 않았으면 셈이 없어요.
    expect(((await hr.call('GET', '/api/navi/inquiry-stats')).body as InquiryStatsResponse).weeks).toEqual([]);

    // 10/26(월, W44)에 보낸 문의는 11/2에 지워지고, 그 주가 다 센 11/9부터 보여요.
    t.advance(8 * DAY);
    await t.runRetention();
    const { rows: counted } = await t.db.query('select * from navi_inquiry_weeks');
    expect(counted).toEqual([expect.objectContaining({ week: '2026-W44', department: '인사팀', sent: 10, handled: 2, expired_open: 8 })]);
    expect(Object.keys(counted[0] as object).sort()).toEqual(['department', 'expired_open', 'handled', 'sent', 'updated_at', 'week']);
    // 시계를 돌리면 쉬는 시간이 지나 세션이 끊겨서 다시 들어와요.
    hr = await t.loginAs(MOCK.hr);
    expect(((await hr.call('GET', '/api/navi/inquiry-stats')).body as InquiryStatsResponse).weeks).toEqual([]);

    t.advance(6 * DAY);
    hr = await t.loginAs(MOCK.hr);
    const stats = (await hr.call('GET', '/api/navi/inquiry-stats')).body as InquiryStatsResponse;
    expect(stats).toEqual({
      department: '인사팀',
      weeks: [{ week: '2026-W44', from: '2026-10-26', to: '2026-11-01', folded: false, sent: 10, handled: 2, expiredOpen: 8 }],
    });
    expect(JSON.stringify(stats)).not.toContain('STATSCANARY');

    // 마지막으로 더한 뒤 7일이 지나면 셈 행도 지워요.
    t.advance(2 * DAY);
    await t.runRetention();
    expect((await t.db.query('select * from navi_inquiry_weeks')).rows).toEqual([]);
  });

  it('10건이 안 되는 주는 숫자를 접어요', async () => {
    const t = await setup();
    await sendMany(t, 3, 0);
    t.advance(14 * DAY);
    const hr = await t.loginAs(MOCK.hr);
    await hr.call('GET', '/api/navi/inquiries/inbox');
    const stats = (await hr.call('GET', '/api/navi/inquiry-stats')).body as InquiryStatsResponse;
    expect(stats.weeks).toEqual([{ week: '2026-W44', from: '2026-10-26', to: '2026-11-01', folded: true }]);
  });

  it('지우기가 겹쳐도(목록 열기와 정시 지우기) 한 번만 세요', async () => {
    const t = await setup();
    await sendMany(t, 10, 0);
    t.advance(8 * DAY);
    const hr = await t.loginAs(MOCK.hr);
    await Promise.all([t.runRetention(), hr.call('GET', '/api/navi/inquiries/inbox'), hr.call('GET', '/api/navi/inquiries/inbox')]);
    const { rows } = await t.db.query<{ sent: number }>('select sent from navi_inquiry_weeks');
    expect(rows).toEqual([{ sent: 10 }]);
  });

  it('분장표 주인이 아니면 볼 수 없어요', async () => {
    const t = await setup();
    const dev = await t.loginAs(MOCK.dev);
    expect((await dev.call('GET', '/api/navi/inquiry-stats')).status).toBe(403);
  });
});
