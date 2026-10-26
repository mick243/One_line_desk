import { describe, expect, it } from 'vitest';
import { ProposalTokens } from './proposal-token';
import { extractItemName, parseSlots } from './slots';

const NOW = Date.parse('2026-10-26T09:00:00+09:00');

describe('슬롯 뽑기', () => {
  it.each([
    ['내일 오후 3시 반 6명', { date: '2026-10-27', start: '15:30', people: 6 }],
    ['10월 30일 오전 10시 2시간 4층', { date: '2026-10-30', start: '10:00', minutes: 120, floor: '4층' }],
    ['오늘 2시 화상회의랑 화이트보드 되는 방', { date: '2026-10-26', start: '14:00', equipment: ['화상회의', '화이트보드'] }],
  ])('%s', (text, expected) => {
    expect(parseSlots(text, NOW)).toMatchObject(expected);
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
