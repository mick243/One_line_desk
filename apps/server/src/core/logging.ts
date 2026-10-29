import type { FastifyServerOptions } from 'fastify';

// 앱 로그 가리기(L-28, R13). 요청 로그에는 방법·경로(쿼리 빼고)·상태·걸린 시간만 남겨요.
// 쿼리(OIDC code·state, 검색 값)·IP·호스트·머리·본문은 남기지 않아요. 오류는 이름·코드·위치만 남기고 글은 빼요
// (예: Node의 "Invalid URL" 글에는 입력이 그대로 들어 있어요).

/** 쿼리와 조각을 뗀 경로 */
export function pathOnly(url: string | undefined): string {
  return (url ?? '').split(/[?#]/, 1)[0]!.slice(0, 200);
}

/**
 * 로그에 남길 경로. 앱 확인 링크(/r/<토큰>)는 토큰에 가명 ID·방·시각이 읽히는 글로 들어 있어서 자리 표시로 바꿔요.
 * 서버가 화면도 주면서(10/29 배포 준비 회의 A3) 이 경로가 앱 로그에 들어오게 됐어요.
 */
export function logPath(url: string | undefined): string {
  return pathOnly(url).replace(/^\/r\/[^/]+/, '/r/:token');
}

export const LOG_SERIALIZERS = {
  req: (req: { method?: string; url?: string; id?: string }) => ({ id: req.id, method: req.method, path: logPath(req.url) }),
  res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
  // 프레임워크가 남기는 오류도 글(message) 대신 코드·위치만 남겨요.
  err: (err: unknown) => {
    const s = errorSummary(err);
    return { type: s.name, message: s.code ?? '', stack: s.at ?? '' };
  },
};

/** 로그에 남길 오류 요약: 이름·코드·던진 곳(우리 코드 첫 줄). 오류 글은 빼요. */
export function errorSummary(err: unknown): { name: string; code?: string; at?: string } {
  if (!(err instanceof Error)) return { name: typeof err };
  const code = (err as { code?: unknown }).code;
  const at = err.stack
    ?.split('\n')
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.includes('/src/') || line.includes('\\src\\'))
    ?.replace(/^at\s+/, '')
    .replace(/^.*[\\/](apps|packages)[\\/]/, '$1/');
  return { name: err.name, ...(typeof code === 'string' ? { code } : {}), ...(at ? { at } : {}) };
}

/** buildApp에 넘긴 로그 설정에 가리기 규칙을 씌워요. 끄면(false·없음) 그대로 꺼요. */
export function maskedLogger(logger: FastifyServerOptions['logger']): FastifyServerOptions['logger'] {
  if (!logger) return false;
  return { ...(typeof logger === 'object' ? logger : {}), serializers: LOG_SERIALIZERS };
}
