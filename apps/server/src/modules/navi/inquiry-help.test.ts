import {
  INQUIRY_REPLY_MAX,
  type InquiryItem,
  type InquiryListResponse,
  type ItHelpResponse,
  inquiryFaqReply,
  itInquiryDraft,
  type NaviRowCardResponse,
} from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { parseChart } from './chart-csv';
import { demoChartCsv, demoItFaqs } from './fixtures';
import { suggestFaqForInquiry } from './it-help';

// 후보 8(문의 양식에 "지금 할 일" 원문)·후보 15(받은 IT 문의에 맞는 FAQ, 규칙판), 11/17. 모델을 부르지 않아요.
// 가상 직원: 도윤(개발팀)이 보내고, 하린(IT지원팀 — IT FAQ 주인 부서)·지후(인사팀)가 받아요. 자료는 모두 가상이에요(등급 0).

const HARIN = 'mock|emp-016';
const CANARY = 'FAQHINTCANARY5';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type Session = Awaited<ReturnType<TestApp['loginAs']>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 1000 });
  await t.modules.find((m) => m.kind === 'navi')!.seed!();
  return t;
}

let n = 0;
const requestId = () => `req-${Date.now().toString(36)}-${(n += 1)}`;
const send = async (me: Session, rowId: string | null, question: string) => {
  const res = await me.call('POST', '/api/navi/inquiries', { rowId, question, reason: '업무에 필요해요', requestId: requestId() });
  expect(res.status, question).toBe(200);
};
const inbox = async (me: Session) => ((await me.call('GET', '/api/navi/inquiries/inbox')).body as InquiryListResponse).items;
const byQuestion = (items: InquiryItem[], q: string) => items.find((i) => i.question.startsWith(q))!;

describe('후보 8: 문의 양식에 받는 곳 행의 "지금 할 일" 원문', () => {
  it('[후보 8][ADR-09] 행 카드 읽기 응답에 그 행 "지금 할 일" 칸이 고치지 않은 원문으로 오고, 사람 이름 칸은 없어요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const rows = parseChart(demoChartCsv());
    for (const id of ['FIN-01', 'IT-06']) {
      const res = await doyun.call('POST', '/api/navi/rows/card', { rowId: id });
      expect(res.status).toBe(200);
      const body = res.body as NaviRowCardResponse;
      expect(body.nextStep).toBe(rows.find((r) => r.id === id)!.nextStep);
      expect(body.card.fields.find((f) => f.name === '지금 할 일')?.value).toBe(body.nextStep);
      // 가상 분장표의 "담당자 이름" 칸(가상 담당 …)은 읽지도 않아서 응답에 없어요(D9).
      expect(JSON.stringify(body)).not.toContain('가상 담당');
    }
    expect((await doyun.call('POST', '/api/navi/rows/card', { rowId: 'FIN-01' })).body.nextStep).toContain('카드 끝 네 자리와 분실 날짜를 보내 주세요');
    // 읽기만이에요: 새 저장·감사·AI 호출이 없어요.
    expect((await t.db.query('select * from ai_usage')).rows).toHaveLength(0);
    expect((await t.db.query("select * from audit_log where channel = 'write'")).rows).toHaveLength(0);
    expect((await t.db.query('select * from navi_inquiries')).rows).toHaveLength(0);
  });
});

