import { describe, expect, it } from 'vitest';
import { isCommand, loanKindsIn, roomChatPreview, withoutLoanWords } from './rooms-chat';
import { AUTO_SENTENCES, NO_AUTO_SENTENCES } from './rooms-chat-samples';

// 회의실 입력 칸 미리 알림(10/28 통합 개편). 서버 자동 실행은 isCommand가 참일 때만이라,
// 미리 알림이 "찾기만"이면 서버도 바로 실행하지 않아요.

describe('회의실 입력 칸 미리 알림', () => {
  it.each([
    ['내일 3시 6명', 'ask'],
    ['내일 3시 6명 빈 방 있어?', 'ask'],
    ['내일 3시 6명 잡아 줄 수 있어?', 'ask'],
    ['3C 장비 뭐 있어?', 'ask'],
    ['내일 예약 취소해 줘', 'cancel'],
    ['빔프로젝터 반납할게', 'cancel'],
  ])('"%s" → %s', (text, preview) => {
    expect(roomChatPreview(text)).toBe(preview);
  });

  it.each(AUTO_SENTENCES)('바로 실행: "%s" → %s', (text, preview) => {
    expect(roomChatPreview(text)).toBe(preview);
    expect(isCommand(text)).toBe(true);
  });

  it.each(NO_AUTO_SENTENCES)('바로 실행 안 함: "%s"', (text) => {
    expect(roomChatPreview(text)).not.toMatch(/^may-run-/);
  });

  it('미리 알림이 "찾기만"이면 서버의 시키는 문장 판정도 거짓이에요', () => {
    for (const text of [
      '내일 3시 6명',
      '빈 방 있어?',
      '잡아 줄 수 있어?',
      '오늘 회의실 현황',
      '내일 3시 6명 빈 회의실 알려 줘',
      '회의실 잡지 말고 보기만 할게',
    ]) {
      expect(roomChatPreview(text)).toBe('ask');
      expect(isCommand(text)).toBe(false);
    }
  });

  it('장비 이름을 읽고, 방 조건에서 지울 수 있어요', () => {
    expect(loanKindsIn('노트북이랑 무선 마이크, HDMI 젠더')).toEqual(['노트북', '무선 마이크', 'HDMI 젠더']);
    expect(withoutLoanWords('3시 6명 잡고 빔프로젝터도 빌려 줘')).not.toMatch(/프로젝터|빔/);
  });
});
