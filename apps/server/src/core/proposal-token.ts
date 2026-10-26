import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ModuleKind } from '@one-line-desk/shared';

// 제안 토큰(ADR-03, R2, M3). 서버가 서명한 짧은 수명의 값이에요. DB에는 쓰지 않아요.
// 안에는 사용자(가명 ID)·모듈·동작·검증된 구조 값만 넣어요. 원문이나 접근 토큰은 넣지 않아요.
export interface ProposalPayload {
  /** 토큰 ID. 게시처럼 바로 실행하는 쓰기의 멱등 키로 써요. */
  jti: string;
  u: string;
  m: ModuleKind;
  a: string;
  p: Record<string, unknown>;
  /** 만료(밀리초) */
  exp: number;
}

export type VerifyResult = { ok: true; payload: ProposalPayload } | { ok: false; reason: 'bad' | 'owner' | 'expired'; payload?: ProposalPayload };

export class ProposalTokens {
  constructor(
    private readonly secret: string,
    private readonly now: () => number,
    private readonly ttlMs: () => number,
  ) {}

  sign(pseudonymId: string, module: ModuleKind, action: string, params: Record<string, unknown>): string {
    const payload: ProposalPayload = { jti: randomUUID(), u: pseudonymId, m: module, a: action, p: params, exp: this.now() + this.ttlMs() };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  /**
   * 서명이 맞으면 payload를 꺼내요. 만료된 토큰도 서명이 맞으면 payload를 같이 돌려줘서
   * 같은 조건으로 다시 찾을 수 있게 해요(ADR-03 "만료 뒤 다시 찾기").
   */
  verify(token: string, pseudonymId: string): VerifyResult {
    const [body, mac] = token.split('.');
    if (!body || !mac) return { ok: false, reason: 'bad' };
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad' };
    let payload: ProposalPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ProposalPayload;
    } catch {
      return { ok: false, reason: 'bad' };
    }
    if (payload.u !== pseudonymId) return { ok: false, reason: 'owner' };
    if (this.now() > payload.exp) return { ok: false, reason: 'expired', payload };
    return { ok: true, payload };
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(`proposal:${body}`).digest('base64url');
  }
}
