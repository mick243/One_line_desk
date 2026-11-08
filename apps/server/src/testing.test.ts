import { describe, expect, it } from 'vitest';
import { expectNoSecrets, withoutRandomTokens } from './testing';

// 흔들리던 시험 고침(11/8): 감사 로그 plan_id UUID에 "8000"이 우연히 섞이면 금액이 샌 것처럼 보였어요.
describe('시험 도우미 expectNoSecrets', () => {
  const uuidWith8000 = '3f2a9c1e-7b4d-4e21-8000-5c6d7e8f9a0b';
  const pseudonym = 'p_8000aa11bb22cc33dd44ee55';

  it('UUID·가명 ID·긴 숫자 안에 우연히 섞인 금액 숫자는 유출로 보지 않아요', () => {
    const text = JSON.stringify([{ id: '1', at: '2026-11-08T08:49:50.800Z', pseudonym_id: pseudonym, plan_id: uuidWith8000, leftMs: 1794118000000 }]);
    expect(withoutRandomTokens(text)).not.toContain('8000');
    expectNoSecrets(text, ['8000']);
  });

  it('진짜 금액·이름·가명 ID 유출은 그대로 잡아요', () => {
    expect(() => expectNoSecrets(JSON.stringify({ totalWon: 8000 }), ['8000'])).toThrow();
    expect(() => expectNoSecrets('8000원을 냈어요', ['8000'])).toThrow();
    expect(() => expectNoSecrets(JSON.stringify({ name: '가상 직원 하늘' }), ['하늘'])).toThrow();
    // 가명 ID 같은 글자 비밀값은 무작위 글자를 지우기 전 원문에서 찾아요.
    expect(() => expectNoSecrets(JSON.stringify({ who: pseudonym }), [pseudonym])).toThrow();
  });
});
