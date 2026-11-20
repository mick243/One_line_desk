import { CHART_COLUMNS, type ChartPreviewResponse } from '@one-line-desk/shared';
import { describe, expect, it } from 'vitest';
import { createTestApp, MOCK } from '../../testing';
import { CHART_FORMAT_MESSAGE, CHART_HEADER_ALIASES, headerKey, PERSON_HEADERS, parseChart, parseChartFile, parseCsv, readHeader, toCsv } from './chart-csv';
import { parseItFaqFileWithNotes } from './it-faq-csv';
import { demoChartCsv } from './fixtures';

const HEADER = '행 ID,업무,다른 말,담당 팀,창구,창구 링크,지금 할 일,처리 기간,개정일,주인 부서,담당자 이름';

describe('분장표 파일 읽기', () => {
  it('따옴표 안 쉼표·따옴표·줄바꿈과 BOM·CRLF를 읽어요', () => {
    expect(parseCsv('﻿a,"b,1","c ""q""\nd"\r\nx,y,z\r\n')).toEqual([
      ['a', 'b,1', 'c "q"\nd'],
      ['x', 'y', 'z'],
    ]);
    expect(parseCsv('a,"b')).toBeNull();
  });

  it('[D9] 정해진 칸만 읽고 "담당자 이름" 칸은 버려요', () => {
    const rows = parseChart(`${HEADER}\nFIN-09,시험 업무,시험|테스트,재무팀,재무팀 창구,,할 일,,2026-10-01,재무팀,홍길동이름카나리`);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('홍길동이름카나리');
    expect(rows[0]).toEqual({
      id: 'FIN-09',
      task: '시험 업무',
      team: '재무팀',
      desk: '재무팀 창구',
      deskUrl: null,
      nextStep: '할 일',
      processingPeriod: null,
      aliases: ['시험', '테스트'],
      revisedOn: '2026-10-01',
      ownerDepartment: '재무팀',
      onboardingWeek: null,
    });
  });

  it('가상 분장표는 20~30행이고 처리 기간이 빈 행과 헬프데스크 링크가 있어요', () => {
    const rows = parseChart(demoChartCsv());
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.length).toBeLessThanOrEqual(30);
    expect(new Set(rows.map((r) => r.ownerDepartment))).toEqual(new Set(['재무팀', '인사팀', '총무팀', 'IT지원팀', '정보보안팀']));
    expect(rows.some((r) => r.processingPeriod === null)).toBe(true);
    expect(rows.filter((r) => r.ownerDepartment === 'IT지원팀').every((r) => r.deskUrl?.startsWith('https://helpdesk.example.com/'))).toBe(true);
    expect(demoChartCsv()).toContain('담당자 이름');
    expect(JSON.stringify(rows)).not.toContain('가상 담당');
  });

  it.each([
    ['빈 글', ''],
    ['양식이 아닌 글', '안녕하세요\n그냥 메모예요'],
    ['꼭 있어야 하는 칸이 없음', '행 ID,업무\nFIN-01,무엇'],
    ['행 ID 모양이 틀림', `${HEADER}\nfin 1,업무,,재무팀,창구,,할 일,,,재무팀,`],
    ['같은 행 ID가 두 번', `${HEADER}\nFIN-01,a,,재무팀,창구,,할 일,,,재무팀,\nFIN-01,b,,재무팀,창구,,할 일,,,재무팀,`],
    ['위험한 링크', `${HEADER}\nFIN-01,a,,재무팀,창구,javascript:alert(1),할 일,,,재무팀,`],
    ['필수 칸이 빔', `${HEADER}\nFIN-01,,,재무팀,창구,,할 일,,,재무팀,`],
    ['날짜 모양이 틀림', `${HEADER}\nFIN-01,a,,재무팀,창구,,할 일,,10월 1일,재무팀,`],
  ])('읽을 수 없는 파일(%s)은 "분장표 양식으로 올려 주세요"로 거부해요', (_name, text) => {
    expect(() => parseChart(text)).toThrow(CHART_FORMAT_MESSAGE);
  });

  it('내보낸 파일을 다시 읽으면 같은 행이에요(사람 이름 칸 없음)', () => {
    const rows = parseChart(demoChartCsv()).filter((r) => r.ownerDepartment === '재무팀');
    const csv = toCsv(rows);
    expect(csv).not.toContain('담당자 이름');
    expect(parseChart(csv)).toEqual(rows);
  });
});

