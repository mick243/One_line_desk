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
}

export class SessionStore {
  private readonly sessions = new Map<string, DeskSession>();

  constructor(private readonly now: () => number) {}

  create(idpSubject: string, pseudonymId: string): DeskSession {
    const at = this.now();
    const session: DeskSession = {
      id: randomBytes(32).toString('base64url'),
      idpSubject,
      pseudonymId,
      csrfToken: randomBytes(24).toString('base64url'),
      createdAt: at,
      lastEmploymentCheckAt: at,
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
