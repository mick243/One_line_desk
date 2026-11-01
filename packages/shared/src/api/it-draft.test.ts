import { describe, expect, it } from 'vitest';
import { INQUIRY_QUESTION_MAX, itInquiryDraft } from './navi';

describe('IT 문의 초안(11/1 QA M5)', () => {
  it('긴 오류 글은 앞을 줄이고 끝(원인)을 남겨요', () => {
    const text = `${'앞부분 '.repeat(300)}마지막 원인 0x80070005`;
    const draft = itInquiryDraft({ maskedText: text, faqTitle: '윈도 업데이트' });
    expect(draft.length).toBeLessThanOrEqual(INQUIRY_QUESTION_MAX);
    expect(draft.endsWith('마지막 원인 0x80070005')).toBe(true);
    expect(draft).toContain('오류 글(개인정보를 가린 글):\n…');
  });

  it('짧은 글은 그대로 넣어요', () => {
    expect(itInquiryDraft({ maskedText: '와이파이 인증 실패' })).toBe('비슷한 IT FAQ를 찾지 못했어요.\n\n오류 글(개인정보를 가린 글):\n와이파이 인증 실패');
  });
});
