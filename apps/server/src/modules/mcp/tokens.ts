import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

// MCP 인가 서버의 토큰 도구(ADR-15).
// - 접근·갱신 토큰과 동의 요청은 서버 키로 봉인해요(AES-256-GCM). 고치거나 위조하면 열리지 않고, 클라이언트는 안을 읽지 못해요.
// - 접두어를 추가 인증 데이터로 묶어서 갱신 토큰을 접근 토큰 자리에 쓸 수 없어요.
// - DB에는 갱신 토큰의 해시만 남겨요.

export const TOKEN_PREFIX = { access: 'mat_', refresh: 'mrt_', request: 'mrq_' } as const;
export type TokenKind = keyof typeof TOKEN_PREFIX;

const MAX_TOKEN_LENGTH = 4096;

export class TokenKit {
  private readonly sealKey: Buffer;
  private readonly hashKey: Buffer;

  constructor(secret: string) {
    this.sealKey = Buffer.from(hkdfSync('sha256', secret, 'one-line-desk', 'mcp-seal-v1', 32));
    this.hashKey = Buffer.from(hkdfSync('sha256', secret, 'one-line-desk', 'mcp-hash-v1', 32));
  }

  seal(kind: TokenKind, payload: object): string {
    const prefix = TOKEN_PREFIX[kind];
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.sealKey, iv);
    cipher.setAAD(Buffer.from(prefix));
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return prefix + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
  }

  /** 봉인이 맞지 않거나 접두어가 다르면 null이에요. 만료·대상 검사는 부르는 쪽이 해요. */
  open(kind: TokenKind, token: string): Record<string, unknown> | null {
    const prefix = TOKEN_PREFIX[kind];
    if (!token.startsWith(prefix) || token.length > MAX_TOKEN_LENGTH) return null;
    const raw = Buffer.from(token.slice(prefix.length), 'base64url');
    if (raw.length < 12 + 16 + 2) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.sealKey, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(prefix));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
      const value: unknown = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** 갱신 토큰 해시. 서버 키를 섞어서 DB만 봐서는 토큰을 맞혀 볼 수 없어요. */
  hash(value: string): string {
    return createHmac('sha256', this.hashKey).update(value).digest('hex');
  }
}

/** 클라이언트 비밀 해시(sha256 hex). 운영자가 클라이언트를 등록할 때도 같은 값을 넣어요. */
export function hashClientSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function verifyClientSecret(secret: string, expectedHash: string): boolean {
  const given = Buffer.from(hashClientSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** PKCE S256(RFC 7636). code_verifier는 43~128자의 예약되지 않은 문자예요. */
export const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
/** S256 code_challenge는 sha256을 패딩 없는 base64url로 쓴 43자예요. */
export const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER_RE.test(verifier)) return false;
  const given = Buffer.from(pkceChallenge(verifier));
  const expected = Buffer.from(challenge);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
