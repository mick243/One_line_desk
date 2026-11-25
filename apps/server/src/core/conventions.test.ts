import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 규칙 시험(docs/CONVENTIONS.md 8절). ESLint 대신 코드를 읽어 프로젝트 규칙을 지켜요.
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SERVER = join(ROOT, 'apps/server/src');
const WEB = join(ROOT, 'apps/web/src');
const MODULES = join(SERVER, 'modules');

function files(dir: string, exts = ['.ts', '.tsx']): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, exts);
    return exts.some((e) => name.endsWith(e)) ? [path] : [];
  });
}

const rel = (path: string) => relative(ROOT, path).split(sep).join('/');
const isTest = (path: string) => /\.test\.tsx?$/.test(path);

describe('규칙 시험', () => {
  it('[ADR-01] 모듈은 다른 모듈을 import하지 않아요', () => {
    const bad: string[] = [];
    for (const file of files(MODULES)) {
      const own = rel(file).split('/')[4]!;
      // modules/index.ts는 모듈 목록이라 모두 import해요.
      if (own.endsWith('.ts')) continue;
      for (const m of readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1]!;
        if (!spec.startsWith('.')) continue;
        const target = rel(join(file, '..', spec));
        const targetModule = target.startsWith('apps/server/src/modules/') ? target.split('/')[4] : undefined;
        if (targetModule && targetModule !== own && !targetModule.endsWith('.ts')) bad.push(`${rel(file)} → ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('서버 코드는 console.log를 쓰지 않아요(로그는 req.log, 본문 없이)', () => {
    const bad = files(SERVER)
      .filter((f) => !isTest(f))
      .filter((f) => /console\.(log|info|debug|warn)\(/.test(readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });

  it('[R13] 웹 코드는 브라우저 저장소에 아무것도 넣지 않아요', () => {
    const bad = files(WEB).filter((f) => /\b(localStorage|sessionStorage|indexedDB)\b/.test(readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });

  it('웹 코드는 dangerouslySetInnerHTML을 쓰지 않아요', () => {
    const bad = files(WEB).filter((f) => readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML'));
    expect(bad.map(rel)).toEqual([]);
  });

  it('모듈은 시계를 ctx.now()로만 읽어요', () => {
    const bad = files(MODULES)
      .filter((f) => !isTest(f))
      .filter((f) => /Date\.now\(\)|new Date\(\)/.test(readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });

  // 장애런북 3절: 배포를 되돌려도 앞 판이 그대로 뜨려면 한 배포의 마이그레이션은 넓히기만 해요(11/23 운영 검토).
  // 지우기·이름 바꾸기·NOT NULL 더하기·자료형 바꾸기는 다음 배포로 나눠야 해서, 꼭 필요하면 아래 목록에 까닭과 함께 적어요.
  it('[장애런북 3절] 마이그레이션은 넓히기만 해요(좁히는 문장은 허용 목록에 까닭을 적어요)', () => {
    const ALLOWED: Record<string, string> = {
      '020_core_notify_groupware.sql': "알림 page 검사를 지우고 값을 더한 검사로 바로 다시 붙여요(넓히기, 'groupware' 추가)",
    };
    const NARROW =
      /\b(drop\s+(table|column|constraint|index|type|function|trigger)|rename\s+(to|column)|set\s+not\s+null|alter\s+column\s+\S+\s+(set\s+data\s+)?type)\b/i;
    const dir = join(ROOT, 'db/migrations');
    const bad = readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && !(f in ALLOWED))
      .filter((f) => NARROW.test(readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, '')));
    expect(bad).toEqual([]);
  });
});
