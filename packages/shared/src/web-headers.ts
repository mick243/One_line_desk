// 응답 보안 머리(10/29 배포 준비 회의 B1). 서버가 화면을 줄 때와 vite preview가 같이 써요.
// 지금 웹 빌드에는 인라인 스크립트·인라인 스타일 요소·data: 주소·바깥 주소가 없어서 모두 'self'로 묶을 수 있어요.
// React의 style 속성은 CSSOM으로 들어가서 style-src에 걸리지 않아요. 새로 바깥 주소를 쓰려면 여기부터 바꿔요.

export const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** 화면(HTML) 응답 머리. 다른 사이트의 틀(iframe)에 들어가지 못하고, 주소를 넘기지 않고, 카메라 같은 권한을 쓰지 않아요. */
export const HTML_SECURITY_HEADERS = {
  'content-security-policy': HTML_CSP,
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
} as const;

/** HTML이 아닌 응답(API·파일)의 CSP. 문서로 열려도 아무것도 불러오지 못하고 틀에 들어가지 못해요. */
export const NON_HTML_CSP = "default-src 'none'; frame-ancestors 'none'";
