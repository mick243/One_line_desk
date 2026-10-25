import { DEFAULT_OPS_SETTINGS, GRADE, gatewayAllows, isPantryStandalone, type OpsSettings } from '@one-line-desk/shared';
import { describe, expect, it } from 'vitest';
import { AuditLog } from './audit';
import { canTransition, transition } from './plan';
import { listMcpTools, toolsForModule } from './tool-registry';

const settings = (patch: Partial<OpsSettings>): OpsSettings => ({ ...DEFAULT_OPS_SETTINGS, ...patch });

describe('plan 상태', () => {
  it('제안됨에서만 실행 중으로 가요', () => {
    expect(canTransition('proposed', 'executing')).toBe(true);
    expect(canTransition('done', 'executing')).toBe(false);
    expect(() => transition('expired', 'executing')).toThrow();
  });
});

describe('AI 게이트웨이 등급', () => {
  it('계약 확인 전에는 등급 0만, 등급 2 이상은 늘 거부해요', () => {
    expect(gatewayAllows(GRADE.public, false)).toBe(true);
    expect(gatewayAllows(GRADE.internal, false)).toBe(false);
    expect(gatewayAllows(GRADE.internal, true)).toBe(true);
    expect(gatewayAllows(GRADE.confidential, true)).toBe(false);
  });
});

describe('도구 레지스트리', () => {
  it('MCP는 기본으로 꺼져 있고, 켜도 모듈이 켬일 때만 도구가 나와요', () => {
    expect(listMcpTools(DEFAULT_OPS_SETTINGS)).toEqual([]);
    const on = settings({ mcp: true });
    expect(listMcpTools(on).map((t) => t.name).sort()).toEqual(['notices_search', 'rooms_find_free']);
    const roomsLinkOnly = settings({ mcp: true, modules: { ...DEFAULT_OPS_SETTINGS.modules, rooms: 'link' } });
    expect(listMcpTools(roomsLinkOnly).map((t) => t.name)).toEqual(['notices_search']);
  });

  it('꺼진 모듈은 도구를 받지 못해요', () => {
    const off = settings({ modules: { ...DEFAULT_OPS_SETTINGS.modules, notices: 'off' } });
    expect(toolsForModule('notices', off)).toEqual([]);
  });

  it('같이 채워요 단독 모드는 navi·notices·rooms가 모두 끔일 때예요', () => {
    expect(isPantryStandalone(DEFAULT_OPS_SETTINGS)).toBe(false);
    expect(isPantryStandalone(settings({ modules: { navi: 'off', notices: 'off', rooms: 'off', pantry: 'on' } }))).toBe(true);
  });
});

describe('감사 로그', () => {
  it('정해진 칸 말고는 받지 않아요', () => {
    const log = new AuditLog(() => 0);
    expect(() => log.record({ pseudonymId: 'p_1', channel: 'ask', result: 'locked', text: '원문' } as never)).toThrow();
  });
});
