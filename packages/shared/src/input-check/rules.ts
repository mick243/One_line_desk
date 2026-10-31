// 공통 입력 검사 규칙(ADR-11). 브라우저와 서버가 이 파일 하나를 같이 써요.
// 규칙을 바꾸면 RULES_VERSION을 올려요. 서버는 같은 버전 규칙으로 다시 검사해요.
// 2: 외국인등록번호·띄어 쓴 주민번호·카드(Luhn)·계좌·여권·면허·콜론 없는 비밀번호 문장·PEM 키, 0폭·글 방향 문자 지우기, 제어 문자 잠금(QA-2·3·10·19)
// 3: 사용자 폴더 경로(C:\Users\<이름>, /home/<이름>, /Users/<이름>)의 이름 부분 가림. IT 오류 문장에 자주 들어 있어요(10/31 넓힐 후보 ②)
export const RULES_VERSION = 3;

export type LockKind = 'key-token' | 'grade3' | 'health' | 'control';

export interface LockRule {
  kind: LockKind;
  name: string;
  pattern: RegExp;
  /** 패턴에 걸린 글자를 한 번 더 확인해요(카드 번호의 Luhn 검사). 없으면 패턴만 봐요. */
  confirm?: (match: string) => boolean;
}

/** 화면에 안 보이는 0폭·서식·글 방향 문자. 검사 전에 지우고, 지운 글을 저장·표시해요(QA-3·19). */
export const INVISIBLE_CHARS = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** 줄바꿈·tab을 뺀 제어 문자. 보내기를 잠그고, 서버는 어느 경로든 400으로 돌려보내요(QA-10). */
export const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** 카드 번호 끝자리 검사(Luhn). 13~19자리 숫자만 봐요. */
export function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// 0으로 시작하는 전화번호 모양. 계좌 낱말 근처의 숫자라도 전화번호면 막지 않아요.
const PHONE_AHEAD = String.raw`(?!(?:\+82[-\s]?)?0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}(?![\d-]))`;

// 보내기 전에 막는 것. 지우기 전에는 보내기 버튼이 잠겨요. 검사는 0폭 문자를 지우고 NFKC(전각 숫자 → 반각)로 바꾼 글에 해요.
export const LOCK_RULES: LockRule[] = [
  { kind: 'control', name: '제어 문자', pattern: CONTROL_CHAR },
  { kind: 'key-token', name: 'AWS 접근 키', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'key-token', name: 'GitHub 토큰', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'key-token', name: 'Slack 토큰', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'key-token', name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/ },
  { kind: 'key-token', name: 'API 키', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'key-token', name: 'PEM 개인 키', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // 영문과 숫자가 섞인 32자 이상 무작위 문자열
  { kind: 'key-token', name: '긴 무작위 문자열', pattern: /(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}/ },
  // 생년월일 6자리 + (붙임·-·공백) + 1~8 + 6자리. 외국인등록번호(뒷자리 5~8)도 같은 모양이에요.
  { kind: 'grade3', name: '주민·외국인등록번호', pattern: /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[-\s]?[1-8]\d{6}(?!\d)/ },
  // 13~19자리(-·공백으로 끊어도 돼요) + Luhn
  { kind: 'grade3', name: '카드 번호', pattern: /(?<![\d-])\d(?:[-\s]?\d){12,18}(?![\d-])/, confirm: luhnValid },
  // 은행 계좌 대표 형식(3-3-6, 3-2-6, 6-2-6, 4-3-6)
  { kind: 'grade3', name: '계좌 번호', pattern: /(?<![\d-])(?:\d{3}-\d{2,3}-\d{6}|\d{6}-\d{2}-\d{6}|\d{4}-\d{3}-\d{6})(?![\d-])/ },
  // "계좌·통장·입금·급여" 바로 뒤의 10~14자리 숫자(전화번호 모양은 빼요)
  {
    kind: 'grade3',
    name: '계좌 번호(낱말 근처)',
    pattern: new RegExp(String.raw`(?:계좌|통장|입금|급여)\D{0,12}?(?<![\d-])${PHONE_AHEAD}\d(?:[-\s]?\d){9,13}(?![\d-])`),
  },
  {
    kind: 'grade3',
    name: '여권 번호',
    pattern: /(?:여권|passport)\D{0,12}?(?<![A-Za-z0-9])(?:[A-Za-z]{1,2}\d{7,8}|[A-Za-z]\d{3}[A-Za-z]\d{4})(?![A-Za-z0-9])/i,
  },
  { kind: 'grade3', name: '운전면허 번호', pattern: /(?<![\d-])\d{2}-\d{2}-\d{6}-\d{2}(?![\d-])/ },
  { kind: 'grade3', name: '비밀번호 값', pattern: /(?:비밀번호|비번|패스워드|password|passwd|pwd)\s*[:=]\s*\S+/i },
  // "비밀번호는 Abcd1234!", "my password is …": 숫자가 섞인 6자 이상 영문·숫자·기호 값. "비밀번호 재설정해 주세요"는 막지 않아요.
  {
    kind: 'grade3',
    name: '비밀번호 문장',
    pattern: /(?:비밀번호|비번|패스워드|(?<![A-Za-z])(?:password|passwd|pwd|pw)(?![A-Za-z]))\s*(?:[은는이가을를도]|is)?\s*(?=[!-~]*\d)[!-~]{6,}/i,
  },
];

// 진단명·알레르기 사전. 병가 같은 제도 이름은 넣지 않아요. 띄어 쓴 낱말은 붙여 써도("임신중") 같이 봐요.
export const HEALTH_TERMS = ['알레르기', '알러지', '당뇨', '고혈압', '우울증', '공황장애', '천식', '아토피', '임신 중', '항암'];

export const LOCK_MESSAGE: Record<LockKind, string> = {
  'key-token': '키나 토큰처럼 보이는 글자가 있어서 보낼 수 없어요. 그 부분을 지우고 다시 보내 주세요',
  grade3: '주민번호·카드·계좌·비밀번호 같은 정보는 받지 않아요. 지우고 다시 보내 주세요',
  health: '알레르기 같은 건강 정보는 받지 않아요',
  control: '보이지 않는 특수 글자가 있어요. 지우고 다시 보내 주세요',
};

export type MaskKind = 'path' | 'email' | 'ip';

// 바꾼 뒤에만 보내요. 풀기는 없어요.
export const MASK_RULES: { kind: MaskKind; label: string; pattern: RegExp }[] = [
  // 사용자 폴더 이름(대개 사번·이름)을 바꿔요. 그 뒤 경로(\AppData\…)는 남겨서 어떤 오류인지 알아볼 수 있게 해요.
  {
    kind: 'path',
    label: '[사용자 폴더]',
    pattern: /(?:\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+|(?<![\w.-])\/(?:home|Users)\/)[^\\/\s"'<>:|?*]+/gi,
  },
  { kind: 'email', label: '[이메일]', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'ip', label: '[IP]', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];

export const MASK_NAME: Record<MaskKind, string> = { path: '사용자 폴더', email: '이메일', ip: 'IP' };
