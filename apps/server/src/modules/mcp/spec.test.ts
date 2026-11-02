import { readFileSync } from 'node:fs';
import { MCP_SCOPES } from '@one-line-desk/shared';
import { describe, expect, it } from 'vitest';
import { MCP_TOOLS, TOOLS } from '../../core/tool-registry';
import { renderToolSpec } from './spec';
import { MCP_TOOL_IMPLS } from './tool-impls';

// 도구 정의 한 곳(11/2 MCP 통합 회의 0단계): 레지스트리와 구현 표가 맞는지, 노출 명세 문서가 코드와 같은지 봐요.

describe('MCP 도구 레지스트리', () => {
  it('MCP로 내보내는 도구는 모두 범위·제목·뺀 칸이 있고, 구현 표와 하나씩 맞아요', () => {
    for (const t of TOOLS.filter((x) => x.mcpExposed)) {
      expect(t.mcp, t.name).toBeDefined();
      expect(MCP_SCOPES as readonly string[]).toContain(t.mcp!.scope);
      expect(t.mcp!.withheld.length, t.name).toBeGreaterThan(0);
    }
    expect(Object.keys(MCP_TOOL_IMPLS).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
  });

  it('[MCP-1] 쓰기 도구는 타입에도 표에도 없어요', () => {
    expect(TOOLS.every((t) => t.access === 'read')).toBe(true);
  });

  it('노출 명세 문서(docs/MCP_도구명세.md)가 코드와 같아요. 다르면 npm run mcp:spec으로 다시 만들어요', () => {
    const doc = readFileSync(new URL('../../../../../docs/MCP_도구명세.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(doc).toBe(renderToolSpec());
  });

  it('명세에는 입력·출력 칸과 일부러 뺀 칸이 적혀 있고, 뺀 칸이 출력 칸에 섞이지 않아요', () => {
    const spec = renderToolSpec();
    expect(spec).toContain('`candidates[].roomName`');
    expect(spec).toContain('`hits[].url`');
    expect(spec).toContain('예약자, 회의 제목');
    expect(spec).not.toMatch(/`[^`]*(reserver|organizer|body|summary)[^`]*`/i);
  });
});
