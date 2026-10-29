import { randomBytes } from 'node:crypto';

// 서버 세션(ADR-13). 브라우저에는 httpOnly 쿠키의 세션 ID만 가요. IdP 토큰은 서버에만 둬요.
export const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export interface DeskSession {
  id: string;
  /** IdP 식별자. 재직 재확인에만 쓰고 로그·DB에는 가명 ID만 남겨요. */
  idpSubject: string;
  pseudonymId: string;
  csrfToken: string;
  createdAt: number;
  lastEmploymentCheckAt: number;
  /** 마지막으로 사람이 쓴 시각. 알림 폴링 같은 배경 요청은 세지 않아요. 운영 값 idleTimeoutMinutes를 넘으면 끊겨요(ADR-20, 안전성 확보조치 기준 제6조④). */
  lastActiveAt: number;
  /** 이 로그인이 MFA 근거(amr·acr)를 가졌는지. 시연 로그인은 거짓이에요(ADR-20). */
  mfa: boolean;
  /** IdP가 알려 준 인증 시각(ms). 다시 로그인 확인에 써요. 없으면 undefined예요. */
  authTime?: number;
}

/** 로그인할 때 IdP에서 받은 인증 근거 */
export interface LoginAssurance {
  mfa: boolean;
  authTime?: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, DeskSession>();
  /**
   * 이 서버 프로세스의 기동 번호(10/29 배포 준비 회의 B3). 세션 ID 앞에 붙여서, 서명은 맞는데 세션이 없을 때
   * 재시작(배포) 때문인지 알아요. 세션이 메모리에만 있어서 재시작하면 모두 사라져요. 세션 표(앞선 F1)가 들어오면 필요 없어요.
   */
  readonly boot = randomBytes(6).toString('base64url');

  constructor(private readonly now: () => number) {}

  /** 이 세션 ID가 지금 프로세스보다 앞선 기동에서 만든 것인지 */
  fromEarlierBoot(id: string): boolean {
    return !id.startsWith(this.boot);
  }

  create(idpSubject: string, pseudonymId: string, assurance: LoginAssurance = { mfa: false }): DeskSession {
    const at = this.now();
    const session: DeskSession = {
      id: this.boot + randomBytes(32).toString('base64url'),
      idpSubject,
      pseudonymId,
      csrfToken: randomBytes(24).toString('base64url'),
      createdAt: at,
      lastEmploymentCheckAt: at,
      lastActiveAt: at,
      mfa: assurance.mfa,
      ...(assurance.authTime !== undefined ? { authTime: assurance.authTime } : {}),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): DeskSession | undefined {
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (this.now() - session.createdAt > SESSION_MAX_AGE_MS) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  /** 모든 기기 로그아웃·퇴사 확인. 나중에 MCP 승인 폐기도 여기서 같이 불러요(ADR-15). */
  destroyAllFor(pseudonymId: string): number {
    let count = 0;
    for (const [id, s] of this.sessions) {
      if (s.pseudonymId === pseudonymId) {
        this.sessions.delete(id);
        count += 1;
      }
    }
    return count;
  }
}
