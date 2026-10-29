import { describe, expect, it } from 'vitest';
import { ProposalTokens } from './proposal-token';
import { extractItemName, parseDate, parseSlots, parseTime, repeatedSlots } from './slots';

const NOW = Date.parse('2026-10-26T09:00:00+09:00');

describe('슬롯 뽑기', () => {
  it.each([
    ['내일 오후 3시 반 6명', { date: '2026-10-27', start: '15:30', people: 6 }],
    ['10월 30일 오전 10시 2시간 4층', { date: '2026-10-30', start: '10:00', minutes: 120, floor: '4층' }],
    ['오늘 2시 화상회의랑 화이트보드 되는 방', { date: '2026-10-26', start: '14:00', equipment: ['화상회의', '화이트보드'] }],
    ['2시간 회의실 내일 오전 11시', { date: '2026-10-27', start: '11:00', minutes: 120 }],
  ])('%s', (text, expected) => {
    expect(parseSlots(text, NOW)).toMatchObject(expected);
  });

  // AI 접목 회의 QA 실측에서 규칙이 놓치거나 조용히 틀렸던 말(QA-6·12, R-1). NOW = 2026-10-26(월) 09:00
  it.each([
    ['낼 3시 4명 회의실', { date: '2026-10-27', start: '15:00', people: 4 }],
    ['내일 3시 4명 30분', { minutes: 30 }],
    ['내일 3시 4명 45분만', { minutes: 45 }],
    ['모레 오후 4시 6명 1시간 반', { date: '2026-10-28', start: '16:00', minutes: 90 }],
    ['내일 10시 1시간 30분 4명', { start: '10:00', minutes: 90 }],
    ['내일 3시 90분 회의 4명', { start: '15:00', minutes: 90 }],
    ['내일 3시 30분 회의 4명', { start: '15:30' }],
    ['내일 3시부터 5시까지 4명', { start: '15:00', minutes: 120 }],
    ['내일 15:00-16:30 4명', { start: '15:00', minutes: 90 }],
    ['내일 오후 2시에서 3시 반까지', { start: '14:00', minutes: 90 }],
    ['내일 11시부터 1시까지', { start: '11:00', minutes: 120 }],
    ['내일 오후 세시 네명', { start: '15:00', people: 4 }],
    ['다섯 명 두 시간 내일 10시', { people: 5, minutes: 120, start: '10:00' }],
    ['둘이서 내일 2시', { people: 2, start: '14:00' }],
    ['내일 아침 9시 반에 대여섯 명', { start: '09:30', people: 6 }],
    ['다음 달 30일 2시 4명', { date: '2026-11-30', start: '14:00' }],
    ['지금 바로 4명', { date: '2026-10-26', start: '09:00', people: 4 }],
    ['30분 뒤에 4명', { date: '2026-10-26', start: '09:30' }],
    ['내일 점심시간에 4명', { date: '2026-10-27', start: '12:00' }],
    ['내일 3시 4명 회의실, 프로젝터 말고 화이트보드 있는 곳', { equipment: ['화이트보드'] }],
    ['내일 3시 4명 4층 화면 없는 곳', { floor: '4층' }],
  ])('규칙 보강: %s', (text, expected) => {
    expect(parseSlots(text, NOW)).toMatchObject(expected);
  });

  it('조용히 틀리던 것: "7시"는 되묻고, "3층 말고"·"프로젝터 말고"는 그 조건을 넣지 않아요', () => {
    expect(parseSlots('내일 7시 4명 회의실', NOW).start).toBeUndefined();
    expect(parseSlots('내일 3시 4명 회의실 3층 말고 다른 층', NOW).floor).toBeUndefined();
    expect(parseSlots('내일 3시 4명 4층 화면 없는 곳', NOW).equipment).toBeUndefined();
    expect(parseSlots('내일 3시 4명 2시간 뒤에 끝나요', NOW).minutes).toBeUndefined();
  });

  // 2026-10-26은 월요일이에요. 한 주는 월요일에 시작해요.
  it.each([
    ['다음 주 화요일 10시 4명', '2026-11-03'],
    ['다음주 화요일', '2026-11-03'],
    ['담주 목욜', '2026-11-05'],
    ['이번 주 금요일 오후 2시', '2026-10-30'],
    ['이번주 금', '2026-10-30'],
    ['다다음 주 수요일', '2026-11-11'],
    ['지난주 월요일', '2026-10-19'],
    ['금요일 3시', '2026-10-30'],
    ['월요일 9시', '2026-10-26'],
    ['일요일', '2026-11-01'],
    ['이번 주말', '2026-10-31'],
    ['다음 주말', '2026-11-07'],
    ['3일 뒤 10시', '2026-10-29'],
    ['일주일 후', '2026-11-02'],
    ['2주 뒤', '2026-11-09'],
    ['11/3 15:30', '2026-11-03'],
    ['2026.11.04', '2026-11-04'],
    ['30일 2시', '2026-10-30'],
    ['5일 오전', '2026-11-05'],
    ['1월 5일', '2027-01-05'],
    ['글피', '2026-10-29'],
    ['모레 오후', '2026-10-28'],
    ['3일 동안 쓸 방', undefined],
    ['2월 30일', undefined],
    ['다음 주에 회의실', undefined],
    ['다음 달 30일', '2026-11-30'],
    ['이번 달 30일', '2026-10-30'],
    ['다다음 달 1일', '2026-12-01'],
    ['낼 오후', '2026-10-27'],
    // 요일 글자 뒤에 다른 한글이 오면 요일이 아니에요(10/29 회의 A1)
    ['다음 주 화상회의', undefined],
    ['이번 주 일정', undefined],
    ['다음 주 금 3시', '2026-11-06'],
  ])('날짜: %s → %s', (text, date) => {
    expect(parseDate(text, '2026-10-26')).toBe(date);
  });

  it.each([
    ['내일 3시 6명', []],
    ['내일 오후 3시부터 5시까지 6명', []],
    ['내일 15:00 회의 3시 6명', []],
    ['1시간 30분 회의 내일 3시 6명', []],
    ['내일 3시나 4시에 6명', ['시각']],
    ['내일 3시 6명이나 8명', ['인원']],
    ['6인용 회의실 내일 3시 4명', []],
    ['내일 10시 20분이나 11시에 4명이나 5명', ['시각', '인원']],
  ])('같은 칸 값 둘: %s → %s', (text, slots) => {
    expect(repeatedSlots(text)).toEqual(slots);
  });

  it.each([
    ['내일 15:30', '15:30'],
    ['저녁 7시', '19:00'],
    ['아침 8시 반', '08:30'],
    ['점심 1시', '13:00'],
    ['정오에', '12:00'],
    ['10시 20분', '10:20'],
    ['3시', '15:00'],
    ['2시간짜리', undefined],
    ['7시', undefined],
    ['오전 7시', '07:00'],
    ['세시', '15:00'],
    ['오후 두 시 반', '14:30'],
  ])('시각: %s → %s', (text, time) => {
    expect(parseTime(text)).toBe(time);
  });

  it.each([
    ['제로콜라 또 넣어 주세요', '제로콜라'],
    ['탕비실에 녹차 티백 좀 채워 주세요', '녹차 티백'],
    ['코카콜라 제로 355 요청', '코카콜라 제로 355'],
    ['010-1234-5678 로 연락주시면 컵라면', '컵라면'],
    ['컵라면 요청이요 kim@example.com 으로 연락 주세요', '컵라면'],
    ['[이메일] 로 연락 부탁해요 녹차 티백', '녹차 티백'],
  ])('%s → %s', (text, item) => {
    expect(extractItemName(text)).toBe(item);
  });
});

describe('제안 토큰(M3)', () => {
  let clock = NOW;
  const tokens = new ProposalTokens(
    'secret',
    () => clock,
    () => 60_000,
  );

  it('주인·서명·만료를 검사해요', () => {
    const token = tokens.sign('p_me', 'rooms', 'reserve', { roomId: 'r1' });
    expect(tokens.verify(token, 'p_me')).toMatchObject({ ok: true, payload: { m: 'rooms', a: 'reserve', p: { roomId: 'r1' } } });
    expect(tokens.verify(token, 'p_other')).toMatchObject({ ok: false, reason: 'owner' });
    expect(tokens.verify(`${token}x`, 'p_me')).toMatchObject({ ok: false, reason: 'bad' });
    const [body] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), u: 'p_other' })).toString('base64url');
    expect(tokens.verify(`${forged}.${token.split('.')[1]}`, 'p_other')).toMatchObject({ ok: false, reason: 'bad' });
    clock += 61_000;
    expect(tokens.verify(token, 'p_me')).toMatchObject({ ok: false, reason: 'expired', payload: { p: { roomId: 'r1' } } });
  });
});
