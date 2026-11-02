import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToolSpec } from '../src/modules/mcp/spec';

// MCP 도구 노출 명세를 다시 만들어요(docs/MCP_도구명세.md). 도구·입출력 칸을 바꾸면 돌려요.
const target = fileURLToPath(new URL('../../../docs/MCP_도구명세.md', import.meta.url));
writeFileSync(target, renderToolSpec(), 'utf8');
console.log(`썼어요: ${target}`);
