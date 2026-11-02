import { randomUUID } from 'node:crypto';
import type { ModuleKind } from '@one-line-desk/shared';
import { openJson, sealJson, sealKey } from './seal';

// 제안 토큰(ADR-03, R2, M3). 서버가 봉인한 짧은 수명의 값이에요. DB에는 쓰지 않아요.
// 안에는 사용자(가명 ID)·모듈·동작·검증된 구조 값만 넣어요. 원문이나 접근 토큰은 넣지 않아요.
// 11/2 B11(REVIEW L3): 서명만 붙인 base64에서 봉인(AES-256-GCM, core/seal.ts)으로 바꿨어요. 앱 확인 링크(/r/<토큰>)가
// AI 앱 답·브라우저 기록·접근 기록에 남아도 가명 ID·방·시각을 읽을 수 없고, 고치면 열리지 않아요.
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

const AAD = 'proposal-token';

function isPayload(v: Record<string, unknown> | null): v is Record<string, unknown> & ProposalPayload {
  return (
    !!v &&
    typeof v.jti === 'string' &&
    typeof v.u === 'string' &&
    typeof v.m === 'string' &&
    typeof v.a === 'string' &&
    typeof v.exp === 'number' &&
    !!v.p &&
    typeof v.p === 'object' &&
    !Array.isArray(v.p)
  );
}

export class ProposalTokens {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly now: () => number,
    private readonly ttlMs: () => number,
  ) {
    this.key = sealKey(secret, 'proposal');
  }

  sign(pseudonymId: string, module: ModuleKind, action: string, params: Record<string, unknown>): string {
    const payload: ProposalPayload = { jti: randomUUID(), u: pseudonymId, m: module, a: action, p: params, exp: this.now() + this.ttlMs() };
    return sealJson(this.key, AAD, payload);
  }

  /**
   * 봉인이 맞으면 payload를 꺼내요. 만료된 토큰도 봉인이 맞으면 payload를 같이 돌려줘서
   * 같은 조건으로 다시 찾을 수 있게 해요(ADR-03 "만료 뒤 다시 찾기").
   */
  verify(token: string, pseudonymId: string): VerifyResult {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(token)) return { ok: false, reason: 'bad' };
    const payload = openJson(this.key, AAD, token);
    if (!isPayload(payload)) return { ok: false, reason: 'bad' };
    if (payload.u !== pseudonymId) return { ok: false, reason: 'owner' };
    if (this.now() > payload.exp) return { ok: false, reason: 'expired', payload };
    return { ok: true, payload };
  }
}
