import { DEFAULT_OPS_SETTINGS, type OpsSettings } from '@one-line-desk/shared';
import { describe, expect, it } from 'vitest';
import { availableTools, canRunMcp, isAllMockData, isClientAllowed, scopesOf } from './policy';
import { cleanText } from './tools';
import { pkceChallenge, pkceMatches, TokenKit } from './tokens';

// 정책·토큰 도구 단위 시험(ADR-12·14·15).

const settings = (patch: Partial<OpsSettings> = {}): OpsSettings => ({ ...structuredClone(DEFAULT_OPS_SETTINGS), mcp: true, ...patch });

describe('계약 전 잠금과 허용 목록', () => {
  it('[ADR-12·15 시험] 실제 어댑터 + 허용 목록(보안팀 승인) 비어 있음이면 MCP를 켜지 않아요', () => {
    expect(canRunMcp({ switchOn: true, allMockData: false, approvedClients: 0 })).toBe(false);
    expect(canRunMcp({ switchOn: true, allMockData: false, approvedClients: 1 })).toBe(true);
    expect(canRunMcp({ switchOn: true, allMockData: true, approvedClients: 0 })).toBe(true);
    expect(canRunMcp({ switchOn: false, allMockData: true, approvedClients: 3 })).toBe(false);
  });

  it('[MCP 요구 4] 시연용 클라이언트는 데이터가 모두 모의일 때만 허용 목록 안이에요', () => {
    const demo = { securityApproved: false, demoOnly: true };
    expect(isClientAllowed(demo, true)).toBe(true);
    expect(isClientAllowed(demo, false)).toBe(false);
    expect(isClientAllowed({ securityApproved: true, demoOnly: false }, false)).toBe(true);
    expect(isClientAllowed({ securityApproved: false, demoOnly: false }, true)).toBe(false);
    expect(isAllMockData([{ name: 'a', label: 'a', mock: true }])).toBe(true);
    expect(
      isAllMockData([
        { name: 'a', label: 'a', mock: true },
        { name: 'b', label: 'b', mock: false },
      ]),
    ).toBe(false);
  });

  it('[MCP-7] MCP 끔이면 도구가 없고, 모듈이 링크만·끔이면 그 범위가 빠져요', () => {
    expect(availableTools(settings(), false)).toEqual([]);
    expect(availableTools(settings({ mcp: false }), true)).toEqual([]);
    expect(scopesOf(availableTools(settings(), true))).toEqual(['rooms.read', 'notices.read']);
    const roomsLink = settings({ modules: { ...DEFAULT_OPS_SETTINGS.modules, rooms: 'link' } });
    expect(scopesOf(availableTools(roomsLink, true))).toEqual(['notices.read']);
    const bothOff = settings({ modules: { ...DEFAULT_OPS_SETTINGS.modules, rooms: 'off', notices: 'link' } });
    expect(scopesOf(availableTools(bothOff, true))).toEqual([]);
  });
});

describe('토큰 도구', () => {
  it('[ADR-15 시험] 봉인한 토큰은 고치면 열리지 않고, 다른 종류 자리에도 쓸 수 없어요', () => {
    const kit = new TokenKit('test-secret-0000000000000000000000');
    const token = kit.seal('access', { a: 1 });
    expect(kit.open('access', token)).toEqual({ a: 1 });
    expect(kit.open('refresh', token)).toBeNull();
    expect(kit.open('refresh', `mrt_${token.slice(4)}`)).toBeNull();
    expect(kit.open('access', `${token.slice(0, -2)}xx`)).toBeNull();
    expect(new TokenKit('other-secret-000000000000000000000').open('access', token)).toBeNull();
  });

  it('[ADR-15 시험] PKCE S256만 맞춰 봐요(RFC 7636 부록 B 예시)', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(pkceChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(pkceMatches(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(pkceMatches('short', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false);
  });

  it('[ADR-14 시험] 나가는 글자는 제어·방향 문자를 지우고 길이를 잘라요', () => {
    expect(cleanText('\u0007가\u202E나\u200B다\n\t라', 100)).toBe('가 나 다 라');
    expect(cleanText('가'.repeat(10), 3)).toBe('가가가');
    expect(cleanText(42, 10)).toBe('');
  });
});
