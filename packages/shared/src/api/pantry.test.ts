import { describe, expect, it } from 'vitest';
import { checkItemName, personNameWords } from './pantry';

describe('공개 판 품목 이름 검사', () => {
  // QA-4: 호칭 뒤에 조사가 붙어도 사람 이름으로 막아요.
  it.each([
    '하늘님이 좋아하는 커피',
    '하늘님께 드릴 과자',
    '하늘님의 녹차',
    '김가상 대리가 찾던 커피',
    '박가상 과장님이 좋아하는 쿠키',
    '팀장님도 마시는 두유',
    '도윤님한테 줄 젤리',
    '서연님을 위한 차',
  ])('%s → [사람 이름]', (name) => {
    const r = checkItemName(name);
    expect(r.ok).toBe(false);
    expect(r.blocked).toContain('person');
    // 막힘 이유에 이름 글자는 들어가지 않아요.
    expect(r.message).toBe('올릴 수 없는 글자가 있어요: [사람 이름]');
  });

  it('직원 명단 이름은 호칭이 없어도 막고, 다른 낱말 안에 든 것은 막지 않아요', () => {
    const personNames = ['하늘', '도윤'];
    expect(checkItemName('하늘 좋아하는 커피', { personNames }).blocked).toEqual(['person']);
    expect(checkItemName('하늘이 고른 쿠키', { personNames }).blocked).toEqual(['person']);
    expect(checkItemName('도윤씨가 찾던 과자', { personNames }).blocked).toEqual(['person']);
    expect(checkItemName('하늘보리 500ml', { personNames }).ok).toBe(true);
    // 명단이 없으면(브라우저) 호칭 없는 이름은 서버가 막아요.
    expect(checkItemName('하늘 좋아하는 커피').ok).toBe(true);
  });

  it('품목 이름은 막지 않아요', () => {
    for (const name of ['코카콜라 제로 355', '해바라기씨', '할머니 손맛 쿠키', '하늘보리', '팀 간식 믹스넛', '보리차 티백'])
      expect(checkItemName(name).ok, name).toBe(true);
  });

  it('막힘 이유를 전부 알려 줘요(QA-26)', () => {
    const r = checkItemName('하늘님이 010-1234-5678 알레르기 과자');
    expect(r.blocked).toEqual(expect.arrayContaining(['health', 'phone', 'person']));
    expect(r.message).toBe('올릴 수 없는 글자가 있어요: [건강 정보] [전화번호] [사람 이름]');
  });

  it('0폭·글 방향 문자와 제어 문자는 모양으로 막아요', () => {
    expect(checkItemName('녹\u200B차').blocked).toEqual(['shape']);
    expect(checkItemName('\u202E차녹').blocked).toEqual(['shape']);
    expect(checkItemName('녹차\u0000').blocked).toEqual(['shape']);
    expect(checkItemName('알\u200B레르기 없는 과자').blocked).toEqual(['health', 'shape']);
  });

  it('직원 이름에서 대조할 낱말을 뽑아요', () => {
    expect(personNameWords('가상 직원 하늘')).toEqual(['하늘']);
    expect(personNameWords('김 하늘')).toEqual(['하늘', '김하늘']);
    expect(personNameWords('수')).toEqual([]);
  });
});
