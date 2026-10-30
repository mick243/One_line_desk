import type { AskResponse, Kind, LockKind, ModuleKind, ModuleSwitch, PlanConfirmResponse, PlanCreateResponse, Role } from '@one-line-desk/shared';
import { fetchWithin, isOtherBuild, TIMEOUT_MESSAGE, unavailableMessage } from './net';

export interface PublicConfig {
  modules: Record<ModuleKind, ModuleSwitch>;
  roomsWrite: boolean;
  mcp: boolean;
  /** 채팅 자동 실행(ADR-19) */
  autoActions: boolean;
  standalone: boolean;
  demoData: string[];
  rulesVersion: number;
  /** 로그인 방식: 모의(가상 직원 고르기) 또는 IdP 리디렉트(임시 IdP·회사 IdP) */
  /** password: 시연 비밀번호를 받아야 하는지(10/30, 웹 화면만 Vercel에 올린 시연) */
  login: { kind: 'mock'; password?: boolean } | { kind: 'oidc'; label: string };
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
/** 쉬는 시간이 지나 끊겼을 때(ADR-20). 다시 로그인하면 회사 로그인이 다시 인증을 물어요. */
export const IDLE_ENDED_MESSAGE = '오래 쉬어서 보안을 위해 다시 로그인해 주세요';

/** 서버가 다시 떠서(배포) 로그인이 풀렸을 때(10/29 배포 준비 회의 B3). 세션이 서버 메모리에만 있어서 쓰던 글도 사라져요. */
export const RESTARTED_MESSAGE = '앱이 새로 바뀌어서 다시 로그인해 주세요. 쓰던 글은 저장하지 않아서 다시 써 주세요';

// 서버가 쉬는 시간으로 끊었다고 알려 줬는지. 새로 고침 뒤 첫 /api/me 401에서도 알아요.
let endedByIdle = false;
export const sessionEndedByIdle = () => endedByIdle;
// 서버가 다시 떠서 끊겼다고 알려 줬는지
let endedByRestart = false;
export const sessionEndedByRestart = () => endedByRestart;

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

/** 이 화면의 판. 서버 판과 다르면 새 버전 띠를 띄우고, 회의실 채팅은 바로 실행하지 않아요(배포 준비 회의 D1). */
export const WEB_BUILD = __DESK_BUILD__;
let newVersion = false;
const newVersionListeners = new Set<() => void>();
export const newVersionAvailable = () => newVersion;

/** 서버에 새 판이 떴을 때 부를 함수를 걸어요. 떼는 함수를 돌려줘요. 화면을 저절로 새로 고치지는 않아요. */
export function onNewVersion(listener: () => void): () => void {
  newVersionListeners.add(listener);
  return () => newVersionListeners.delete(listener);
}

/** background: 사람이 누른 게 아닌 반복 요청(폴링). 서버가 쉬는 시간을 늘리지 않아요(ADR-20). */
async function raw<T>(method: string, url: string, body?: unknown, opts: { background?: boolean } = {}): Promise<{ status: number; data: T }> {
  if (sessionEnded && !isAuthPath(url)) return { status: 401, data: { error: 'login-required', message: SESSION_ENDED_MESSAGE } as T };
  const res = await fetchWithin((u, init) => fetch(u, init), url, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}),
      ...(opts.background ? { 'x-desk-background': '1' } : {}),
      'x-desk-build': WEB_BUILD,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // 서버에 닿지 못하거나 15초 안에 답이 없어도 던지지 않고 실패로 돌려줘요. 화면이 멈추지 않고 문구를 보여 줘요(배포 준비 회의 D2, 개선 회의 A3).
  if (res === 'offline') return { status: 0, data: { error: 'unavailable', message: unavailableMessage(0, false) } as T };
  if (res === 'timeout') return { status: 0, data: { error: 'timeout', message: TIMEOUT_MESSAGE } as T };
  if (!newVersion && isOtherBuild(res.headers.get('x-desk-build'), WEB_BUILD)) {
    newVersion = true;
    for (const listener of newVersionListeners) listener();
  }
  // 배포 중 관문이 주는 502·503·504와 HTML 오류는 서버 글(영어·HTML) 대신 정해진 문구로 바꿔요.
  const unavailable = unavailableMessage(res.status, (res.headers.get('content-type') ?? '').includes('application/json'));
  if (unavailable) return { status: res.status, data: { error: 'unavailable', message: unavailable } as T };
  const data = (await res.json().catch(() => ({}))) as T;
  const reason = res.status === 401 ? (data as { reason?: string }).reason : undefined;
  if (reason === 'idle') endedByIdle = true;
  if (reason === 'restarted') endedByRestart = true;
  if (res.status === 401 && !isAuthPath(url) && !sessionEnded) {
    sessionEnded = true;
    csrfToken = '';
    for (const listener of sessionEndedListeners) listener();
  }
  return { status: res.status, data };
}

/** 모듈 화면도 이걸로 서버를 불러요. 2xx가 아니면 ApiFailure를 던져요. */
export async function apiRequest<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, opts: { background?: boolean } = {}): Promise<T> {
  const { status, data } = await raw<T & { error?: string; message?: string }>(method, url, body, opts);
  if (status >= 200 && status < 300) return data;
  throw new ApiFailure(status, data.error ?? 'error', data.message ?? '지금 처리하지 못했어요');
}

// 시연(모의 로그인)인지. 여러 사람이 같은 가상 직원으로 들어와서, 글을 쓰는 화면이 실제 정보를 쓰지 말라고 알려요(배포 준비 회의 D8).
let demoLogin = false;
export const isDemoLogin = () => demoLogin;

export const api = {
  async publicConfig(): Promise<PublicConfig> {
    const { status, data } = await raw<PublicConfig>('GET', '/api/config/public');
    if (status !== 200) throw new Error('서버에 연결하지 못했어요');
    demoLogin = data.login.kind === 'mock';
    return data;
  },
  async me(): Promise<Me | null> {
    const { status, data } = await raw<Me>('GET', '/api/me');
    if (status !== 200) return null;
    csrfToken = data.csrfToken;
    sessionEnded = false;
    endedByIdle = false;
    endedByRestart = false;
    return data;
  },
  async mockUsers(): Promise<MockUser[]> {
    const { status, data } = await raw<MockUser[]>('GET', '/api/auth/mock-users');
    return status === 200 ? data : [];
  },
  /** 모의 로그인. 실패하면 서버 문구(시연 비밀번호 틀림·잠시 막힘 등)를 돌려줘요. */
  async login(idpSubject: string, password?: string): Promise<{ ok: true } | { ok: false; message?: string }> {
    const { status, data } = await raw<{ message?: string }>('POST', '/api/auth/login', password === undefined ? { idpSubject } : { idpSubject, password });
    return status === 200 ? { ok: true } : { ok: false, message: data?.message };
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
