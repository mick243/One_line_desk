import { describe, expect, it } from 'vitest';
import { CHART_FORMAT_MESSAGE, parseChart, parseCsv, toCsv } from './chart-csv';
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
