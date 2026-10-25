import { createHmac } from 'node:crypto';

// 가명 ID = IdP 식별자에 서버 비밀 키로 만든 값(ADR-10). 거꾸로 사람을 찾을 수 없어요.
export function pseudonymize(secret: string, idpSubject: string): string {
  return 'p_' + createHmac('sha256', secret).update(idpSubject).digest('hex').slice(0, 24);
}
