import { describe, expect, it } from 'vitest';
import { checkInput, maskLine } from './check';

describe('공통 입력 검사', () => {
  it('평범한 질문은 그대로 보내요', () => {
    const r = checkInput('법인카드 잃어버렸어요');
    expect(r.locks).toEqual([]);
    expect(r.text).toBe('법인카드 잃어버렸어요');
    expect(maskLine(r)).toBeNull();
  });

  it('이메일과 IP는 가린 뒤 보내요', () => {
    const r = checkInput('kim@example.com 에서 10.0.0.12 접속이 안 돼요, lee@corp.co.kr 도요');
    expect(r.locks).toEqual([]);
    expect(r.text).toBe('[이메일] 에서 [IP] 접속이 안 돼요, [이메일] 도요');
    expect(r.masked).toEqual({ email: 2, ip: 1 });
    expect(maskLine(r)).toBe('이메일 2곳, IP 1곳을 [이메일] · [IP]로 바꿔 보내요');
  });

  it.each([
    ['AWS 키', '키가 AKIAABCDEFGHIJKLMNOP 인데 안 돼요'],
    ['GitHub 토큰', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789 로그인 실패'],
    ['Slack 토큰', 'xoxb-1234567890-abcdefghij 가 안 먹어요'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N 오류'],
    ['긴 무작위 문자열', 'a8f3k2m9q1w7e5r4t6y0u2i8o3p1s9d7f 이게 뭔가요'],
  ])('%s처럼 보이면 잠가요', (_name, text) => {
    expect(checkInput(text).locks.map((l) => l.kind)).toEqual(['key-token']);
  });

  it('주민번호와 비밀번호 값은 등급 3으로 막아요', () => {
    expect(checkInput('900101-1234567 로 조회해 주세요').locks.map((l) => l.kind)).toEqual(['grade3']);
    expect(checkInput('비밀번호: hunter2 맞나요').locks.map((l) => l.kind)).toEqual(['grade3']);
  });

  it('비밀번호를 잃어버렸다는 말은 막지 않아요', () => {
    expect(checkInput('비밀번호를 잃어버렸어요').locks).toEqual([]);
  });

  it('건강 정보는 막고, 병가 같은 제도 이름은 막지 않아요', () => {
    expect(checkInput('땅콩 알레르기가 있어서 간식 빼 주세요').locks.map((l) => l.kind)).toEqual(['health']);
    expect(checkInput('병가 신청은 어디서 해요?').locks).toEqual([]);
  });
});
