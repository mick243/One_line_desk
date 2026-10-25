// 쓰기 실행 경계(ADR-03). LLM은 제안만 하고, 사람의 확인은 쓰기마다 정확히 한 번이에요.
export type PlanState = 'proposed' | 'executing' | 'done' | 'blocked' | 'expired' | 'cancelled';

const NEXT: Record<PlanState, PlanState[]> = {
  proposed: ['executing', 'expired', 'cancelled'],
  executing: ['done', 'blocked'],
  done: [],
  blocked: [],
  expired: [],
  cancelled: [],
};

export function canTransition(from: PlanState, to: PlanState): boolean {
  return NEXT[from].includes(to);
}

/** DB에서는 "상태가 proposed일 때만 바꾸기"(조건부 UPDATE)로 한 번만 이기게 해요. 이 함수는 그 규칙의 기준이에요. */
export function transition(from: PlanState, to: PlanState): PlanState {
  if (!canTransition(from, to)) throw new Error(`plan 상태를 ${from}에서 ${to}로 바꿀 수 없어요`);
  return to;
}