describe('후보 15: 받은 IT 문의에 맞는 FAQ(규칙판)', () => {
  it('[후보 15] 규칙 문턱: 오류 코드가 맞거나 낱말 점수가 충분할 때만 골라요. 약하게 맞은 것·이미 해 본 FAQ는 고르지 않아요', () => {
    const faqs = demoItFaqs();
    expect(suggestFaqForInquiry('와이파이 인증에 실패했다고 떠요', faqs)?.id).toBe('ITF-04');
    expect(suggestFaqForInquiry('VPN 접속하면 오류 809가 떠요', faqs)?.id).toBe('ITF-03');
    expect(suggestFaqForInquiry('설치하다가 0x80070005 떠요', faqs)?.id).toBe('ITF-01');
    // 낱말 하나만 걸린 약한 맞음(1점)은 보여 주지 않아요.
    for (const weak of ['인터넷이 느려요', '메일 용량 늘려 주세요', '로그인 오류가 나요', '재직증명서 필요해요'])
      expect(suggestFaqForInquiry(weak, faqs), weak).toBeNull();
    // IT 오류 화면에서 온 문의는 이미 해 본 FAQ를 다시 권하지 않아요.
    const tried = itInquiryDraft({ maskedText: '와이파이 인증에 실패했습니다', faqTitle: faqs.find((f) => f.id === 'ITF-04')!.title });
    expect(suggestFaqForInquiry(tried, faqs)?.id).not.toBe('ITF-04');
  });

  it('[후보 15] IT FAQ 주인 부서 받은 문의함에만 "맞아 보이는 FAQ"가 붙고, 문턱 아래·다른 부서(인사팀)에는 없어요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    await send(doyun, 'IT-04', `와이파이 인증에 실패했다고 떠요 ${CANARY}`);
    await send(doyun, 'IT-05', 'VPN 접속하면 오류 809가 떠요');
    await send(doyun, 'IT-04', '인터넷이 느려요. 확인 부탁드려요');
    await send(doyun, 'HR-01', '와이파이 인증에 실패했다고 떠요. 재직증명서는 어떻게 떼요?');

    const harin = await t.loginAs(HARIN);
    const items = await inbox(harin);
    const wifi = byQuestion(items, '와이파이');
    expect(wifi.faqHint).toMatchObject({ faqId: 'ITF-04', title: "사내 와이파이 '인증에 실패했습니다'", shortened: false });
    // 답장 글은 FAQ 제목과 원문 단계를 고치지 않고 그대로예요.
    const itf04 = demoItFaqs().find((f) => f.id === 'ITF-04')!;
    expect(wifi.faqHint!.reply).toBe(inquiryFaqReply(itf04).reply);
    for (const step of itf04.steps) expect(wifi.faqHint!.reply).toContain(step);
    expect(byQuestion(items, 'VPN').faqHint?.faqId).toBe('ITF-03');
    expect(byQuestion(items, '인터넷이').faqHint).toBeUndefined();

    // 인사팀(IT FAQ 주인 부서 아님)이 받은 문의에는 글이 같아도 붙지 않아요.
    const jihu = await t.loginAs(MOCK.hr);
    const hr = await inbox(jihu);
    expect(hr).toHaveLength(1);
    expect(hr[0]!.faqHint).toBeUndefined();
    // 보낸 사람의 내 문의에도 없어요.
    expect(((await doyun.call('GET', '/api/navi/inquiries/mine')).body as InquiryListResponse).items.every((i) => !i.faqHint)).toBe(true);
  });

  it('[후보 15] 단계가 1,000자를 넘는 FAQ는 제목과 IT 오류 화면 안내만 채워요', async () => {
    const t = await setup();
    const longSteps = Array.from(
      { length: 12 },
      (_, i) =>
        `${i + 1}번째 확인: 가상 모니터 설정 화면에서 해상도·주사율·케이블 연결 상태를 차례로 보고, 바뀐 것이 없으면 다음 단계로 넘어가 주세요. 같은 증상이 이어지면 기록해 두세요.`,
    );
    expect(longSteps.join('\n').length).toBeGreaterThan(INQUIRY_REPLY_MAX);
    await t.db.query(
      "insert into navi_it_faqs (id, title, aliases, error_codes, steps, revised_on, row_id, source) values ('ITF-60', '가상 모니터 화면 깜빡임', $1, '{}', $2, '2026-10-01', 'IT-01', 'upload')",
      [['모니터 깜빡임', '화면 깜빡임'], longSteps],
    );
    const doyun = await t.loginAs(MOCK.dev);
    await send(doyun, 'IT-01', '모니터 화면 깜빡임이 계속돼요');
    const hint = byQuestion(await inbox(await t.loginAs(HARIN)), '모니터').faqHint!;
    expect(hint).toMatchObject({ faqId: 'ITF-60', title: '가상 모니터 화면 깜빡임', shortened: true });
    expect(hint.reply.length).toBeLessThanOrEqual(INQUIRY_REPLY_MAX);
    expect(hint.reply).toContain('가상 모니터 화면 깜빡임');
    expect(hint.reply).toContain('[오류 창 글로 해결 방법 찾기]');
    expect(hint.reply).not.toContain(longSteps[0]);
  });

  it('[후보 15][ADR-16 시험] 제안은 저장하지 않고 LLM 호출 0건이에요. 채운 답장은 지금 [답장 보내기] 길로 가고, 감사·접속기록에 글·FAQ가 없어요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    await send(doyun, 'IT-04', `와이파이 인증에 실패했다고 떠요 ${CANARY}`);
    const harin = await t.loginAs(HARIN);
    const before = JSON.stringify((await t.db.query('select * from navi_inquiries')).rows);
    const item = byQuestion(await inbox(harin), '와이파이');
    // 열기만으로는 문의 줄이 바뀌지 않아요(제안을 저장하지 않아요).
    expect(JSON.stringify((await t.db.query('select * from navi_inquiries')).rows)).toBe(before);

    // 담당자가 고친 뒤 [답장 보내기](고정 버튼 inquiry.reply)를 눌러요.
    const text = `${item.faqHint!.reply}\n안 되면 다시 알려 주세요.`;
    const sent = await harin.call('POST', `/api/navi/inquiries/${item.id}/reply`, { text, requestId: requestId() });
    expect(sent.status).toBe(200);
    const mine = ((await doyun.call('GET', '/api/navi/inquiries/mine')).body as InquiryListResponse).items[0]!;
    expect(mine.replies[0]!.text).toBe(text);

    expect((await t.db.query('select * from ai_usage')).rows).toHaveLength(0);
    const audit = JSON.stringify((await t.db.query('select * from audit_log')).rows);
    expect(audit).toContain('inquiry.reply');
    for (const leak of [CANARY, 'ITF-04', '와이파이', '인증에 실패']) expect(audit).not.toContain(leak);
    const access = JSON.stringify((await t.db.query('select * from access_log')).rows);
    for (const leak of [CANARY, 'ITF-04', '와이파이']) expect(access).not.toContain(leak);
  });

  it('[후보 15] 붙여넣기 IT 오류 화면(MCP도 쓰는 match)의 출력은 그대로예요', async () => {
    const t = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    const res = (await doyun.call('POST', '/api/navi/it-help', { text: 'VPN 연결 실패 오류 809' })).body as ItHelpResponse;
    expect(Object.keys(res).sort()).toEqual(['faq', 'inquiryRowId', 'inquiryTask', 'inquiryTeam', 'others']);
    expect(res.faq?.id).toBe('ITF-03');
  });
});
