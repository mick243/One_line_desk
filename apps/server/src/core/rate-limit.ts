// 가명 ID × 동작별 요청 횟수(ADR-13). 서버 메모리에 횟수만 둬요. 서버를 다시 켜면 처음으로 돌아가요.
type LimitedAction =
  | 'ask'
  /** 홈 AI 채팅(ADR-27) */
  | 'home-ask'
  | 'inquiry'
  | 'it-help'
  | 'rooms.search'
  | 'draft'
  | 'post'
  | 'vote'
  /** MCP 도구마다 따로 세요. 이름은 도구 레지스트리 이름 그대로예요. */
  | `mcp.${string}`
  | 'people.search'
  | 'invite';

const WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly now: () => number,
    private readonly perMinute: () => number,
  ) {}

  /** 지금 메모리에 든 횟수 창 수(시험·정리 확인용) */
  get size(): number {
    return this.windows.size;
  }

  /** 상한 안이면 true. 넘으면 429와 "요청이 많아요. 잠시 뒤에 다시 해 주세요"예요. */
  hit(pseudonymId: string, action: LimitedAction): boolean {
    const key = `${pseudonymId}:${action}`;
    const at = this.now();
    const w = this.windows.get(key);
    if (!w || at - w.start >= WINDOW_MS) {
      this.windows.set(key, { start: at, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= this.perMinute();
  }

  /** 1분 창이 지난 횟수를 지워요(보관 회차가 한 시간마다 불러요). 지운 개수를 돌려줘요. */
  sweep(now: number): number {
    let removed = 0;
    for (const [key, w] of this.windows) {
      if (now - w.start >= WINDOW_MS) {
        this.windows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
