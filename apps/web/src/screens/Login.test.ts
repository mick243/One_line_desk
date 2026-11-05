import { describe, expect, it } from 'vitest';
import { roleLine } from './Login';

// 시연 로그인 화면의 역할 한 줄(11/5 처음 쓰는 직원 점검: "팀장 — 도 볼 수 있어요"처럼 글자가 비었어요).
describe('가상 직원 역할 한 줄', () => {
  it('역할마다 더 볼 수 있는 것을 말하고, 빈 설명이 나오지 않아요', () => {
    expect(roleLine(['employee'])).toBe('직원 화면');
    expect(roleLine(['employee', 'team-lead'])).toBe('팀장 — 여러 팀 회의 참석자 고르기·팀 회의 담당자도 볼 수 있어요');
    expect(roleLine(['employee', 'chart-owner', 'operator'])).toBe('분장표 주인·운영자 — 분장표 수정 제안함, 운영 설정도 볼 수 있어요');
    for (const roles of [['team-lead'], ['facilities'], ['chart-owner'], ['operator']] as const) expect(roleLine([...roles])).not.toMatch(/— 도|— ,/);
  });
});
