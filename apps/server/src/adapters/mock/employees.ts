import { personNameWords } from '@one-line-desk/shared';
import { z } from 'zod';
import { matchPeople } from '../people';
import type { DirectoryAdapter, EmployeeProfile, IdpAdapter } from '../types';

type MockEmployee = EmployeeProfile & { active: boolean; /** 로그인 고르기 목록에 보일지 */ login: boolean };

const person = (n: number, displayName: string, id: string, department: string, floor: string, groups: string[] = [], login = false): MockEmployee => ({
  idpSubject: `mock|emp-${String(n).padStart(3, '0')}`,
  displayName,
  department,
  floor,
  groups,
  email: `${id}@corp.example`,
  active: true,
  login,
});

// 시연용 가상 직원이에요. 실제 사람이 아니에요. 임시 IdP(idp/realm-one-line-desk.json)와 같은 사람들이에요.
// 로그인 고르기 목록에는 앞의 다섯 명과 IT지원팀 하린만 보이고, 나머지는 참석자 검색에서만 찾을 수 있어요.
const EMPLOYEES: MockEmployee[] = [
  person(1, '가상 직원 하늘', 'haneul', '재무팀', '3층', [], true),
  person(2, '가상 직원 도윤', 'doyun', '개발팀', '5층', ['team-lead'], true),
  person(3, '가상 총무 서연', 'seoyeon', '총무팀', '2층', ['facilities'], true),
  person(4, '가상 인사 지후', 'jihu', '인사팀', '2층', [], true),
  person(5, '가상 운영자 민준', 'minjun', '정보보안팀', '4층', ['operator'], true),
  person(6, '가상 직원 서준', 'seojun', '개발팀', '5층'),
  person(7, '가상 직원 하은', 'haeun', '개발팀', '5층'),
  // 디자인팀장(11/4, ADR-28). 여러 팀 회의 참석자 고르기를 시연하려고 로그인 목록에 보여요.
  person(8, '가상 직원 지우', 'jiwoo', '디자인팀', '5층', ['team-lead'], true),
  person(9, '가상 직원 예준', 'yejun', '영업팀', '3층'),
  person(10, '가상 직원 수아', 'sua', '재무팀', '3층'),
  person(11, '가상 직원 은우', 'eunwoo', '인사팀', '2층'),
  person(12, '가상 직원 유나', 'yuna', '디자인팀', '5층'),
  person(13, '가상 직원 시우', 'siwoo', '영업팀', '3층'),
  person(14, '가상 직원 다인', 'dain', '정보보안팀', '4층'),
  person(15, '가상 직원 주원', 'juwon', '개발팀', '5층'),
  // IT 오류 붙여넣기에서 보낸 문의를 받을 사람(11/1 QA M2). 로그인 목록에 보여요.
  person(16, '가상 IT 하린', 'harin', 'IT지원팀', '4층', [], true),
];

/**
 * 다른 가상 회사의 직원 명단(11/5, 회사별 분리 시연). 시연·개발에서 DESK_MOCK_ROSTER_JSON으로만 받아요(저장소에 두지 않아요).
 * 앱에 든 가상 직원 16명 대신 이 명단으로 로그인·직원 검색을 해요. 주체는 "mock|" 로 시작해요. 모두 지어낸 사람이어야 해요.
 * 모양: [{ "subject": "mock|b-001", "name": "가상 직원 보람", "email": "boram@company-b.example", "department": "재무팀", "floor": "3층", "groups": [], "login": true }]
 */
const RosterSchema = z
  .array(
    z.strictObject({
      subject: z.string().regex(/^mock\|[a-z0-9-]{1,40}$/),
      name: z.string().min(1).max(40),
      email: z.email(),
      department: z.string().min(1).max(40),
      floor: z.string().min(1).max(10),
      groups: z.array(z.enum(['facilities', 'operator', 'team-lead'])).default([]),
      login: z.boolean().default(false),
    }),
  )
  .min(1)
  .max(200);

export function rosterFromJson(json: string): MockEmployee[] {
  return RosterSchema.parse(JSON.parse(json)).map((p) => ({
    idpSubject: p.subject,
    displayName: p.name,
    email: p.email,
    department: p.department,
    floor: p.floor,
    groups: p.groups,
    active: true,
    login: p.login,
  }));
}

export type { MockEmployee };

const strip = ({ active: _active, login: _login, ...profile }: MockEmployee): EmployeeProfile => profile;

export class MockEmployees implements IdpAdapter, DirectoryAdapter {
  readonly capabilities = { name: 'mock-oidc', label: '사내 로그인·직원 디렉터리(모의 OIDC, 가상 직원)', mock: true };
  private readonly people: MockEmployee[];

  /** people가 없으면 앱에 든 가상 직원 16명이에요. 다른 가상 회사 시연은 rosterFromJson으로 읽은 명단을 넘겨요. */
  constructor(people: MockEmployee[] = EMPLOYEES) {
    this.people = people.map((e) => ({ ...e, groups: [...e.groups] }));
  }

  loginChoices(): EmployeeProfile[] {
    return this.people.filter((e) => e.active && e.login).map(strip);
  }

  async search(query: string, limit: number): Promise<EmployeeProfile[]> {
    return matchPeople(
      this.people.filter((e) => e.active),
      query,
      limit,
    ).map(strip);
  }

  async departmentMembers(department: string, limit: number): Promise<EmployeeProfile[]> {
    return this.people
      .filter((e) => e.active && e.department === department)
      .slice(0, limit)
      .map(strip);
  }

  async departments(): Promise<string[]> {
    return [...new Set(this.people.filter((e) => e.active && e.department).map((e) => e.department))];
  }

  async personNameWords(): Promise<string[]> {
    return this.people.filter((e) => e.active).flatMap((e) => personNameWords(e.displayName));
  }

  async authenticate(idpSubject: string): Promise<EmployeeProfile | null> {
    const e = this.people.find((x) => x.idpSubject === idpSubject && x.active);
    return e ? strip(e) : null;
  }

  async isActive(idpSubject: string): Promise<boolean> {
    return this.people.some((x) => x.idpSubject === idpSubject && x.active);
  }

  async getProfile(idpSubject: string): Promise<EmployeeProfile | null> {
    const e = this.people.find((x) => x.idpSubject === idpSubject);
    return e ? strip(e) : null;
  }

  async chartOwnerDepartments(): Promise<Set<string>> {
    // 가상 분장표가 들어오기 전(4일 차)까지 쓰는 임시 값이에요.
    return new Set(['재무팀', '인사팀', '총무팀']);
  }

  /** 시험에서 퇴사를 흉내 내려고 써요. */
  setActive(idpSubject: string, active: boolean): void {
    const e = this.people.find((x) => x.idpSubject === idpSubject);
    if (e) e.active = active;
  }
}
