import { HEALTH_TERMS, LOCK_MESSAGE, LOCK_RULES, MASK_NAME, MASK_RULES, RULES_VERSION, type LockKind, type MaskKind } from './rules';

export interface InputCheckResult {
  rulesVersion: number;
  /** 하나라도 있으면 보내지 않아요. */
  locks: { kind: LockKind; message: string }[];
  /** 가린 뒤의 글자. 잠긴 경우에도 화면에서 지울 곳을 알려 주려고 계산해요. */
  text: string;
  masked: Record<MaskKind, number>;
}

export function checkInput(raw: string): InputCheckResult {
  const lockKinds = new Set<LockKind>();
  for (const rule of LOCK_RULES) {
    if (rule.pattern.test(raw)) lockKinds.add(rule.kind);
  }
  if (HEALTH_TERMS.some((term) => raw.includes(term))) lockKinds.add('health');

  const masked: Record<MaskKind, number> = { email: 0, ip: 0 };
  let text = raw;
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

/** 입력 칸 바로 아래 "가림 줄" 문구. 가린 게 없으면 null이에요. */
export function maskLine(result: InputCheckResult): string | null {
  const parts = (Object.keys(result.masked) as MaskKind[]).filter((k) => result.masked[k] > 0);
  if (parts.length === 0) return null;
  const counts = parts.map((k) => `${MASK_NAME[k]} ${result.masked[k]}곳`).join(', ');
  const labels = parts.map((k) => `[${MASK_NAME[k]}]`).join(' · ');
  return `${counts}을 ${labels}로 바꿔 보내요`;
}
