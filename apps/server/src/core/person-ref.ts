import { createHmac, timingSafeEqual } from 'node:crypto';

// 직원 검색 결과에서 사람을 가리키는 값(ADR-17). IdP 주체에 서명을 붙여 화면에 주고, 초대할 때 그대로 돌려받아요.
// 서명이 맞지 않으면 버려서, 지어낸 값으로 아무나 부를 수 없어요.

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(`person-ref|${body}`).digest('base64url').slice(0, 22);

export function personRef(secret: string, idpSubject: string): string {
  const body = Buffer.from(idpSubject, 'utf8').toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

export function readPersonRef(secret: string, ref: string): string | null {
  const [body, sig, extra] = ref.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return Buffer.from(body, 'base64url').toString('utf8');
}
