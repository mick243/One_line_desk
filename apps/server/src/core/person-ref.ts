import { openJson, sealJson, sealKey } from './seal';

// 직원 검색 결과에서 사람을 가리키는 값(ADR-17). IdP 주체를 봉인해서 화면에 주고, 초대할 때 그대로 돌려받아요.
// - 화면·브라우저는 안을 읽지 못해요. IdP 주체(메일일 수도 있어요)는 화면에 내보내지 않아요(CLAUDE.md, 10/29 회의 A4).
// - 검색한 사람(가명 ID)에 묶어요. 남이 받은 값을 가져다 쓰거나, 고치거나 지어낸 값은 열리지 않아요.
// - 짧은 수명이 지나면 버려요. 화면은 "다시 골라 주세요"를 보여 줘요.

const PREFIX = 'pr_';
/** 검색해서 고르고 보내기까지 넉넉한 시간 */
export const PERSON_REF_TTL_MS = 30 * 60_000;

const keyCache = new Map<string, Buffer>();
function keyOf(secret: string): Buffer {
  let key = keyCache.get(secret);
  if (!key) keyCache.set(secret, (key = sealKey(secret, 'person-ref')));
  return key;
}

export function personRef(secret: string, idpSubject: string, owner: string, now: number): string {
  return PREFIX + sealJson(keyOf(secret), `person-ref|${owner}`, { s: idpSubject, e: now + PERSON_REF_TTL_MS });
}

/** 봉인이 맞고, 같은 사람이 받은 값이고, 수명 안이면 IdP 주체예요. 아니면 null이에요. */
export function readPersonRef(secret: string, ref: string, owner: string, now: number): string | null {
  if (!ref.startsWith(PREFIX)) return null;
  const value = openJson(keyOf(secret), `person-ref|${owner}`, ref.slice(PREFIX.length));
  if (!value || typeof value.s !== 'string' || typeof value.e !== 'number' || value.e < now) return null;
  return value.s;
}
