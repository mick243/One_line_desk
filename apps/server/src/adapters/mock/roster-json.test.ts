import { describe, expect, it } from 'vitest';
import { MockEmployees, rosterFromJson } from './employees';
import { leaveRecordsFromJson, MockLeave } from './leave';

// 다른 가상 회사 명단·근태 기록(11/5, 회사별 분리 시연). 배포 시연은 비밀 값(JSON)으로 받아요.
const roster = JSON.stringify([
  { subject: 'mock|b-001', name: '가상 직원 보람', email: 'boram@company-b.example', department: '재무팀', floor: '3층', login: true },
  {
    subject: 'mock|b-005',
    name: '가상 운영자 건우',
    email: 'geonu@company-b.example',
    department: '정보보안팀',
    floor: '4층',
    groups: ['operator'],
    login: true,
  },
  { subject: 'mock|b-006', name: '가상 직원 민서', email: 'minseo@company-b.example', department: '개발팀', floor: '5층' },
]);

describe('다른 가상 회사 명단', () => {
  it('받은 명단만 로그인·검색에 쓰고, 앱에 든 가상 직원은 보이지 않아요', async () => {
    const b = new MockEmployees(rosterFromJson(roster));
    expect(b.loginChoices().map((e) => e.displayName)).toEqual(['가상 직원 보람', '가상 운영자 건우']);
    expect(await b.authenticate('mock|emp-001')).toBeNull();
    expect((await b.authenticate('mock|b-005'))?.groups).toEqual(['operator']);
    expect((await b.search('민서', 5)).map((e) => e.email)).toEqual(['minseo@company-b.example']);
    expect(await b.search('하늘', 5)).toEqual([]);
  });

  it('모양이 틀리면(주체 꼴·모르는 역할·빈 명단) 띄우지 않아요', () => {
    expect(() => rosterFromJson('[]')).toThrow();
    expect(() => rosterFromJson(JSON.stringify([{ subject: 'b-1', name: 'x', email: 'x@y.example', department: 'a', floor: '1층' }]))).toThrow();
    expect(() =>
      rosterFromJson(JSON.stringify([{ subject: 'mock|b-1', name: 'x', email: 'x@y.example', department: 'a', floor: '1층', groups: ['admin'] }])),
    ).toThrow();
  });

  it('근태 기록도 글자(JSON)로 받아요', async () => {
    const leave = new MockLeave(leaveRecordsFromJson(JSON.stringify({ 'boram@company-b.example': { hireDate: '2021-04-01', uses: [] } })));
    expect(await leave.leaveOf({ idpSubject: 'mock|b-001', email: 'boram@company-b.example' })).toEqual({ hireDate: '2021-04-01', uses: [] });
  });
});
