import { describe, expect, it } from 'vitest';
import { checkInput, hasControlChar, maskLine } from './check';
import { luhnValid } from './rules';
import { QA_LOCKED } from './samples';

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
    expect(r.masked).toEqual({ path: 0, email: 2, ip: 1 });
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

describe('입력 검사 규칙 2(QA-2·3·10·19)', () => {
  it.each(QA_LOCKED)('%s → 잠가요', (_name, text, kind) => {
    const r = checkInput(text);
    expect(r.rulesVersion).toBe(3);
    expect(r.locks.map((l) => l.kind)).toContain(kind);
  });

  it('0폭·글 방향 문자는 지운 글로 저장·표시해요', () => {
    expect(checkInput('\u202Egnp.exe 끝').text).toBe('gnp.exe 끝');
    expect(checkInput('회의\u200B실 \uFEFF예약').text).toBe('회의실 예약');
    expect(checkInput('\u202Egnp.exe 끝').locks).toEqual([]);
  });

  it('검사는 전각 글자를 반각으로 보지만, 저장 글의 한글 낱자는 그대로 둬요', () => {
    expect(checkInput('ㅋㅋ 감사해요').text).toBe('ㅋㅋ 감사해요');
  });

  it('제어 문자를 본문 어디서든 찾아요(줄바꿈·tab은 괜찮아요)', () => {
    expect(hasControlChar({ edits: { itemName: '녹차\u0000' } })).toBe(true);
    expect(hasControlChar(['a', { b: '\u001F' }])).toBe(true);
    expect(hasControlChar({ question: '첫 줄\n둘째 줄\t끝\r\n' })).toBe(false);
    expect(hasControlChar(42)).toBe(false);
  });

  it('카드 번호는 Luhn이 맞을 때만 잠가요', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(checkInput('주문번호 4111 1111 1111 1112').locks).toEqual([]);
  });

  // 담당 팀 문의·묻기에 흔히 오는 정상 문장. 하나도 잠기면 안 돼요(QA 검수 F-3).
  it.each([
    '법인카드를 잃어버렸어요. 정지는 어디서 해요?',
    '급여 계좌를 바꾸고 싶은데 어디서 신청해요?',
    '급여명세서는 매달 며칠에 나와요?',
    '이번 달 급여 3,500,000원이 덜 들어온 것 같아요',
    '입금 확인은 010-1234-5678로 연락 주시면 돼요',
    '계좌이체 영수증도 증빙으로 받나요?',
    '비밀번호를 잃어버렸어요',
    '비밀번호 재설정 메일이 안 와요',
    '비밀번호 8자리 이상이어야 하나요?',
    '비밀번호 변경 주기가 90일인가요?',
    'VPN 비번 초기화는 누가 해 줘요?',
    '병가 신청은 어디서 해요?',
    '5천 식대 기준이 바뀌었나요?',
    '10월 30일 오후 3시에 6명 회의실 있어요?',
    '내선 1234로 전화했는데 안 받아요',
    '사번 20231234인데 출입증이 안 찍혀요',
    '택배 송장번호 6012345678901 조회는 어디서 해요?',
    '거래처 사업자등록번호 123-45-67890 등록 요청이요',
    '출장비 정산 마감이 언제예요?',
    '여권 사본을 출장 서류에 내야 하나요?',
    '노트북 자산번호 NB-2024-0193 반납하려고요',
    '모니터 하나 더 받을 수 있나요?',
    '명함 200장 다시 주문하고 싶어요',
    '연차 반차 쓰는 법 알려 주세요',
    '주차 등록 차량번호 12가 3456 바꾸려고요',
    '카드 한도 300만 원으로 올려 주세요',
    '회의실 프로젝터가 안 켜져요',
    '탕비실 커피 원두 떨어졌어요',
    '고객사 대표번호 1588-1234로 안내해도 되나요?',
    '2026-10-27 10:00 교육 장소가 어디예요?',
  ])('정상 문장은 잠그지 않아요: %s', (text) => {
    expect(checkInput(text).locks).toEqual([]);
  });
});

describe('입력 검사 규칙 3: 사용자 폴더 경로 가림(넓힐 후보 ②)', () => {
  it.each([
    [String.raw`C:\Users\kimgaram\AppData\Local\Temp\setup.log 를 열 수 없어요`, String.raw`[사용자 폴더]\AppData\Local\Temp\setup.log 를 열 수 없어요`],
    ['파일 c:/users/gaon.lee/Desktop/report.xlsx 저장 실패', '파일 [사용자 폴더]/Desktop/report.xlsx 저장 실패'],
    ['/home/dev01/.ssh/config: permission denied', '[사용자 폴더]/.ssh/config: permission denied'],
    ['open /Users/nara/Library/Logs/app.log failed', 'open [사용자 폴더]/Library/Logs/app.log failed'],
    [String.raw`C:\Documents and Settings\park\NTUSER.DAT`, String.raw`[사용자 폴더]\NTUSER.DAT`],
  ])('%s', (raw, masked) => {
    const r = checkInput(raw);
    expect(r.locks).toEqual([]);
    expect(r.text).toBe(masked);
    expect(r.masked.path).toBe(1);
  });

  it('가림 줄에 사용자 폴더 수가 나와요', () => {
    expect(maskLine(checkInput(String.raw`C:\Users\a\x 와 /home/b/y`))).toBe('사용자 폴더 2곳을 [사용자 폴더]로 바꿔 보내요');
  });

  it.each([String.raw`C:\Program Files\App\app.exe 오류`, 'https://example.com/home/index.html 이 안 열려요', '0x80070005 접근 거부', '/var/log/syslog 확인'])(
    '사용자 폴더가 아닌 경로는 그대로 둬요: %s',
    (raw) => {
      const r = checkInput(raw);
      expect(r.masked.path).toBe(0);
      expect(r.text).toBe(raw);
    },
  );
});
