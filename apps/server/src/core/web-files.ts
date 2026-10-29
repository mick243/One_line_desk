import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { HTML_SECURITY_HEADERS } from '@one-line-desk/shared/web-headers';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pathOnly } from './logging';

// 웹 화면 파일 내보내기(10/29 배포 준비 회의 A3·B1, 쟁점 1). 운영은 같은 이미지의 서버가 apps/web/dist를 줘요.
// 그래서 웹과 서버의 판이 늘 같고, 화면 보안 머리를 시험으로 지켜요. 개발은 Vite가 화면을 줘요.
// 시작할 때 파일을 모두 읽어 표로 들고, 표에 있는 경로만 줘요(경로 탈출이 없고, 새 의존성도 없어요).

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};
/** 글자 파일만 미리 압축해요. woff2·그림은 이미 압축돼 있어요. */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.txt']);
/** 이보다 작으면 압축해도 머리만 늘어요. */
const MIN_COMPRESS_BYTES = 1024;

/** 해시가 붙은 파일은 내용이 바뀌면 이름도 바뀌어서 1년 동안 그대로 둬요. */
export const ASSET_CACHE = 'public, max-age=31536000, immutable';
/** dist 뿌리의 해시 없는 파일(회의실 그림 등)은 하루만 둬요. */
export const PLAIN_CACHE = 'public, max-age=86400';
/**
 * 화면 HTML은 저장하지 않아요(쟁점 3). 0.5KB라 다시 받아도 느리지 않고, 배포 뒤에는 늘 새 껍데기를 받아요.
 * 공용 PC에서 뒤로 가기 캐시가 앞사람 화면(메모리에 있던 글)을 되살리는 일도 줄여요.
 */
export const HTML_CACHE = 'no-store';

/** index.html로 대신 답하는 화면 주소예요. 그 밖의 주소는 404라서 /api·/assets에 HTML이 오지 않아요. */
export const SCREEN_PATHS = ['/', '/oauth/consent', '/r/:token'] as const;

interface WebFile {
  body: Buffer;
  type: string;
  br?: Buffer;
  gzip?: Buffer;
}

/** dist 폴더를 읽어 경로별 파일 표를 만들어요. 소스맵과 점(.)으로 시작하는 파일은 내보내지 않아요. */
export function loadWebFiles(dir: string): Map<string, WebFile> {
  if (!existsSync(join(dir, 'index.html'))) {
    throw new Error(`웹 화면 파일이 없어요(${join(dir, 'index.html')}). npm run build로 만든 뒤 띄워 주세요`);
  }
  const files = new Map<string, WebFile>();
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && extname(entry.name) !== '.map') files.set(`/${relative(dir, full).split(sep).join('/')}`, readWebFile(full));
    }
  };
  walk(dir);
  return files;
}

function readWebFile(full: string): WebFile {
  const ext = extname(full).toLowerCase();
  const body = readFileSync(full);
  const file: WebFile = { body, type: TYPES[ext] ?? 'application/octet-stream' };
  if (COMPRESSIBLE.has(ext) && body.length >= MIN_COMPRESS_BYTES) {
    const br = brotliCompressSync(body, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length },
    });
    const gzip = gzipSync(body, { level: 9 });
    if (br.length < body.length) file.br = br;
    if (gzip.length < body.length) file.gzip = gzip;
  }
  return file;
}

/** accept-encoding에서 고를 압축. q=0으로 거절한 것은 고르지 않아요. */
export function pickEncoding(accept: string | undefined, file: Pick<WebFile, 'br' | 'gzip'>): 'br' | 'gzip' | undefined {
  if (!accept) return undefined;
  const allowed = new Set(
    accept
      .toLowerCase()
      .split(',')
      .map((part) => part.trim().split(';'))
      .filter(([, ...params]) => !params.some((p) => /^\s*q\s*=\s*0(\.0*)?\s*$/.test(p)))
      .map(([name]) => name!.trim()),
  );
  if (file.br && allowed.has('br')) return 'br';
  if (file.gzip && allowed.has('gzip')) return 'gzip';
  return undefined;
}

function send(req: FastifyRequest, reply: FastifyReply, file: WebFile, cache: string) {
  const encoding = pickEncoding(req.headers['accept-encoding'], file);
  reply.header('content-type', file.type).header('cache-control', cache);
  if (file.br || file.gzip) reply.header('vary', 'accept-encoding');
  if (encoding) reply.header('content-encoding', encoding);
  return reply.send(encoding === 'br' ? file.br : encoding === 'gzip' ? file.gzip : file.body);
}

/** dist의 화면 파일을 내보내는 경로를 붙여요. 운영 시작(index.ts)만 불러요. */
export function registerWebFiles(app: FastifyInstance, dir: string) {
  const files = loadWebFiles(dir);
  const index = files.get('/index.html')!;

  const screen = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.headers(HTML_SECURITY_HEADERS);
    return send(req, reply, index, HTML_CACHE);
  };
  for (const path of SCREEN_PATHS) app.get(path, screen);

  // 없는 /assets 파일은 index.html이 아니라 404예요. 옛 화면이 지워진 파일을 부르면 바로 실패해야 오류 경계가 잡아요.
  app.get('/assets/*', async (req, reply) => {
    const file = files.get(pathOnly(req.url));
    if (!file) return reply.code(404).send({ error: 'not-found' });
    return send(req, reply, file, ASSET_CACHE);
  });

  for (const [path, file] of files) {
    if (path === '/index.html' || path.startsWith('/assets/')) continue;
    app.get(path, async (req, reply) => send(req, reply, file, PLAIN_CACHE));
  }
}