describe('후보 17: 머리 줄 낱말 표(규칙)', () => {
  const COMPANY = '업무 코드,업무명,담당부서,문의처,처리 방법,주인 부서(필수),담당자,성명,비고';
  const LINE = 'FIN-09,시험 업무,재무팀,재무팀 창구,할 일,재무팀,가상이름카나리,가상성명카나리,메모카나리';

  it('[후보 17] 회사 엑셀에서 흔한 머리 줄(업무명·담당부서·문의처·처리 방법, 띄어쓰기·괄호 차이)을 우리 칸으로 읽어요', () => {
    const file = parseChartFile(`${COMPANY}\n${LINE}`);
    expect(file.rows).toEqual([
      {
        id: 'FIN-09',
        task: '시험 업무',
        team: '재무팀',
        desk: '재무팀 창구',
        deskUrl: null,
        nextStep: '할 일',
        processingPeriod: null,
        aliases: [],
        revisedOn: null,
        ownerDepartment: '재무팀',
        onboardingWeek: null,
      },
    ]);
    // 띄어쓰기·대소문자·괄호·별표·전각 차이
    for (const head of [
      '행ID,업무*,담당팀,창구,지금할일,주인부서',
      '행 id,업무 [필수],담당 팀,창 구,지금 할 일 (원문),주인 부서',
      '행　ＩＤ,업무,담당_팀,창구,지금·할일,주인 부서',
    ]) {
      expect(parseChart(`${head}\nFIN-09,시험 업무,재무팀,창구,할 일,재무팀`), head).toHaveLength(1);
    }
  });

  it("[후보 17] 미리보기 안내는 \"'업무명' 칸을 '업무'로 읽었어요\"처럼 우리 표에 있는 말만 되풀이하고, 버린 칸은 수만 알려요", () => {
    const { headerNotes } = parseChartFile(`${COMPANY}\n${LINE}`);
    expect(headerNotes).toEqual([
      "'업무 코드' 칸을 '행 ID'로 읽었어요",
      "'업무명' 칸을 '업무'로 읽었어요",
      "'담당부서' 칸을 '담당 팀'으로 읽었어요",
      "'문의처' 칸을 '창구'로 읽었어요",
      "'처리 방법' 칸을 '지금 할 일'로 읽었어요",
      '정해진 칸 말고 다른 칸 3개는 읽지 않고 버렸어요',
    ]);
    // 우리 양식 그대로면 안내가 없어요(내보낸 파일).
    expect(parseChartFile(toCsv(parseChart(demoChartCsv()))).headerNotes).toEqual([]);
  });

  it('[후보 17][D9] 담당자·성명·이름 같은 사람 이름 머리 줄은 표에 없고 버려요. 표에 넣으면 바로 멈춰요', () => {
    const file = parseChartFile(`${COMPANY},이름,담당자 이름,연락처\n${LINE},가상이름2,가상이름3,010-0000-0000`);
    expect(JSON.stringify(file)).not.toMatch(/카나리|가상이름|010-0000/);
    for (const person of PERSON_HEADERS) {
      expect(() => readHeader([person], { a: '업무' }, { a: [person] }, [])).toThrow('사람 이름 칸');
      expect(readHeader([person], CHART_COLUMNS, CHART_HEADER_ALIASES, []).columns).toEqual([undefined]);
    }
    for (const aliases of Object.values(CHART_HEADER_ALIASES)) for (const a of aliases) expect(PERSON_HEADERS.map(headerKey)).not.toContain(headerKey(a));
  });

  it('[후보 17] 꼭 있어야 하는 칸(행 ID·주인 부서 등)이 없으면 지금처럼 거절하고, 어느 칸인지와 [분장표 파일 받기]를 알려요', () => {
    expect(() => parseChart('업무명,담당부서,문의처,처리 방법\n시험,재무팀,창구,할 일')).toThrow(
      '분장표 양식으로 올려 주세요. "행 ID"·"주인 부서" 칸이 없어요. [분장표 파일 받기]로 받은 양식에 맞춰 올려 주세요',
    );
    // 두 칸이 같은 우리 칸으로 읽히면 하나만 남기라고 알려요.
    expect(() => parseChart('행 ID,업무,업무명,담당 팀,창구,지금 할 일,주인 부서\nFIN-09,a,b,재무팀,창구,할 일,재무팀')).toThrow(
      '"업무" 칸으로 읽히는 칸이 둘 있어요',
    );
  });

  it('[후보 17] IT FAQ 파일도 같은 낱말 표로 읽고, 꼭 있어야 하는 칸이 없으면 [IT FAQ 파일 받기]를 알려요', () => {
    const file = parseItFaqFileWithNotes('FAQ 번호,FAQ 제목,해결 방법,문의 행 ID,작성자\nITF-08,가상 제목,"첫 단계\n둘째 단계",IT-06,가상작성자카나리');
    expect(file.rows).toEqual([
      { id: 'ITF-08', title: '가상 제목', aliases: [], errorCodes: [], steps: ['첫 단계', '둘째 단계'], revisedOn: null, rowId: 'IT-06' },
    ]);
    expect(file.headerNotes).toEqual([
      "'FAQ 번호' 칸을 'ID'로 읽었어요",
      "'FAQ 제목' 칸을 '제목'으로 읽었어요",
      "'해결 방법' 칸을 '단계'로 읽었어요",
      "'문의 행 ID' 칸을 '문의 행'으로 읽었어요",
      '정해진 칸 말고 다른 칸 1개는 읽지 않고 버렸어요',
    ]);
    expect(JSON.stringify(file)).not.toContain('카나리');
    expect(() => parseItFaqFileWithNotes('FAQ 제목,해결 방법\n가상,단계')).toThrow(
      'IT FAQ 양식으로 올려 주세요. "ID"·"문의 행" 칸이 없어요. [IT FAQ 파일 받기]로 받은 양식에 맞춰 올려 주세요',
    );
  });
});

