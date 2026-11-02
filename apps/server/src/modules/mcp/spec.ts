import { MCP_SCOPES } from '@one-line-desk/shared';
import { z } from 'zod';
import { MCP_TOOLS } from '../../core/tool-registry';
import { MCP_TOOL_IMPLS } from './tool-impls';

// MCP 도구 노출 명세(11/2, MCP 통합 회의 0단계). 레지스트리 + 구현 표에서 만들어 docs/MCP_도구명세.md에 둬요.
// 보안팀이 "무엇이 나가고, 무엇을 일부러 안 내보내나"를 판마다 확인하는 문서예요. 손으로 고치지 않아요.
// 다시 만들기: npm run mcp:spec. 문서가 코드와 다르면 시험(spec.test.ts)이 막아요.

interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  maxItems?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

function typeLabel(s: JsonSchema): string {
  if (s.enum) return `정해진 값(${s.enum.length}개)`;
  if (s.type === 'array') return `목록${s.maxItems !== undefined ? `(최대 ${s.maxItems})` : ''}`;
  const t = Array.isArray(s.type) ? s.type.join('|') : (s.type ?? '값');
  const limits = [
    s.maxLength !== undefined ? `최대 ${s.maxLength}자` : '',
    // zod 정수의 기본 상한(2^53 − 1)은 "이상"으로만 써요.
    s.maximum !== undefined && s.maximum < Number.MAX_SAFE_INTEGER ? `${s.minimum ?? ''}~${s.maximum}` : s.minimum !== undefined ? `${s.minimum} 이상` : '',
  ].filter(Boolean);
  return limits.length ? `${t}(${limits.join(', ')})` : t;
}

/** 표 칸에 넣을 글. 줄바꿈과 세로줄을 없애요. */
const cell = (text: string) => text.replace(/\s+/g, ' ').replaceAll('|', '/').trim();

/** 객체 스키마를 "칸 이름 | 모양 | 꼭 | 설명" 줄로 펼쳐요. 목록 안 객체는 이름[].칸으로 써요. */
function rows(schema: JsonSchema, prefix = ''): string[] {
  const out: string[] = [];
  const required = new Set(schema.required ?? []);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const name = `${prefix}${key}`;
    out.push(`| \`${name}\` | ${cell(typeLabel(child))} | ${required.has(key) ? '예' : ''} | ${cell(child.description ?? '')} |`);
    if (child.properties) out.push(...rows(child, `${name}.`));
    if (child.items?.properties) out.push(...rows(child.items, `${name}[].`));
  }
  return out;
}

const toSchema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as JsonSchema;

export function renderToolSpec(): string {
  const lines = [
    '# MCP 도구 노출 명세',
    '',
    '> 이 문서는 `apps/server/src/core/tool-registry.ts`와 `apps/server/src/modules/mcp/tool-impls.ts`에서 만들어요(`npm run mcp:spec`). 손으로 고치지 않아요.',
    '',
    '- 모든 도구는 읽기만 해요. 쓰기 도구는 0개예요(ADR-03·14). 예약 같은 쓰기는 결과의 앱 확인 링크를 사람이 열어 앱에서 한 번 확인해요.',
    '- 출력은 아래 칸만 나가요. 서비스가 다른 칸을 실어 보내도 출력 스키마(`.strict()`)와 모양 함수가 버려요.',
    '- 실제(모의가 아닌) 자료는 보안팀이 승인한 클라이언트에만 가요(ADR-15). 도구 호출마다 감사 로그(도구·클라이언트·결과, 7일)와 접속기록(가명 ID·접속지, 1년)이 남아요. 입력 값은 어디에도 남지 않아요.',
    '- 운영자는 MCP 전체·모듈·도구 하나씩 끌 수 있어요(`/api/ops/flag`, `/api/ops/switch`, `/api/ops/mcp-tool`).',
    '',
    `범위: ${MCP_SCOPES.map((s) => `\`${s}\``).join(', ')}`,
    '',
    '| 도구 | 이름 | 범위 | 모듈 | 일부러 내보내지 않는 칸 |',
    '|---|---|---|---|---|',
    ...MCP_TOOLS.map((t) => `| \`${t.name}\` | ${t.mcp.title} | \`${t.mcp.scope}\` | ${t.module} | ${t.mcp.withheld.join(', ')} |`),
  ];
  for (const tool of MCP_TOOLS) {
    const impl = MCP_TOOL_IMPLS[tool.name];
    if (!impl) throw new Error(`구현이 없는 MCP 도구예요: ${tool.name}`);
    lines.push(
      '',
      `## \`${tool.name}\` — ${tool.mcp.title}`,
      '',
      cell(tool.description),
      '',
      `- 범위: \`${tool.mcp.scope}\` · 꺼지는 조건: MCP 전체 끔, ${tool.module} 모듈이 켬이 아님, 이 도구를 따로 끔`,
      `- 일부러 내보내지 않는 칸: ${tool.mcp.withheld.join(', ')}`,
      '',
      '### 입력',
      '',
      '| 칸 | 모양 | 꼭 | 설명 |',
      '|---|---|---|---|',
      ...rows(toSchema(impl.input)),
      '',
      '### 출력',
      '',
      '| 칸 | 모양 | 꼭 | 설명 |',
      '|---|---|---|---|',
      ...rows(toSchema(impl.output)),
    );
  }
  return `${lines.join('\n')}\n`;
}
