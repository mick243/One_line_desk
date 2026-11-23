import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { ActionHost } from '../components/ActionHost';

// 웹 화면을 실제로 눌러 보는 시험 도우미(11/23 웹 시험 보강). 시험 파일 맨 위에 `// @vitest-environment happy-dom`을 적고 써요.
// 서버는 가짜 fetch로 흉내 내고, 화면이 보낸 요청(방법·주소·머리·본문)을 모아 둬요.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body: unknown } | undefined;
export type Route = (req: SentRequest) => Reply;

/** 가짜 서버. route가 undefined를 돌려주면 404예요. */
export function fakeServer(route: Route) {
  const sent: SentRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
    const req: SentRequest = {
      method: init.method ?? 'GET',
      url,
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    sent.push(req);
    const reply = route(req) ?? { status: 404, body: { error: 'not-found', message: '없어요' } };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    sent,
    /** GET이 아닌 요청(쓰기) */
    writes: () => sent.filter((r) => r.method !== 'GET'),
  };
}

let mounted: { root: Root; el: HTMLElement }[] = [];

/** 화면을 그려요. ActionHost 안에 넣고 싶으면 host()로 감싸요. */
export async function mount(node: ReactNode): Promise<HTMLElement> {
  const el = document.createElement('div');
  el.id = 'root';
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  await act(async () => root.render(node));
  await settle();
  return el;
}

export const host = (children: ReactNode, onNavigate: (to: unknown) => void = () => undefined) => (
  <ActionHost onNavigate={onNavigate} inviteChannels={{ calendar: null, slack: null }}>
    {children}
  </ActionHost>
);

/** 그린 화면을 모두 걷어요. afterEach에서 불러요. */
export async function cleanup(): Promise<void> {
  for (const { root, el } of mounted) {
    await act(async () => root.unmount());
    el.remove();
  }
  mounted = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
}

/** 기다리는 요청·effect가 다 끝날 때까지 몇 번 돌려요. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** 화면이 일부러 기다리는 시간(검색 멈춤 등)만큼 실제로 기다려요. */
export async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
  await settle();
}

/** 글자가 text인 버튼(문서 전체, 시트 포함). within을 주면 그 안에서만 찾아요. */
export function button(text: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text);
  if (found.length === 0) throw new Error(`버튼이 없어요: ${text}`);
  return found[0] as HTMLButtonElement;
}

export const hasButton = (text: string, within: ParentNode = document) => [...within.querySelectorAll('button')].some((b) => b.textContent?.trim() === text);

export async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

/** React가 받는 방식으로 입력 칸에 글을 넣어요. */
export async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/** 열린 시트(맨 위). 없으면 null */
export const openSheet = (): HTMLElement | null => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1) ?? null;
