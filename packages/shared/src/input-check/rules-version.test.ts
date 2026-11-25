import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONTROL_CHAR, HEALTH_TERMS, INVISIBLE_CHARS, LOCK_RULES, MASK_RULES, RULES_VERSION } from './rules';

// 규칙을 바꾸고 RULES_VERSION을 올리지 않으면 서버가 "같은 판"이라 믿고 다른 규칙으로 다시 검사해요(CLAUDE.md "바꾸면 RULES_VERSION을 올려요").
// 규칙 내용의 지문을 판마다 적어 두고, 지금 지문이 지금 판의 줄과 같은지 봐요.
// 함수(Luhn 같은 confirm)는 변환 도구에 따라 글자가 달라져서 지문에 넣지 않고, check.test.ts의 동작 시험으로 지켜요.
// 규칙을 바꾸면: RULES_VERSION을 올리고, 아래 표에 새 판 줄을 더해요(시험 실패 메시지에 새 지문이 나와요). 이미 적은 줄은 고치지 않아요.
const KNOWN: Record<number, string> = {
  5: '4fb02ce3165b6dd6',
};

function fingerprint(): string {
  const re = (r: RegExp) => `${r.source}/${r.flags}`;
  const body = JSON.stringify({
    lock: LOCK_RULES.map((r) => [r.kind, r.name, re(r.pattern), r.confirm ? 'confirm' : '']),
    mask: MASK_RULES.map((r) => [r.kind, r.label, re(r.pattern)]),
    health: HEALTH_TERMS,
    invisible: re(INVISIBLE_CHARS),
    control: re(CONTROL_CHAR),
  });
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

describe('입력 검사 규칙 판', () => {
  it('규칙 내용이 바뀌면 RULES_VERSION도 올라가 있어요', () => {
    const now = fingerprint();
    const latest = Math.max(...Object.keys(KNOWN).map(Number));
    expect(RULES_VERSION, `표의 마지막 판(${latest})과 RULES_VERSION이 달라요. 새 판 줄을 표에 더해요`).toBe(latest);
    expect(now, `규칙이 바뀌었어요. RULES_VERSION을 ${RULES_VERSION + 1}로 올리고 표에 "${RULES_VERSION + 1}: '${now}'"를 더해요`).toBe(KNOWN[RULES_VERSION]);
  });

  it('판마다 지문이 달라요(규칙을 안 바꾸고 판만 올리지 않아요)', () => {
    const prints = Object.values(KNOWN);
    expect(new Set(prints).size).toBe(prints.length);
  });
});
