import type { ItFaqListResponse, ItFaqPreviewResponse, ItHelpResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { demoItFaqs } from './fixtures';
import { parseItFaqFile, toItFaqCsv } from './it-faq-csv';
import type { ItFaqRow } from './repo';

// IT FAQ 파일 올리기(11/3, ADR-25 "다시 볼 조건": IT팀이 실제 FAQ를 주면 S5처럼 올리기).
// 가상 직원: 하린(IT지원팀, 분장표 주인 — IT 행을 가진 부서), 하늘(재무팀, 분장표 주인), 도윤(개발팀, 주인 아님).
// FAQ 자료는 모두 가상(등급 0)이에요.

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

const HARIN = 'mock|emp-016';
const faqAdapter = (t: TestApp) => t.ctx.dataAdapters().find((a) => a.name === 'it-faq' || a.name === 'mock-it-faq')!;
const faqRows = async (t: TestApp) => (await t.db.query('select * from navi_it_faqs order by id')).rows;

const NEW_FAQ: ItFaqRow = {
  id: 'ITF-07',
  title: '모니터 두 대 중 하나가 안 나와요',
  aliases: ['듀얼 모니터', '화면 안 나옴'],
  errorCodes: [],
  steps: ['케이블이 단단히 꽂혔는지 봐 주세요.', '윈도 키 + P를 눌러 "확장"을 골라 주세요.', '그래도 안 나오면 "IT 오류 문의"로 알려 주세요.'],
  revisedOn: '2026-10-01',
  rowId: 'IT-06',
};

describe('[IT FAQ 올리기] IT지원팀 분장표 주인이 IT FAQ 파일을 올려요(11/3)', () => {
  it('받은 파일을 그대로 올리면 바뀌는 것이 없고, 고친 단계·새 FAQ만 미리 보여 준 뒤 반영해요(원문 그대로, 출처 upload)', async () => {
    const t = await setup();
    const harin = await t.loginAs(HARIN);
    expect(harin.me.roles).toContain('chart-owner');
    expect(faqAdapter(t)).toEqual({ name: 'mock-it-faq', label: 'IT FAQ(가상 FAQ)', mock: true });

    const list = (await harin.call('GET', '/api/navi/it-faq')).body as ItFaqListResponse;
    expect(list).toMatchObject({ department: 'IT지원팀', enabled: true });
    expect(list.faqs.map((f) => f.id)).toEqual(demoItFaqs().map((f) => f.id));
    expect(list.faqs.every((f) => f.source === 'demo')).toBe(true);

    const exported = (await harin.call('GET', '/api/navi/it-faq/export')).body as { filename: string; csv: string };
    expect(exported.filename).toMatch(/^IT-FAQ-IT지원팀-2026-10-26\.csv$/);
    expect(exported.csv.split('\r\n')[0]).toBe('﻿ID,제목,다른 말,오류 코드,단계,개정일,문의 행');
    const same = (await harin.call('POST', '/api/navi/it-faq/preview', { csv: exported.csv })).body as ItFaqPreviewResponse;
    expect(same).toMatchObject({ changes: [], unchanged: demoItFaqs().length, untouched: 0 });

    // ITF-02 단계를 고치고, 새 FAQ를 더하고, 사람 이름 칸(작성자)을 붙여 올려요. 이름 칸은 버려요.
    const edited = demoItFaqs().map((f) =>
      f.id === 'ITF-02' ? { ...f, steps: [...f.steps, '새 단계: "메일 → 계정 설정"에서 계정을 지웠다 다시 넣어 주세요.'] } : f,
    );
    const withName = toItFaqCsv([...edited, NEW_FAQ])
      .split('\r\n')
      .map((line, i) => (line === '' ? line : `${line},${i === 0 ? '작성자' : '가상 작성자 누리'}`))
      .join('\r\n');
    const preview = await harin.call('POST', '/api/navi/it-faq/preview', { csv: withName });
    expect(preview.status).toBe(200);
    const body = preview.body as ItFaqPreviewResponse;
    expect(body.changes.map((c) => [c.faqId, c.type])).toEqual([
      ['ITF-02', 'changed'],
      ['ITF-07', 'added'],
    ]);
    expect(body.changes[0]!.fields.map((f) => f.name)).toEqual(['단계']);
    expect(JSON.stringify(body)).not.toContain('누리');
    // 미리보기는 DB를 바꾸지 않아요.
    expect((await faqRows(t)).every((r) => r.source === 'demo')).toBe(true);

    const applied = await harin.call('POST', '/api/navi/it-faq/apply', { csv: withName, baseVersion: body.baseVersion });
    expect(applied.body).toEqual({ applied: 2, revisedOn: '2026-10-26', message: '반영했어요. 개정일이 올라갔어요.' });

    const rows = await faqRows(t);
    const itf07 = rows.find((r) => r.id === 'ITF-07')!;
    expect(itf07).toMatchObject({ steps: NEW_FAQ.steps, row_id: 'IT-06', source: 'upload' });
    expect(rows.find((r) => r.id === 'ITF-02')).toMatchObject({ source: 'upload', steps: edited.find((f) => f.id === 'ITF-02')!.steps });
    expect(rows.find((r) => r.id === 'ITF-01')).toMatchObject({ source: 'demo' });
    expect(Object.keys(itf07).sort()).toEqual(['aliases', 'error_codes', 'id', 'revised_on', 'row_id', 'source', 'steps', 'title']);
    expect(JSON.stringify(rows)).not.toContain('누리');
    // 올린 FAQ가 하나라도 있으면 띠가 실제 IT FAQ로 바뀌어요.
    expect(faqAdapter(t)).toEqual({ name: 'it-faq', label: 'IT FAQ', mock: false });

    // 누구나 IT 오류 화면에서 새 FAQ 원문 단계를 그대로 봐요.
    const dev = await t.loginAs(MOCK.dev);
    const found = (await dev.call('POST', '/api/navi/it-help', { text: '듀얼 모니터 하나가 화면 안 나옴' })).body as ItHelpResponse;
    expect(found.faq).toEqual({ id: 'ITF-07', title: NEW_FAQ.title, steps: NEW_FAQ.steps, revisedOn: '2026-10-26' });

    // 감사 로그는 정해진 칸만(내용 없음).
    const { rows: audit } = await t.db.query("select channel, module, action, result from audit_log where action = 'it-faq-apply'");
    expect(audit).toEqual([{ channel: 'write', module: 'navi', action: 'it-faq-apply', result: 'done' }]);

    // 같은 파일·같은 바탕으로 두 번 눌러도 한 번만 반영돼요(멱등).
    const again = await harin.call('POST', '/api/navi/it-faq/apply', { csv: withName, baseVersion: body.baseVersion });
    expect(again.body).toEqual(applied.body);
  });

  it('[권한] 다른 부서 분장표 주인(재무팀)·주인이 아닌 사람은 목록이 닫히고 받기·미리보기·반영이 거부돼요', async () => {
    const t = await setup();
    const before = await faqRows(t);
    const csv = toItFaqCsv([...demoItFaqs(), NEW_FAQ]);

    const haneul = await t.loginAs(MOCK.staff);
    expect(haneul.me.roles).toContain('chart-owner');
    expect((await haneul.call('GET', '/api/navi/it-faq')).body).toEqual({ department: '재무팀', enabled: false, faqs: [] });
    expect((await haneul.call('GET', '/api/navi/it-faq/export')).status).toBe(403);
    expect(await haneul.call('POST', '/api/navi/it-faq/preview', { csv })).toMatchObject({
      status: 403,
      body: { error: 'forbidden', message: 'IT FAQ는 IT지원팀 분장표 주인만 올려요' },
    });
    expect((await haneul.call('POST', '/api/navi/it-faq/apply', { csv, baseVersion: '0'.repeat(24) })).status).toBe(403);

    const doyun = await t.loginAs(MOCK.dev);
    expect((await doyun.call('GET', '/api/navi/it-faq')).status).toBe(403);
    expect((await doyun.call('POST', '/api/navi/it-faq/preview', { csv })).status).toBe(403);
    expect((await doyun.call('POST', '/api/navi/it-faq/apply', { csv, baseVersion: '0'.repeat(24) })).status).toBe(403);

    expect(await faqRows(t)).toEqual(before);
    expect((await t.db.query("select * from audit_log where channel = 'write'")).rows).toEqual([]);
  });

  it('[권한] 문의 행을 다른 부서 분장표 행으로 두거나, 다른 부서 FAQ를 바꾸면 거부해요', async () => {
    const t = await setup();
    // 재무팀 행을 가리키는 FAQ가 있으면 그 FAQ의 주인은 재무팀이에요.
    await t.db.query(
      "insert into navi_it_faqs (id, title, aliases, error_codes, steps, revised_on, row_id, source) values ('ITF-50', '가상 경비 시스템 오류', '{}', '{}', '{가상 단계}', '2026-10-01', 'FIN-03', 'upload')",
    );
    const harin = await t.loginAs(HARIN);
    const otherRow = toItFaqCsv([{ ...NEW_FAQ, rowId: 'FIN-01' }]);
    const res = await harin.call('POST', '/api/navi/it-faq/preview', { csv: otherRow });
    expect(res).toMatchObject({
      status: 422,
      body: { message: 'IT FAQ 양식으로 올려 주세요. ITF-07 행 "문의 행" 칸은 우리 부서(IT지원팀) 분장표 행 ID를 써요' },
    });

    const faqs = (await harin.call('GET', '/api/navi/it-faq')).body as ItFaqListResponse;
    expect(faqs.faqs.map((f) => f.id)).not.toContain('ITF-50');
    const changedOther = toItFaqCsv([
      { id: 'ITF-50', title: '바꾼 제목', aliases: [], errorCodes: [], steps: ['가상 단계'], revisedOn: '2026-10-01', rowId: 'IT-06' },
    ]);
    expect(await harin.call('POST', '/api/navi/it-faq/preview', { csv: changedOther })).toMatchObject({
      status: 422,
      body: { error: 'other-department', message: '다른 부서 IT FAQ는 바뀌지 않아요' },
    });
    expect((await t.db.query("select title from navi_it_faqs where id = 'ITF-50'")).rows).toEqual([{ title: '가상 경비 시스템 오류' }]);
  });

  it('미리보기 뒤 그사이 FAQ가 바뀌었으면 반영하지 않아요(409)', async () => {
    const t = await setup();
    const harin = await t.loginAs(HARIN);
    const csv = toItFaqCsv([NEW_FAQ]);
    const preview = (await harin.call('POST', '/api/navi/it-faq/preview', { csv })).body as ItFaqPreviewResponse;
    await t.db.query("update navi_it_faqs set title = '그사이 바뀐 제목' where id = 'ITF-01'");
    const res = await harin.call('POST', '/api/navi/it-faq/apply', { csv, baseVersion: preview.baseVersion });
    expect(res).toMatchObject({ status: 409, body: { message: '그사이 IT FAQ가 바뀌었어요. 다시 미리 봐 주세요' } });
    expect((await t.db.query("select id from navi_it_faqs where id = 'ITF-07'")).rows).toEqual([]);
  });
});

describe('[IT FAQ 올리기] 파일 양식', () => {
  it('단계는 칸 안 줄바꿈으로 나누고 원문 그대로예요. 따옴표·쉼표·수식 막기 글자도 되돌아와요', () => {
    const faq: ItFaqRow = {
      ...NEW_FAQ,
      title: '=수식처럼 보이는 제목, 쉼표',
      steps: ['"따옴표"가 든 단계예요.', '-로 시작하는 단계', '쉼표, 가 든 단계'],
      errorCodes: ['0x80070005', 'AADSTS50126'],
    };
    const [back] = parseItFaqFile(toItFaqCsv([faq]));
    expect(back).toEqual({ ...faq, revisedOn: faq.revisedOn });
  });

  it('틀린 값은 행과 칸을 알려 줘요. 키·비밀번호 같은 글은 받지 않아요', () => {
    const head = 'ID,제목,단계,문의 행';
    const err = (line: string) => {
      try {
        parseItFaqFile(`${head}\n${line}`);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(err('FAQ-1,제목,단계,IT-06')).toBe('IT FAQ 양식으로 올려 주세요. 2번째 줄 "ID" 칸은 ITF-07처럼 써요');
    expect(err('ITF-08,제목,,IT-06')).toBe('IT FAQ 양식으로 올려 주세요. ITF-08 행 "단계" 칸은 비울 수 없어요');
    expect(err(`ITF-08,제목,"${Array.from({ length: 13 }, (_, i) => `단계 ${i}`).join('\n')}",IT-06`)).toBe(
      'IT FAQ 양식으로 올려 주세요. ITF-08 행 "단계" 칸은 12줄까지 써요',
    );
    expect(err('ITF-08,제목,단계,')).toBe('IT FAQ 양식으로 올려 주세요. ITF-08 행 "문의 행" 칸은 비울 수 없어요');
    expect(err('ITF-08,제목,비밀번호는 password=Hunter2!! 예요,IT-06')).toMatch(
      /^IT FAQ 양식으로 올려 주세요\. ITF-08 행 "단계" 칸은 넣을 수 없는 글이 있어요/,
    );
    expect(err('ITF-08,제목,단계,IT-06\nITF-08,제목,단계,IT-06')).toBe('IT FAQ 양식으로 올려 주세요. ITF-08 행이 두 번 있어요');
    expect(() => parseItFaqFile('그냥 메모예요')).toThrow('IT FAQ 양식으로 올려 주세요');
    expect(() => parseItFaqFile('ID,제목\nITF-08,a')).toThrow('IT FAQ 양식으로 올려 주세요');
  });
});
