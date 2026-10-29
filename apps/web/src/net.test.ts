import { describe, expect, it } from 'vitest';
import { isOtherBuild, newRequestId, OFFLINE_MESSAGE, UNAVAILABLE_MESSAGE, unavailableMessage } from './net';

// 배포 중 화면 문구와 새 판 알아채기(10/29 배포 준비 회의 D1·D2).

describe('우리 서버가 답하지 않은 응답은 정해진 문구로 바꿔요', () => {
  it.each([
    [0, false, OFFLINE_MESSAGE],
    [502, false, UNAVAILABLE_MESSAGE],
    [503, true, UNAVAILABLE_MESSAGE],
    [504, false, UNAVAILABLE_MESSAGE],
    [404, false, UNAVAILABLE_MESSAGE],
    [500, false, UNAVAILABLE_MESSAGE],
  ])('상태 %i, JSON %s → 정해진 문구', (status, isJson, message) => {
    expect(unavailableMessage(status, isJson)).toBe(message);
  });

  it.each([
    [200, true],
    [204, false],
    [401, true],
    [404, true],
    [422, true],
    [500, true],
  ])('상태 %i, JSON %s → 서버 글을 그대로 써요', (status, isJson) => {
    expect(unavailableMessage(status, isJson)).toBeNull();
  });
});

describe('요청 번호는 https가 아니어도 만들어요(배포 준비 회의 D4)', () => {
  it('randomUUID가 있으면 쓰고, 없으면 getRandomValues로 서버가 받는 모양을 만들어요', () => {
    expect(newRequestId()).toMatch(/^[0-9a-f-]{36}$/);
    // http(보안 맥락이 아님) 브라우저처럼 randomUUID가 없는 crypto
    const insecure = { getRandomValues: crypto.getRandomValues.bind(crypto) };
    const id = newRequestId(insecure);
    // 서버 패턴: 문의 ^[A-Za-z0-9-]{8,64}$, 채팅·초대 ^[A-Za-z0-9_-]{8,64}$
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(newRequestId(insecure)).not.toBe(id);
  });
});

describe('서버가 알려 준 판이 다르면 새 버전이에요', () => {
  it.each([
    ['b2', 'b1', true],
    ['b1', 'b1', false],
    [null, 'b1', false],
    ['', 'b1', false],
    ['dev', 'b1', false],
    ['b2', 'dev', false],
  ])('서버 %s · 화면 %s → %s', (server, web, other) => {
    expect(isOtherBuild(server, web)).toBe(other);
  });
});