describe('후보 17: 미리보기 응답의 머리 줄 안내', () => {
  it('[후보 17] 분장표 주인이 다른 이름 머리 줄로 올리면 미리보기에 안내가 오고, 반영은 지금처럼 확인 뒤 [반영하기]예요', async () => {
    const t = await createTestApp();
    try {
      await t.modules.find((m) => m.kind === 'navi')!.seed!();
      const staff = await t.loginAs(MOCK.staff);
      const exported = ((await staff.call('GET', '/api/navi/chart/export')).body as { csv: string }).csv;
      const plain = (await staff.call('POST', '/api/navi/chart/preview', { csv: exported })).body as ChartPreviewResponse;
      expect(plain.headerNotes).toBeUndefined();
      const renamed = exported.replace('행 ID,업무,', '업무 코드,업무명,').replace(',담당 팀,', ',담당부서,');
      const preview = await staff.call('POST', '/api/navi/chart/preview', { csv: renamed });
      expect(preview.status).toBe(200);
      const body = preview.body as ChartPreviewResponse;
      expect(body.headerNotes).toEqual(["'업무 코드' 칸을 '행 ID'로 읽었어요", "'업무명' 칸을 '업무'로 읽었어요", "'담당부서' 칸을 '담당 팀'으로 읽었어요"]);
      // 읽은 값은 같아서 바뀌는 행이 없어요. 미리보기는 쓰지 않아요.
      expect(body.changes).toEqual([]);
      expect((await t.db.query("select * from audit_log where channel = 'write'")).rows).toEqual([]);
      expect((await t.db.query('select * from ai_usage')).rows).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
