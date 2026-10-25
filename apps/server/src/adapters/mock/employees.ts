import type { DirectoryAdapter, EmployeeProfile, IdpAdapter } from '../types';

type MockEmployee = EmployeeProfile & { active: boolean };

// 시연용 가상 직원이에요. 실제 사람이 아니에요.
const EMPLOYEES: MockEmployee[] = [
  { idpSubject: 'mock|emp-001', displayName: '가상 직원 하늘', department: '재무팀', floor: '3층', groups: [], active: true },
  { idpSubject: 'mock|emp-002', displayName: '가상 직원 도윤', department: '개발팀', floor: '5층', groups: [], active: true },
  { idpSubject: 'mock|emp-003', displayName: '가상 총무 서연', department: '총무팀', floor: '2층', groups: ['facilities'], active: true },
  { idpSubject: 'mock|emp-004', displayName: '가상 인사 지후', department: '인사팀', floor: '2층', groups: [], active: true },
  { idpSubject: 'mock|emp-005', displayName: '가상 운영자 민준', department: '정보보안팀', floor: '4층', groups: ['operator'], active: true },
];

const strip = ({ active: _active, ...profile }: MockEmployee): EmployeeProfile => profile;

export class MockEmployees implements IdpAdapter, DirectoryAdapter {
  readonly capabilities = { name: 'mock-oidc', label: '사내 로그인·직원 디렉터리(모의 OIDC, 가상 직원)', mock: true };
  private readonly people: MockEmployee[] = EMPLOYEES.map((e) => ({ ...e, groups: [...e.groups] }));

  loginChoices(): EmployeeProfile[] {
    return this.people.filter((e) => e.active).map(strip);
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
