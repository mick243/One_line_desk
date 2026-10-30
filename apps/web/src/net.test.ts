import { describe, expect, it, vi } from 'vitest';
import { fetchWithin, isOtherBuild, newRequestId, OFFLINE_MESSAGE, REQUEST_TIMEOUT_MS, UNAVAILABLE_MESSAGE, unavailableMessage } from './net';

// 배포 중 화면 문구와 새 판 알아채기(10/29 배포 준비 회의 D1·D2).

describe('우리 서버가 답하지 않은 응답은 정해진 문구로 바꿔요', () => {
  it.each([
    [0, false, OFFLINE_MESSAGE],
    [502, false, UNAVAILABLE_MESSAGE],
    [503, true, UNAVAILABLE_MESSAGE],
    [504, false, UNAVAILABLE_MESSAGE],
    [404, false, UNAVAILABLE_MESSAGE],
    [500, false, UNAVAILABLE_MESSAGE],
  ])('상태 %i, JSON %s → 정해진 문구', (status, isJson, message) => {
    expect(unavailableMessage(status, isJson)).toBe(message);
  });

  it.each([
    [200, true],
    [204, false],
    [401, true],
    [404, true],
    [422, true],
    [500, true],
  ])('상태 %i, JSON %s → 서버 글을 그대로 써요', (status, isJson) => {
    expect(unavailableMessage(status, isJson)).toBeNull();
  });
});

describe('요청 번호는 https가 아니어도 만들어요(배포 준비 회의 D4)', () => {
  it('randomUUID가 있으면 쓰고, 없으면 getRandomValues로 서버가 받는 모양을 만들어요', () => {
    expect(newRequestId()).toMatch(/^[0-9a-f-]{36}$/);
    // http(보안 맥락이 아님) 브라우저처럼 randomUUID가 없는 crypto
    const insecure = { getRandomValues: crypto.getRandomValues.bind(crypto) };
    const id = newRequestId(insecure);
    // 서버 패턴: 문의 ^[A-Za-z0-9-]{8,64}$, 채팅·초대 ^[A-Za-z0-9_-]{8,64}$
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(newRequestId(insecure)).not.toBe(id);
  });
});

describe('서버가 알려 준 판이 다르면 새 버전이에요', () => {
  it.each([
    ['b2', 'b1', true],
    ['b1', 'b1', false],
    [null, 'b1', false],
    ['', 'b1', false],
    ['dev', 'b1', false],
    ['b2', 'dev', false],
  ])('서버 %s · 화면 %s → %s', (server, web, other) => {
    expect(isOtherBuild(server, web)).toBe(other);
  });
});

describe('요청은 시간 한도 안에서만 기다려요(10/29 개선 회의 A3)', () => {
  it('답이 오면 그대로 돌려주고, 한도 타이머는 지워요', async () => {
    vi.useFakeTimers();
    try {
      const ok = new Response('{}', { status: 200 });
      const fetcher = vi.fn(async (_url: string, _init: RequestInit) => ok);
      expect(await fetchWithin(fetcher, '/api/x', { method: 'GET' })).toBe(ok);
      expect(fetcher.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('서버에 닿지 못하면 던지지 않고 offline이에요', async () => {
    const fetcher = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await fetchWithin(fetcher, '/api/x', {})).toBe('offline');
  });

  it('15초 안에 답이 없으면 요청을 끊고 timeout이에요. 저절로 다시 보내지 않아요', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetcher = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => {
              aborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      );
      const pending = fetchWithin(fetcher, '/api/rooms/chat', { method: 'POST' });
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe('timeout');
      expect(aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
