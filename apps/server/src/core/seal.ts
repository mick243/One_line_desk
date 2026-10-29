import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// 서버만 여는 봉인 값(AES-256-GCM). 화면·브라우저에 주지만 안을 읽지 못하게 할 때 써요(10/29 회의 A4).
// - 쓰임마다 서버 비밀에서 다른 키를 뽑아요(HKDF info). 한 쓰임의 값을 다른 쓰임에 넣으면 열리지 않아요.
// - aad(추가 인증 데이터)로 값을 받은 사람 같은 문맥에 묶어요. 문맥이 다르면 열리지 않아요.

export function sealKey(secret: string, use: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'one-line-desk', `${use}-seal-v1`, 32));
}

export function sealJson(key: Buffer, aad: string, payload: object): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

/** 봉인이 맞지 않거나 문맥(aad)이 다르면 null이에요. */
export function openJson(key: Buffer, aad: string, sealed: string): Record<string, unknown> | null {
  const raw = Buffer.from(sealed, 'base64url');
  if (raw.length < 12 + 16 + 2) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const value: unknown = JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
