// @vitest-environment happy-dom
import type { ConnectionsResponse, ConsentInfo } from '@one-line-desk/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { button, cleanup, click, fakeServer, hasButton, host, mount, openSheet } from '../../testing/dom';
import { ConsentScreen } from './entry';
import { ConnectedApps } from './index';

// 연결된 AI 앱(S6)과 연결 동의 화면(M3·M4). 그려지는지와 버튼 흐름을 봐요(11/23 웹 시험 보강).

const connections: ConnectionsResponse = {
  available: true,
  tools: ['rooms.read', 'notices.read'],
  apps: [{ clientId: 'claude ai/1', appName: 'Claude', connectedOn: '2026-11-20', scopes: ['rooms.read'], devices: 2 }],
  mcpUrl: 'https://desk.example.com/mcp',
  cliApps: [{ clientId: 'cli-1', appName: 'Claude Code' }],
};

afterEach(async () => {
  await cleanup();
  window.history.replaceState(null, '', '/');
});

describe('연결된 AI 앱', () => {
  it('앱 이름·연결한 날·기기 수·읽을 수 있는 것과 허락이 필요한 범위를 그려요', async () => {
    fakeServer((req) => (req.url === '/api/mcp/connections' ? { body: connections } : undefined));
    const el = await mount(host(<ConnectedApps />));
    expect(el.textContent).toContain('Claude · 11월 20일에 연결 · 기기 2대');
    expect(el.textContent).toContain('회의실');
    expect(el.textContent).toContain('공지 · 허락이 필요해요');
    expect(el.textContent).toContain('claude mcp add --transport http --client-id cli-1 one-line-desk https://desk.example.com/mcp');
  });

  it('[끊기]는 확인 시트를 거쳐서만 끊고, 시트를 닫으면 아무것도 보내지 않아요', async () => {
    const srv = fakeServer((req) => {
      if (req.url === '/api/mcp/connections') return { body: connections };
      if (req.method === 'DELETE') return { body: { ok: true } };
      return undefined;
    });
    const el = await mount(host(<ConnectedApps />));

    await click(button('끊기', el));
    expect(openSheet()!.textContent).toContain('기기 2대 모두');
    await click(document.querySelector('.sheet-backdrop')!);
    expect(srv.writes()).toHaveLength(0);

    await click(button('끊기', el));
    await click(button('끊기', openSheet()!));
    expect(srv.writes().map((r) => [r.method, r.url])).toEqual([['DELETE', `/api/mcp/connections/${encodeURIComponent('claude ai/1')}`]]);
    expect(el.textContent).toContain('끊었어요');
  });

  it('연결된 앱이 없으면 빈 안내를 보여요', async () => {
    fakeServer((req) => (req.url === '/api/mcp/connections' ? { body: { ...connections, apps: [], cliApps: [] } } : undefined));
    const el = await mount(host(<ConnectedApps />));
    expect(el.textContent).toContain('연결된 AI 앱이 없어요');
    expect(hasButton('끊기', el)).toBe(false);
  });
});

describe('연결 동의 화면', () => {
  const me = { displayName: '가상 직원', department: '개발팀', floor: '5층', roles: [], csrfToken: 't' };
  const ready: ConsentInfo = { status: 'ready', appName: 'Claude', redirectHost: 'claude.ai', tools: ['rooms.read', 'pantry.read'], roomsWrite: false };

  it('읽는 것·못 하는 것을 보여 주고, [연결 허락]을 눌러야 허락을 보내요', async () => {
    window.history.replaceState(null, '', '/oauth/consent?req=abc');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    const srv = fakeServer((req) => {
      if (req.url === '/api/mcp/consent?req=abc') return { body: ready };
      if (req.url === '/api/mcp/consent') return { body: { result: 'allowed', redirectTo: 'https://claude.ai/cb?code=x' } };
      return undefined;
    });
    const el = await mount(host(<ConsentScreen me={me} />));
    expect(el.textContent).toContain('Claude가 한 줄 데스크에 연결하려고 해요');
    expect(el.textContent).toContain('예약은 그룹웨어에서 해요');
    expect(el.textContent).toContain('누가 표를 줬는지는 보내지 않아요');
    expect(srv.writes()).toHaveLength(0);

    await click(button('연결 허락'));
    expect(srv.writes().map((r) => r.body)).toEqual([{ req: 'abc', decision: 'allow' }]);
    expect(el.textContent).toContain('연결됐어요. Claude로 돌아가세요');
    expect(assign).toHaveBeenCalledWith('https://claude.ai/cb?code=x');
  });

  it('허락 목록 밖 앱이면 서버를 부르지 않고 막힘 문구와 [마이 페이지로 가기]만 보여요', async () => {
    window.history.replaceState(null, '', '/oauth/consent?error=not-allowed');
    const srv = fakeServer(() => undefined);
    const el = await mount(host(<ConsentScreen me={me} />));
    expect(srv.sent).toHaveLength(0);
    expect(el.textContent).toContain('회사가 허락하지 않은 앱');
    expect(hasButton('마이 페이지로 가기', el)).toBe(true);
    expect(hasButton('연결 허락', el)).toBe(false);
  });
});
