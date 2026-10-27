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
  /** 회사 메일. 그룹웨어 캘린더·Slack 계정을 찾을 때만 써요(화면·LLM에는 내보내지 않아요). */
  email?: string;
}

/** 실제 IdP 리디렉트 로그인(OIDC 인가 코드 + PKCE). 모의 IdP에는 없어요. */
export interface OidcLogin {
  /** 로그인 화면에 보여 줄 이름(예: "회사 계정") */
  label: string;
  authorizationUrl(p: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): Promise<string>;
  /** 인가 코드를 토큰으로 바꾸고 ID 토큰을 검증해요. 맞지 않으면 null이에요. */
  finishLogin(p: { code: string; codeVerifier: string; nonce: string; redirectUri: string }): Promise<EmployeeProfile | null>;
}

export interface IdpAdapter {
  capabilities: AdapterCapabilities;
  /** 모의 OIDC에서만 고르는 목록을 줘요. 실제 IdP는 리디렉트로 로그인해요. */
  loginChoices?(): EmployeeProfile[];
  authenticate(idpSubject: string): Promise<EmployeeProfile | null>;
  /** 재직 재확인. 정해진 간격이 지난 뒤 오는 요청에서 불러요(ADR-13). */
  isActive(idpSubject: string): Promise<boolean>;
  oidc?: OidcLogin;
}

/** 그룹웨어 캘린더 일정(ADR-17). 초대 메일·수락은 그룹웨어가 맡아요. */
export interface CalendarEvent {
  /** 같은 uid면 같은 일정이에요(참석자를 더하면 고쳐요). */
  uid: string;
  title: string;
  /** ISO 시각 */
  start: string;
  end: string;
  location: string;
  organizerEmail: string;
  attendeeEmails: string[];
}

export interface CalendarAdapter {
  capabilities: AdapterCapabilities;
  upsertEvent(event: CalendarEvent): Promise<void>;
  cancelEvent(uid: string): Promise<void>;
}

/** 휴가를 한 번 쓴 기록. 날짜와 하루·반나절만 있어요. 사유는 받지 않아요. */
export interface LeaveUse {
  /** YYYY-MM-DD(한국 날짜). 앞으로 쓸 예정인 날도 들어 있어요. */
  date: string;
  kind: 'full' | 'half';
}

/** 인사 근태 시스템의 본인 연차 자료(등급 2). 그 사람 화면에만 보이고, AI·로그·DB에는 넣지 않아요(ADR-18). */
export interface LeaveRecord {
  /** 입사일 YYYY-MM-DD. 연차 기간과 생긴 일수를 이걸로 계산해요. */
  hireDate: string;
  uses: LeaveUse[];
}

/** 인사 근태(연차) 어댑터. 본인 것만 읽어요. 남의 것을 찾는 함수는 없어요. */
export interface LeaveAdapter {
  capabilities: AdapterCapabilities;
  /** 연결이 안 됐거나 기록이 없으면 null이에요. 회사 메일(사번 대신)로 찾아요. */
  leaveOf(person: { idpSubject: string; email?: string }): Promise<LeaveRecord | null>;
}

/** 메신저 DM(ADR-17). 받는 사람은 회사 메일로 찾아요. 글에는 방·시간·부른 사람만 넣어요. */
export interface MessengerAdapter {
  capabilities: AdapterCapabilities;
  sendDirect(message: { toEmail: string; text: string }): Promise<'sent' | 'not-found'>;
}

export interface DirectoryAdapter {
  capabilities: AdapterCapabilities;
  getProfile(idpSubject: string): Promise<EmployeeProfile | null>;
  /** 분장표에서 행을 가진 부서. 분장표 주인 역할 계산에 써요(R17). 분장표 가져오기는 4일 차예요. */
  chartOwnerDepartments(): Promise<Set<string>>;
  /** 참석자 고르기용 직원 검색(이름·부서). 재직 중인 사람만, limit명까지예요. 명단을 통째로 주지 않아요. */
  search(query: string, limit: number): Promise<EmployeeProfile[]>;
  /** 공개 판 이름 검사에 대조할 직원 이름 낱말(재직자). 서버 안에서 대조만 하고 화면·API·LLM에 내보내지 않아요(QA-4). */
  personNameWords(): Promise<string[]>;
}
