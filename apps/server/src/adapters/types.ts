// 바깥 데이터는 모두 어댑터 뒤에 있어요(ADR-05). 모의 어댑터가 하나라도 켜져 있으면 "시연 데이터로 돌아가요" 띠가 떠요.
export interface AdapterCapabilities {
  name: string;
  /** 화면 띠에서 보여 줄 한글 이름 */
  label: string;
  mock: boolean;
}

export interface EmployeeProfile {
  idpSubject: string;
  displayName: string;
  department: string;
  floor: string;
  /** IdP 그룹. 총무·운영자 역할을 여기서 받아요(R17). */
  groups: string[];
}

export interface IdpAdapter {
  capabilities: AdapterCapabilities;
  /** 모의 OIDC에서만 고르는 목록을 줘요. 실제 IdP는 리디렉트로 로그인해요. */
  loginChoices?(): EmployeeProfile[];
  authenticate(idpSubject: string): Promise<EmployeeProfile | null>;
  /** 재직 재확인. 정해진 간격이 지난 뒤 오는 요청에서 불러요(ADR-13). */
  isActive(idpSubject: string): Promise<boolean>;
}

export interface DirectoryAdapter {
  capabilities: AdapterCapabilities;
  getProfile(idpSubject: string): Promise<EmployeeProfile | null>;
  /** 분장표에서 행을 가진 부서. 분장표 주인 역할 계산에 써요(R17). 분장표 가져오기는 4일 차예요. */
  chartOwnerDepartments(): Promise<Set<string>>;
}
