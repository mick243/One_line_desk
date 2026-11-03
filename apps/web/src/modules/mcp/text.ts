import { ApiFailure } from '../../api';

// MCP 화면 부품이 같이 쓰는 글 도우미. "연결된 AI 앱"(index)과 동의 시트·앱 확인 링크(entry)가 나눠 써요.

/** 앱 이름 뒤 조사(가/이, 로/으로). 한글이 아니면 '가'·'로'로 둬요(Claude가, Claude로). */
export function josa(name: string, kind: '가' | '로'): string {
  const code = name.trim().charCodeAt(name.trim().length - 1);
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return kind;
  const final = (code - 0xac00) % 28;
  if (kind === '가') return final === 0 ? '가' : '이';
  return final === 0 || final === 8 ? '로' : '으로';
}

export function failMessage(e: unknown, fallback: string): string {
  return e instanceof ApiFailure ? e.message : fallback;
}
