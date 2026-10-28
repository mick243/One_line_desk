// 기록 보관 기간(10/28 사용자 결정). 현업에서 기록이 오래 쌓이면 정신없어서, 접속기록(법정, core/access-record.ts) 말고는
// 모두 7일까지만 둬요. 서버가 한 시간마다 지우고(L-33), 화면 안내(무엇을 남기나요·문의 시트·알림)도 이 값을 그대로 보여 줘요.

export const RECORD_KEEP_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 이 시각(ms)보다 오래된 기록은 지워요. */
export function recordCutoff(now: number): number {
  return now - RECORD_KEEP_DAYS * DAY_MS;
}
