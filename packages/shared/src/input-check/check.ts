import {
  CONTROL_CHAR,
  HEALTH_TERMS,
  INVISIBLE_CHARS,
  LOCK_MESSAGE,
  LOCK_RULES,
  type LockRule,
  MASK_NAME,
  MASK_RULES,
  RULES_VERSION,
  type LockKind,
  type MaskKind,
} from './rules';

export interface InputCheckResult {
  rulesVersion: number;
  /** 하나라도 있으면 보내지 않아요. */
  locks: { kind: LockKind; message: string }[];
  /** 0폭·글 방향 문자를 지우고 가린 뒤의 글자. 잠긴 경우에도 화면에서 지울 곳을 알려 주려고 계산해요. */
  text: string;
  masked: Record<MaskKind, number>;
}

/**
 * 저장·표시할 글: 화면에 안 보이는 0폭·글 방향 문자를 지워요.
 * NFKC는 검사에만 써요. 저장 글까지 바꾸면 "ㅋㅋ" 같은 한글 낱자가 다른 글자로 바뀌어요.
 */
export function normalizeInput(raw: string): string {
  return raw.replace(INVISIBLE_CHARS, '');
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HEALTH_PATTERNS = HEALTH_TERMS.map((term) => new RegExp(term.split(/\s+/).map(escape).join('\\s*')));

function hits(rule: LockRule, text: string): boolean {
  if (!rule.confirm) return rule.pattern.test(text);
  for (const m of text.matchAll(new RegExp(rule.pattern.source, `${rule.pattern.flags}g`))) if (rule.confirm(m[0])) return true;
  return false;
}

export function checkInput(raw: string): InputCheckResult {
  const clean = normalizeInput(raw);
  // 전각 숫자(９００１０１)·전각 기호도 같은 규칙에 걸리게 검사용 글만 NFKC로 바꿔요.
  const probe = clean.normalize('NFKC');
  const lockKinds = new Set<LockKind>();
  for (const rule of LOCK_RULES) {
    if (hits(rule, probe)) lockKinds.add(rule.kind);
  }
  if (HEALTH_PATTERNS.some((p) => p.test(probe))) lockKinds.add('health');

  const masked: Record<MaskKind, number> = { path: 0, email: 0, ip: 0 };
  let text = clean;
  for (const rule of MASK_RULES) {
    text = text.replace(rule.pattern, () => {
      masked[rule.kind] += 1;
      return rule.label;
    });
  }

  return {
    rulesVersion: RULES_VERSION,
    locks: [...lockKinds].map((kind) => ({ kind, message: LOCK_MESSAGE[kind] })),
    text,
    masked,
  };
}

/** 요청 본문·쿼리 어디에든 제어 문자가 든 글자가 있는지 봐요. 서버가 모든 경로 앞에서 400으로 돌려보낼 때 써요. */
export function hasControlChar(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return CONTROL_CHAR.test(value);
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => hasControlChar(v, depth + 1));
  return Object.entries(value).some(([k, v]) => CONTROL_CHAR.test(k) || hasControlChar(v, depth + 1));
}

/** 입력 칸 바로 아래 "가림 줄" 문구. 가린 게 없으면 null이에요. */
export function maskLine(result: InputCheckResult): string | null {
  const parts = (Object.keys(result.masked) as MaskKind[]).filter((k) => result.masked[k] > 0);
  if (parts.length === 0) return null;
  const counts = parts.map((k) => `${MASK_NAME[k]} ${result.masked[k]}곳`).join(', ');
  const labels = parts.map((k) => `[${MASK_NAME[k]}]`).join(' · ');
  return `${counts}을 ${labels}로 바꿔 보내요`;
}
