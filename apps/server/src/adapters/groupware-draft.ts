// 그룹웨어 기안 어댑터 계약(11/6 사용자 결정, ADR-24 보강). 아직 실제 어댑터는 없어요.
// 국내 그룹웨어는 기안(신청서 올리기) API가 비공개이거나 고객사 신청제인 곳이 많아서, 기본은 링크·[신청 내용 복사]예요.
// API가 열린 회사에 어댑터를 붙일 때는 그룹웨어로 보내는 몸통을 반드시 assertLeaveDraftPayload에 통과시켜요.
// 지키는 것:
// ① 상신(요청) 상태로만 올려요. 결재는 늘 그룹웨어 결재선이 해요(앱은 결재 권한 0).
// ② 승인·결재선·결재 건너뛰기 칸을 넣지 않아요. 해외 HR API 일부는 관리자 키로 승인 상태를 보내거나 결재를 건너뛸 수 있어요
//    (예: 승인 생략 옵션, 관리자 승인 상태 값). 이런 칸이 섞이면 결재선이 통째로 사라져요.
// ③ 같은 신청은 멱등 키 하나로 한 번만 올려요.
// ④ 사유 같은 글은 이 몸통에만 실려 메모리에서 지나가요. 몸통을 로그·감사·DB에 남기지 않아요(ADR-10).

/** 몸통 어디에 있어도 안 되는 칸 이름(대소문자·밑줄·하이픈 무시) */
const FORBIDDEN_KEY = /^(approved|approval\w*|approver\w*|approve\w*|autoapprov\w*|skipapproval|decision\w*|approvedby|approvalline|결재.*|승인.*)$/;

/** 상태 칸이 있다면 허용하는 값(상신·요청) */
const ALLOWED_STATUS = new Set(['requested', 'pending', 'submitted', 'draft', '상신', '요청']);

const norm = (key: string) => key.toLowerCase().replace(/[_\-\s]/g, '');

function walk(value: unknown, path: string, problems: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, problems));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    const k = norm(key);
    if (FORBIDDEN_KEY.test(k)) problems.push(`${here}: 승인·결재선 칸은 보낼 수 없어요`);
    if ((k === 'status' || k === 'state') && !(typeof v === 'string' && ALLOWED_STATUS.has(v.toLowerCase())))
      problems.push(`${here}: 상태는 상신·요청만 보낼 수 있어요`);
    walk(v, here, problems);
  }
}

/**
 * 그룹웨어로 보낼 휴가 기안 몸통을 검사해요. 어긋나면 던져요(보내지 않아요).
 * 오류 글에는 칸 이름만 담고 값(사유 등)은 담지 않아요.
 */
export function assertLeaveDraftPayload(payload: Record<string, unknown>, idempotencyKey: string): void {
  const problems: string[] = [];
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) problems.push('멱등 키가 없거나 모양이 달라요');
  walk(payload, '', problems);
  if (problems.length) throw new Error(`그룹웨어 기안 몸통이 계약에 어긋나요: ${problems.join(' / ')}`);
}
