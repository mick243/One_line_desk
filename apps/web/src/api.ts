import type { LockKind, ModuleKind, ModuleSwitch, Role } from '@one-line-desk/shared';

export interface PublicConfig {
  modules: Record<ModuleKind, ModuleSwitch>;
  roomsWrite: boolean;
  standalone: boolean;
  demoData: string[];
  rulesVersion: number;
}

export interface Me {
  displayName: string;
  department: string;
  floor: string;
  roles: Role[];
  csrfToken: string;
}

export interface MockUser {
  idpSubject: string;
  displayName: string;
  department: string;
  floor: string;
}

export type AskResult =
  | { status: 'locked'; locks: { kind: LockKind; message: string }[] }
  | { status: 'rate-limited' | 'not-ready' | 'error'; message: string };

// CSRF 토큰은 페이지 메모리에만 둬요. 브라우저 저장소에 아무것도 넣지 않아요(R13).
let csrfToken = '';

async function request<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

export const api = {
  async publicConfig(): Promise<PublicConfig> {
    const { status, data } = await request<PublicConfig>('GET', '/api/config/public');
    if (status !== 200) throw new Error('서버에 연결하지 못했어요');
    return data;
  },
  async me(): Promise<Me | null> {
    const { status, data } = await request<Me>('GET', '/api/me');
    if (status !== 200) return null;
    csrfToken = data.csrfToken;
    return data;
  },
  async mockUsers(): Promise<MockUser[]> {
    const { status, data } = await request<MockUser[]>('GET', '/api/auth/mock-users');
    return status === 200 ? data : [];
  },
  async login(idpSubject: string): Promise<boolean> {
    return (await request('POST', '/api/auth/login', { idpSubject })).status === 200;
  },
  async logout(all: boolean): Promise<void> {
    await request('POST', all ? '/api/auth/logout-all' : '/api/auth/logout');
    csrfToken = '';
  },
  /** 원문은 POST 본문으로만 보내요. URL에 넣지 않아요. */
  async ask(text: string): Promise<AskResult> {
    const { status, data } = await request<{ message?: string; locks?: { kind: LockKind; message: string }[] }>('POST', '/api/ask', { text });
    if (status === 422 && data.locks) return { status: 'locked', locks: data.locks };
    if (status === 429) return { status: 'rate-limited', message: data.message ?? '요청이 많아요. 잠시 뒤에 다시 보내 주세요.' };
    if (status === 501) return { status: 'not-ready', message: data.message ?? '아직 만들지 않았어요' };
    return { status: 'error', message: '지금 답을 만들지 못했어요' };
  },
};
