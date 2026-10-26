import { describe, expect, it } from 'vitest';
import { ProposalTokens } from './proposal-token';
import { extractItemName, parseDate, parseSlots, parseTime } from './slots';

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
  ])('날짜: %s → %s', (text, date) => {
    expect(parseDate(text, '2026-10-26')).toBe(date);
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
  ])('시각: %s → %s', (text, time) => {
    expect(parseTime(text)).toBe(time);
  });

  it.each([
    ['제로콜라 또 넣어 주세요', '제로콜라'],
    ['탕비실에 녹차 티백 좀 채워 주세요', '녹차 티백'],
    ['코카콜라 제로 355 요청', '코카콜라 제로 355'],
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
