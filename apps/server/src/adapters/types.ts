// 바깥 데이터는 모두 어댑터 뒤에 있어요(ADR-05). 모의 어댑터가 하나라도 켜져 있으면 "시연 데이터로 돌아가요" 띠가 떠요.
export interface AdapterCapabilities {
  name: string;
  /** 화면 띠에서 보여 줄 한글 이름 */
  label: string;
  mock: boolean;
  /** 실제 자료와 가상 자료가 섞여 있어요(분장표를 일부 부서만 올렸을 때). 띠에는 보이지만 MCP 판정은 실제(mock: false)로 해요. */
  partial?: boolean;
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

/** ID 토큰이 알려 준 인증 근거(ADR-20). 값 뜻은 IdP마다 달라서 MFA 판정은 설정(mfaAmr·mfaAcr)으로 해요. */
export interface LoginEvidence {
  amr: string[];
  acr?: string;
  /** 인증 시각(ms, auth_time) */
  authTime?: number;
}

/** 실제 IdP 리디렉트 로그인(OIDC 인가 코드 + PKCE). 모의 IdP에는 없어요. */
export interface OidcLogin {
  /** 로그인 화면에 보여 줄 이름(예: "회사 계정") */
  label: string;
  /** prompt=login·max_age: 쉬는 시간 뒤 다시 인증받기. acrValues: IdP에 MFA를 요청하는 값(선택). */
  authorizationUrl(p: {
    state: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
    prompt?: 'login';
    maxAge?: number;
    acrValues?: string;
  }): Promise<string>;
  /** 인가 코드를 토큰으로 바꾸고 ID 토큰을 검증해요. 맞지 않으면 null, IdP에 닿지 못하면 던져요. */
  finishLogin(p: {
    code: string;
    codeVerifier: string;
    nonce: string;
    redirectUri: string;
  }): Promise<{ profile: EmployeeProfile; evidence: LoginEvidence } | null>;
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

/** 휴가를 한 번 쓴 기록. 날짜·하루/반나절·종류만 있어요. 사유는 받지 않아요. */
export interface LeaveUse {
  /** YYYY-MM-DD(한국 날짜). 앞으로 쓸 예정인(승인된) 날도 들어 있어요. 결재 중인 신청은 없어요. */
  date: string;
  /** 하루보다 짧은 쓰기(반반차·시간 단위 연차)는 'half'로 두고 amountDays에 쓴 양을 넣어요(같은 팀 일정은 반나절로 보여요). */
  kind: 'full' | 'half';
  /** 반차의 오전·오후(근태 기록이 알려 줄 때만, 11/3 팀 부재). 없으면 "반나절"로 보여요. */
  half?: 'am' | 'pm';
  /**
   * 종류. 연차(annual)만 남은 연차 계산에서 빼요. 공가(official, 11/1)는 늘 빼지 않고, 병가(sick, 11/3)·경조(family-event, 11/6)는
   * 운영 값(sickLeaveFromAnnual·eventLeaveFromAnnual, 기본 안 뺌)을 따라요. **종류 없는 기록은 연차로 보지 않아요**(11/6 휴가 정확도:
   * 근태가 종류를 안 주면 무엇인지 몰라서 세지 않아요). 어댑터는 연차 기록에 annual을 꼭 넣어요.
   * 사유는 받지 않아요(그룹웨어 신청서에만 있어요). 같은 팀 일정·회의실 인원 짐작은 종류를 내보내지 않아요.
   */
  type?: 'annual' | 'official' | 'sick' | 'family-event';
  /**
   * 쓴 양(일, 11/6 휴가 정확도). 반반차(0.25)·시간 단위 연차(2시간 = 0.25일, 하루 8시간 기준)처럼 하루·반차가 아닌 양을
   * 근태 기록이 알려 줄 때만 있어요. 없으면 하루 1일·반차 0.5일이에요(예전 기록과 그대로 맞아요).
   */
  amountDays?: number;
}

/**
 * 근태 시스템이 계산해 준 이번 연차 기간 숫자(11/6 휴가 정확도, 선택). 앱은 "계산기"가 아니라 근태 숫자를 읽어 보여 주는 곳이라,
 * 이 칸이 있으면 앱 계산(입사일 기준·개근 가정)보다 **먼저** 보여요("근태 기록 기준"). 회계연도 기준·이월·출근율 80%·결근·회사 추가 부여 같은
 * 계산 정책은 근태 시스템 몫이에요. 승인돼 근태에 들어간 휴가(앞으로 쓸 날 포함)는 뺀 값이고, 결재 중인 신청은 빼지 않은 값이에요.
 */
export interface LeaveSystemBalance {
  /** 기간 기준: 입사일(hire-date) 또는 회계연도(fiscal-year). 모르면 없어요. */
  basis?: 'hire-date' | 'fiscal-year';
  /** 이번 연차 기간 첫날·마지막 날(YYYY-MM-DD). 마지막 날이 지나면 남은 연차가 사라져요(소멸일). */
  periodStart: string;
  periodEnd: string;
  /** 이번 기간에 생긴 연차(이월·회사 추가 부여 포함). 모르면 없어요. */
  granted?: number;
  /** 이번 기간에 쓴 연차(승인된 예정 포함). 모르면 없어요. */
  used?: number;
  /** 이번 기간 남은 연차 */
  remaining: number;
}

/** 인사 근태 시스템의 본인 연차 자료(등급 2). 그 사람 화면에만 보이고, AI·로그·DB에는 넣지 않아요(ADR-18). */
export interface LeaveRecord {
  /** 입사일 YYYY-MM-DD. 근태 숫자(balance)가 없을 때 연차 기간과 생긴 일수를 이걸로 계산해요(근로기준법, 개근 가정). */
  hireDate: string;
  uses: LeaveUse[];
  /** 근태 시스템이 준 이번 기간 숫자(11/6). 있으면 이 숫자를 먼저 보여요. */
  balance?: LeaveSystemBalance;
}

/**
 * 인사 근태(연차) 어댑터. 본인 것만 읽어요. 아무 사람이나 찾는 목록·검색 함수는 없어요.
 * 받은 팀(인사팀)은 그 사람이 보낸 휴가 요청을 처리할 때만 그 사람 것을 읽어요(ADR-24).
 */
export interface LeaveAdapter {
  capabilities: AdapterCapabilities;
  /**
   * 회사 근태 시스템과 연결돼 있는지(11/6 휴가 정확도). 거짓이면(운영의 "연결 안 함") 카드가 빈칸 대신
   * "회사 근태 기록과 아직 연결되지 않아 남은 연차를 보여 드릴 수 없어요"를 보여요.
   */
  readonly connected: boolean;
  /** 연결이 안 됐거나 기록이 없으면 null이에요. 회사 메일(사번 대신)로 찾아요. */
  leaveOf(person: { idpSubject: string; email?: string }): Promise<LeaveRecord | null>;
  /**
   * 인사팀이 승인한 휴가를 근태 기록에 넣어요(ADR-24). 넣으면 남은 연차 계산에서 바로 빠져요.
   * 연결이 안 됐으면 'not-connected'예요(그룹웨어 근태에 직접 반영해야 해요). 기록이 없는 사람은 'not-found'예요.
   */
  recordUses(person: { idpSubject: string; email?: string }, uses: LeaveUse[]): Promise<'recorded' | 'not-connected' | 'not-found'>;
}

/** 메신저 DM(ADR-17). 받는 사람은 회사 메일로 찾아요. 글에는 회의실·시간·부른 사람만 넣어요. */
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
  /**
   * 같은 부서 재직자(11/3 홈 채팅 "우리 팀 부재"). 묻는 사람 본인 부서만 부르고, limit명까지예요.
   * 이름은 같은 부서 사람에게만 보여요. 다른 부서 목록을 화면·API·LLM에 내보내지 않아요.
   */
  departmentMembers(department: string, limit: number): Promise<EmployeeProfile[]>;
  /** 재직자 부서 이름들. 질문에 다른 팀 이름이 있는지 서버 안에서 대조만 해요(화면·API·LLM에 내보내지 않아요). */
  departments(): Promise<string[]>;
  /** 공개 판 이름 검사에 대조할 직원 이름 낱말(재직자). 서버 안에서 대조만 하고 화면·API·LLM에 내보내지 않아요(QA-4). */
  personNameWords(): Promise<string[]>;
}
