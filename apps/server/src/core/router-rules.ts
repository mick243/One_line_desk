import type { ModuleKind } from '@one-line-desk/shared';

// 앞문 라우터 규칙 사전(ADR-02). 규칙이 하나만 가리키면 LLM 결과와 맞춰 확신을 높여요.
// 경계 문장("회의실 TV가 안 켜져요")은 둘 이상을 가리켜 되묻기로 가요. 사전은 10일 차 측정 뒤 넓혀요.
export const ROUTER_RULES: Record<ModuleKind, RegExp[]> = {
  rooms: [/회의실|미팅룸|미팅 ?룸|회의 ?(잡|예약)|방 ?(잡|예약|있)|\d+\s*명.*(방|회의)/],
  notices: [/공지|안내문|게시판|공문|언제였|공고|소식/],
  pantry: [/간식|음료|커피|콜라|사이다|과자|라면|비품|탕비실|티백|우유|넣어 ?(주|줘)|채워/],
  navi: [/어디서|어디에|누구(한테|에게)|담당|신청|분실|잃어버|발급|처리 기간|변경하|재발급|안 ?(돼|되|켜)|고장|오류|에러/],
};

/** 규칙이 가리키는 종류들. 비면 규칙이 모르는 문장이에요. */
export function matchRules(text: string, candidates: readonly ModuleKind[]): ModuleKind[] {
  return candidates.filter((kind) => ROUTER_RULES[kind].some((re) => re.test(text)));
}
