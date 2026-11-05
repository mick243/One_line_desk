import { describe, expect, it } from 'vitest';
import type { AiGateway } from '../../core/ai/gateway';
import { MOCK_BOARD, NOTICE_BODY_CANARY } from './fixtures';
import { pickByRules, quoteFor, sentencesOf } from './quote';

// 공지 "원문 한 줄"(11/5 사용자 결정). AI는 문장 번호만 고르고, 서버가 본문 문장을 그대로 그려요.

const body = MOCK_BOARD.find((n) => n.id === 'N-1002')!.body;
const gateway = (pick: number | Error, modelBacked = true) =>
  ({
    modelBacked,
    structured: async () => {
      if (pick instanceof Error) throw pick;
      return { pick };
    },
  }) as unknown as AiGateway;

describe('공지 원문 한 줄', () => {
  it('본문을 문장으로 나누고, 문장이 아닌 조각(카나리 문자열 같은 것)은 고를 수 없게 빼요', () => {
    const sentences = sentencesOf(body);
    expect(sentences).toEqual(['하반기 정기 건강검진은 11월 3일부터 11월 28일까지예요.', '검진 기관 예약은 복지몰에서 해요.']);
    expect(sentences.join(' ')).not.toContain(NOTICE_BODY_CANARY);
  });

  it('낱말 규칙: 때를 물으면 날짜가 든 문장, 곳·방법을 물으면 그 문장을 골라요', () => {
    const sentences = sentencesOf(body);
    expect(pickByRules('건강검진 언제까지야?', sentences)).toBe(0);
    expect(pickByRules('검진 기관 예약은 어디서 해?', sentences)).toBe(1);
  });

  it('AI가 고른 번호의 문장을 고치지 않고 그대로 줘요. 번호가 틀리거나 실패하면 규칙으로 고른 문장이고 AI 정리가 없어요', async () => {
    expect(await quoteFor(gateway(2), '검진 어디서 예약해?', '하반기 건강검진 일정 안내', body)).toEqual({
      sentence: '검진 기관 예약은 복지몰에서 해요.',
      byModel: true,
    });
    expect(await quoteFor(gateway(9), '건강검진 언제까지야?', '하반기 건강검진 일정 안내', body)).toEqual({
      sentence: '하반기 정기 건강검진은 11월 3일부터 11월 28일까지예요.',
      byModel: false,
    });
    expect(await quoteFor(gateway(new Error('timeout')), '건강검진 언제까지야?', '하반기 건강검진 일정 안내', body)).toEqual({
      sentence: '하반기 정기 건강검진은 11월 3일부터 11월 28일까지예요.',
      byModel: false,
    });
    expect(await quoteFor(gateway(1), '아무거나', '제목', NOTICE_BODY_CANARY)).toBeNull();
  });
});
