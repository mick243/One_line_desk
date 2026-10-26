// 가명 ID × 동작별 요청 횟수(ADR-13). 서버 메모리에 횟수만 둬요. 서버를 다시 켜면 처음으로 돌아가요.
export type LimitedAction =
  'ask' | 'feedback' | 'inquiry' | 'rooms.search' | 'draft' | 'post' | 'vote' | 'mcp.rooms_find_free' | 'mcp.notices_search' | 'people.search' | 'invite';

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly now: () => number,
    private readonly perMinute: () => number,
  ) {}

  /** 상한 안이면 true. 넘으면 429와 "요청이 많아요. 잠시 뒤에 다시 해 주세요"예요. */
  hit(pseudonymId: string, action: LimitedAction): boolean {
    const key = `${pseudonymId}:${action}`;
    const at = this.now();
    const w = this.windows.get(key);
    if (!w || at - w.start >= 60_000) {
      this.windows.set(key, { start: at, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= this.perMinute();
  }
}
