// 관리자 화면 "AI 정답률"(11/5 시험, AI 보완 1번). 운영자만 보는 읽기 전용 화면 하나예요(R7 예외, 11/5 사용자 결정).
// 정답 단 가상 문장으로 낱말 규칙과 AI가 각각 몇 개 맞히는지 비교해요. 직원이 쓴 글·사람 자료는 없어요.
// 되돌릴 기준: #30 머지 상태(이 파일째 지워요).

export interface AiEvalScore {
  task: string;
  /** "홈 채팅(무엇을 하려는지)" */
  label: string;
  total: number;
  rule: number;
  /** AI로 아직 안 쟀으면 null */
  ai: number | null;
  aiOnly: number;
  ruleOnly: number;
}

/** 낱말 규칙이나 AI가 틀린 문장 한 줄. 값은 모두 화면 말로 바꾼 라벨이에요. */
export interface AiEvalRow {
  label: string;
  text: string;
  expect: string;
  rule: string;
  ruleOk: boolean;
  ai: string | null;
  aiOk: boolean | null;
  why: string | null;
}

/** GET /api/ops/ai-eval · POST /api/ops/ai-eval/run 응답(운영자만) */
export interface AiEvalResponse {
  scores: AiEvalScore[];
  misses: AiEvalRow[];
  /** AI로 잰 때와 모델. 아직 안 쟀으면 null이에요(서버 메모리에만 있어서 다시 켜면 비어요). */
  measured: { at: string; model: string } | null;
  /** [AI로 다시 재기]: 지금 재는 중인지, 누를 수 있는지, 못 누르면 이유 */
  run: { running: boolean; allowed: boolean; reason: string | null };
}
