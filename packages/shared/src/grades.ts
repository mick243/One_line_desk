// 데이터 등급. AI 게이트웨이는 0·1만 통과시키고, 무보관 계약 확인 전에는 0만 통과시켜요(ADR-10, R6).
export const GRADE = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
} as const;

export type Grade = (typeof GRADE)[keyof typeof GRADE];

export function gatewayAllows(grade: Grade, contractConfirmed: boolean): boolean {
  if (grade >= GRADE.confidential) return false;
  return contractConfirmed || grade === GRADE.public;
}
