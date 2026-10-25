// 공통 입력 검사 규칙(ADR-11). 브라우저와 서버가 이 파일 하나를 같이 써요.
// 규칙을 바꾸면 RULES_VERSION을 올려요. 서버는 같은 버전 규칙으로 다시 검사해요.
export const RULES_VERSION = 1;

export type LockKind = 'key-token' | 'grade3' | 'health';

export interface LockRule {
  kind: LockKind;
  name: string;
  pattern: RegExp;
}

// 보내기 전에 막는 것. 지우기 전에는 보내기 버튼이 잠겨요.
export const LOCK_RULES: LockRule[] = [
  { kind: 'key-token', name: 'AWS 접근 키', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'key-token', name: 'GitHub 토큰', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'key-token', name: 'Slack 토큰', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'key-token', name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/ },
  { kind: 'key-token', name: 'API 키', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  // 영문과 숫자가 섞인 32자 이상 무작위 문자열
  { kind: 'key-token', name: '긴 무작위 문자열', pattern: /(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}/ },
  { kind: 'grade3', name: '주민등록번호', pattern: /\b\d{6}-?[1-4]\d{6}\b/ },
  { kind: 'grade3', name: '비밀번호 값', pattern: /(?:비밀번호|비번|password|passwd|pwd)\s*[:=]\s*\S+/i },
];

// 진단명·알레르기 사전. 병가 같은 제도 이름은 넣지 않아요.
export const HEALTH_TERMS = ['알레르기', '알러지', '당뇨', '고혈압', '우울증', '공황장애', '천식', '아토피', '임신 중', '항암'];

export const LOCK_MESSAGE: Record<LockKind, string> = {
  'key-token': '키나 토큰처럼 보이는 글자가 있어서 보낼 수 없어요. 그 부분을 지우고 다시 보내 주세요',
  grade3: '주민번호·비밀번호 같은 정보는 받지 않아요. 지우고 다시 보내 주세요',
  health: '알레르기 같은 건강 정보는 받지 않아요',
};

export type MaskKind = 'email' | 'ip';

// 바꾼 뒤에만 보내요. 풀기는 없어요.
export const MASK_RULES: { kind: MaskKind; label: string; pattern: RegExp }[] = [
  { kind: 'email', label: '[이메일]', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'ip', label: '[IP]', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];

export const MASK_NAME: Record<MaskKind, string> = { email: '이메일', ip: 'IP' };
