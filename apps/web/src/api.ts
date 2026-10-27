import type { AskResponse, Kind, LockKind, ModuleKind, ModuleSwitch, PlanConfirmResponse, PlanCreateResponse, Role } from '@one-line-desk/shared';

export interface PublicConfig {
  modules: Record<ModuleKind, ModuleSwitch>;
  roomsWrite: boolean;
  mcp: boolean;
  standalone: boolean;
  demoData: string[];
  rulesVersion: number;
  /** 로그인 방식: 모의(가상 직원 고르기) 또는 IdP 리디렉트(임시 IdP·회사 IdP) */
  login: { kind: 'mock' } | { kind: 'oidc'; label: string };
  /** 회의 초대에 쓸 수 있는 바깥 길(ADR-17) */
  inviteChannels: { calendar: string | null; slack: string | null };
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
  /** 처음 쓰는 사람이 누구를 고를지 알 수 있게 역할도 같이 와요(모의 로그인에서만). */
  roles?: Role[];
}

/** 서버가 { error, message }로 돌려준 실패. message는 화면에 그대로 보여 줄 해요체 문구예요. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type AskResult =
  { status: 'ok'; response: AskResponse } | { status: 'locked'; locks: { kind: LockKind; message: string }[] } | { status: 'failed'; message: string };

// CSRF 토큰은 페이지 메모리에만 둬요. 브라우저 저장소에 아무것도 넣지 않아요(R13).
let csrfToken = '';

/** 로그인 풀림 안내(L-46). 모든 기기 로그아웃·퇴사 확인·세션 만료 뒤 첫 401에서 보여 줘요. */
export const SESSION_ENDED_MESSAGE = '보안을 위해 다시 로그인해 주세요';

// 로그인이 풀리면(로그인한 뒤 받은 401) 한 번만 알리고, 다시 로그인할 때까지 API를 부르지 않아요(그 뒤 401 요청 0).
let sessionEnded = false;
const sessionEndedListeners = new Set<() => void>();

/** 로그인이 풀렸을 때 부를 함수를 걸어요. 떼는 함수를 돌려줘요. */
export function onSessionEnded(listener: () => void): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

// 로그인 전 401이 정상인 경로(내 정보 확인, 로그인 자체)는 로그인 풀림으로 보지 않아요.
const isAuthPath = (url: string) => url === '/api/me' || url.startsWith('/api/auth/') || url.startsWith('/api/config/');

async function raw<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  if (sessionEnded && !isAuthPath(url)) return { status: 401, data: { error: 'login-required', message: SESSION_ENDED_MESSAGE } as T };
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T;
  if (res.status === 401 && !isAuthPath(url) && !sessionEnded) {
    sessionEnded = true;
    csrfToken = '';
    for (const listener of sessionEndedListeners) listener();
  }
  return { status: res.status, data };
}

/** 모듈 화면도 이걸로 서버를 불러요. 2xx가 아니면 ApiFailure를 던져요. */
export async function apiRequest<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const { status, data } = await raw<T & { error?: string; message?: string }>(method, url, body);
  if (status >= 200 && status < 300) return data;
  throw new ApiFailure(status, data.error ?? 'error', data.message ?? '지금 처리하지 못했어요');
}

export const api = {
  async publicConfig(): Promise<PublicConfig> {
    const { status, data } = await raw<PublicConfig>('GET', '/api/config/public');
    if (status !== 200) throw new Error('서버에 연결하지 못했어요');
    return data;
  },
  async me(): Promise<Me | null> {
    const { status, data } = await raw<Me>('GET', '/api/me');
    if (status !== 200) return null;
    csrfToken = data.csrfToken;
    sessionEnded = false;
    return data;
  },
  async mockUsers(): Promise<MockUser[]> {
    const { status, data } = await raw<MockUser[]>('GET', '/api/auth/mock-users');
    return status === 200 ? data : [];
  },
  async login(idpSubject: string): Promise<boolean> {
    return (await raw('POST', '/api/auth/login', { idpSubject })).status === 200;
  },
  async logout(all: boolean): Promise<void> {
    await raw('POST', all ? '/api/auth/logout-all' : '/api/auth/logout');
    csrfToken = '';
  },
  /** 원문은 POST 본문으로만 보내요. URL에 넣지 않아요. kind가 있으면 그 종류로 다시 불러요(칩 바꾸기). */
  async ask(text: string, kind?: Kind): Promise<AskResult> {
    const { status, data } = await raw<AskResponse & { message?: string; locks?: { kind: LockKind; message: string }[] }>('POST', '/api/ask', {
      text,
      ...(kind ? { kind } : {}),
    });
    if (status === 200) return { status: 'ok', response: data };
    if (status === 422 && data.locks) return { status: 'locked', locks: data.locks };
    return { status: 'failed', message: data.message ?? '지금 답을 만들지 못했어요' };
  },
  createPlan(proposalToken: string): Promise<PlanCreateResponse> {
    return apiRequest('POST', '/api/plans', { proposalToken });
  },
  confirmPlan(planId: string): Promise<PlanConfirmResponse> {
    return apiRequest('POST', `/api/plans/${planId}/confirm`);
  },
  directPlan(proposalToken: string, edits: Record<string, unknown>): Promise<PlanConfirmResponse> {
    return apiRequest('POST', '/api/plans/direct', { proposalToken, edits });
  },
};
