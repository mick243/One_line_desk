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

// ── 공지 알림 대상(11/6 사용자 결정 "정확도를 먼저 재 줘", ADR-09 개정) ──
// 정답 단 가상 공지로 낱말 규칙과 AI가 제안한 대상을 견줘요. 사람 수는 앱에 든 가상 직원으로 세고, 이름은 내보내지 않아요.

/** 한 쪽(낱말 규칙 또는 AI)의 셈 */
export interface NoticeEvalSide {
  /** 조건(모두·부서·층·역할)이 정답과 같은 공지 수 */
  exact: number;
  /** 놓친 사람이 0인 공지 수(답 못 한 공지는 세지 않아요) */
  missedNone: number;
  /** 놓친 사람 합: 받아야 하는데 못 받는 사람 */
  missed: number;
  /** 더 받은 사람 합: 받지 않아도 되는데 받는 사람 */
  extra: number;
  /** 답 못 한 공지 수(AI만 생겨요) */
  failed: number;
}

/** 공지 한 건에 낸 답. 답 못 했으면 사람 수가 null이에요. */
export interface NoticeEvalAnswer {
  /** "개발팀 · 5층 · 팀장" · "모두" · "답 못 함" */
  label: string;
  ok: boolean;
  missed: number | null;
  extra: number | null;
}

/** 낱말 규칙이나 AI가 틀린 공지 한 건(가상 공지) */
export interface NoticeEvalRow {
  group: string;
  title: string;
  body: string;
  expect: string;
  rule: NoticeEvalAnswer;
  ai: NoticeEvalAnswer | null;
  why: string | null;
}

export interface NoticeEvalView {
  total: number;
  /** 받아야 할 사람 합(공지마다 센 수를 더해요) */
  shouldGet: number;
  /** 사람 수를 센 가상 직원 수 */
  people: number;
  rule: NoticeEvalSide;
  /** AI로 아직 안 쟀으면 null */
  ai: NoticeEvalSide | null;
  misses: NoticeEvalRow[];
}

/** GET /api/ops/ai-eval · POST /api/ops/ai-eval/run 응답(운영자만) */
export interface AiEvalResponse {
  scores: AiEvalScore[];
  misses: AiEvalRow[];
  /** 공지 알림 대상 정답률(11/6). [AI로 다시 재기]가 같이 재요. */
  notices: NoticeEvalView;
  /** AI로 잰 때와 모델. 아직 안 쟀으면 null이에요(서버 메모리에만 있어서 다시 켜면 비어요). */
  measured: { at: string; model: string } | null;
  /** [AI로 다시 재기]: 지금 재는 중인지, 누를 수 있는지, 못 누르면 이유 */
  run: { running: boolean; allowed: boolean; reason: string | null };
}
