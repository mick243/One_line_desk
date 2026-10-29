// 응답을 어떻게 읽을지 정하는 순수 함수(10/29 배포 준비 회의 D1·D2). 화면 없이 시험해요(net.test.ts).

/** 배포 중(관문 502·503·504)이라 우리 서버 글 대신 정해진 문구를 보여 줄 때 */
export const UNAVAILABLE_MESSAGE = '지금 앱을 고치는 중이에요. 쓴 글은 이 화면에 있어요. 잠시 뒤에 다시 보내 주세요';
/** 요청이 서버에 닿지 못했을 때(망 끊김) */
export const OFFLINE_MESSAGE = '지금 앱에 연결하지 못했어요. 쓴 글은 이 화면에 있어요. 연결을 확인하고 다시 보내 주세요';

/**
 * 우리 서버가 답하지 않은 응답인지. 배포로 서버가 내려간 사이 관문이 주는 502·503·504와,
 * 관문의 HTML 오류 쪽(JSON이 아닌 4xx·5xx)은 서버 글이 없어서 정해진 문구로 바꿔요. 0은 요청이 닿지 못한 경우예요.
 */
export function unavailableMessage(status: number, isJson: boolean): string | null {
  if (status === 0) return OFFLINE_MESSAGE;
  if (status === 502 || status === 503 || status === 504) return UNAVAILABLE_MESSAGE;
  if (status >= 400 && !isJson) return UNAVAILABLE_MESSAGE;
  return null;
}

/**
 * 다시 보내도 한 번만 처리되게 붙이는 요청 번호(배포 준비 회의 D4). crypto.randomUUID는 https(보안 맥락)에서만 있어서,
 * http 사내 주소로 열면 문의·초대·채팅이 통째로 깨졌어요. 없으면 getRandomValues로 16바이트를 만들어요(32자 16진수).
 */
export function newRequestId(c: Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>> = crypto): string {
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 서버가 알려 준 판이 이 화면의 판과 다른지. 판을 넣지 않은 개발(dev)이나 머리가 없는 응답은 비교하지 않아요. */
export function isOtherBuild(serverBuild: string | null, webBuild: string): boolean {
  return serverBuild !== null && serverBuild !== '' && serverBuild !== 'dev' && webBuild !== 'dev' && serverBuild !== webBuild;
}
