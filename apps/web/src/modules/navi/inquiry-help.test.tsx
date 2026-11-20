import { inquiryFaqReply } from '@one-line-desk/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FaqHint } from './Inquiries';
import { NextStepNote } from './InquirySheet';

// 후보 8(문의 양식 위 "지금 할 일" 원문)·후보 15(받은 IT 문의 FAQ 줄), 11/17. 자료는 모두 가상이에요(등급 0).

const STEP = '카드사 분실 신고 센터에 먼저 사용 정지를 요청하고, 재무팀 대표 메일로 카드 끝 네 자리와 분실 날짜를 보내 주세요.';

describe('후보 8: 문의 양식의 "지금 할 일"', () => {
  it('[후보 8][ADR-09] 분장표 원문을 고치지 않고 그대로 보여 주고, 빈 칸이면 아무것도 그리지 않아요', () => {
    const html = renderToStaticMarkup(<NextStepNote text={STEP} />);
    expect(html).toContain('지금 할 일');
    expect(html).toContain(STEP);
    expect(renderToStaticMarkup(<NextStepNote text='' />)).toBe('');
    expect(renderToStaticMarkup(<NextStepNote text='   ' />)).toBe('');
  });
});

describe('후보 15: 받은 IT 문의 FAQ 줄', () => {
  it('[후보 15] "이 FAQ가 맞아 보여요: <제목>"과 [답장에 FAQ 넣기]를 보여 줘요. AI 정리 표시는 없어요', () => {
    const faq = { title: "사내 와이파이 '인증에 실패했습니다'", steps: ['가상 단계 하나', '가상 단계 둘'] };
    const html = renderToStaticMarkup(<FaqHint hint={{ faqId: 'ITF-04', title: faq.title, ...inquiryFaqReply(faq) }} onFill={() => undefined} />);
    expect(html).toContain('이 FAQ가 맞아 보여요: 사내 와이파이 &#x27;인증에 실패했습니다&#x27;');
    expect(html).toContain('>답장에 FAQ 넣기</button>');
    expect(html).not.toContain('AI 정리');
    // 답장 글은 제목과 원문 단계 그대로예요.
    expect(inquiryFaqReply(faq).reply).toBe(`IT FAQ "${faq.title}"의 단계를 해 봐 주세요.\n1) 가상 단계 하나\n2) 가상 단계 둘`);
  });
});
