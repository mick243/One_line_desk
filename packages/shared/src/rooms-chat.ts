import { LOAN_KINDS, type LoanKind } from './api/rooms';

// 회의실 채팅 문장 규칙(ADR-19). 서버(자동 실행 판정)와 브라우저(보내기 전 미리 알림)가 같은 규칙을 써요.
// 자동 실행은 서버가 이 규칙으로 "시키는 문장"이라고 볼 때만 해요(AI는 시키는 문장을 묻는 문장으로 낮출 수만 있어요).
// 그래서 브라우저가 이 규칙으로 "시키는 말이 아니에요"라고 보여 주면 서버도 자동으로 실행하지 않아요.

const LOAN_WORDS: Record<LoanKind, RegExp> = {
  빔프로젝터: /빔\s*프로젝터|프로젝터|빔/i,
  노트북: /노트북|랩탑|랩톱/i,
  '무선 마이크': /무선\s*마이크|마이크/i,
  웹캠: /웹\s*캠/i,
  스피커폰: /스피커\s*폰|스피커/i,
  'HDMI 젠더': /hdmi\s*젠더|hdmi|젠더/i,
};
/** 한 문장에서 빌릴 장비 종류는 셋까지만 봐요. */
const MAX_KINDS = 3;

export const RENT_VERB = /빌려|빌릴|빌리|대여|가져갈|챙겨/;
export const CANCEL_WORD = /취소|반납|돌려\s*(줄|놓|드)/;
const COMMAND_END = /(줘|주세요|줄래|주라|주십시오|부탁(해요?|드려요?|드립니다|합니다)?|해\s*놔|해\s*둬|하자|할게요?|잡아|빌려|(예약|대여)\s*해)$/;
const ASK_END = /(있어|있나|있니|있을까|있는지|되나|될까|돼|가능해|가능할까|어때|인가|일까|나요|까요|어디|언제|몇)$/;

/** 문장에 나온 이동식 장비 종류(정해진 목록 순서, 셋까지) */
export function loanKindsIn(text: string): LoanKind[] {
  return LOAN_KINDS.filter((k) => LOAN_WORDS[k].test(text)).slice(0, MAX_KINDS);
}

/** 장비 이름을 지운 문장. 예약하고 장비도 빌릴 때 "빔프로젝터"가 방 설비(화면) 조건이 되지 않게 해요. */
export function withoutLoanWords(text: string): string {
  return LOAN_KINDS.reduce((t, k) => t.replace(new RegExp(LOAN_WORDS[k].source, 'gi'), ' '), text);
}

/** 시키는 문장인지. "줄래?"는 시키는 말로, "잡아 줄 수 있어?"는 묻는 말로 봐요. */
export function isCommand(text: string): boolean {
  const plain = text.trim().replace(/[\s.!~?]+$/, '');
  if (ASK_END.test(plain)) return false;
  if (text.trim().endsWith('?') && !/줄래$/.test(plain)) return false;
  return COMMAND_END.test(plain);
}

/**
 * 보내기 전 미리 알림(브라우저). 서버의 자동 실행 조건 중 "시키는 문장" 부분만 봐요.
 * - may-run-rent / may-run-reserve: 시키는 말이라 조건이 다 있으면 바로 실행될 수 있어요.
 * - ask: 묻는 말이라 찾기만 해요(서버도 자동 실행하지 않아요).
 * - cancel: 취소·반납은 늘 카드의 버튼으로 한 번 더 확인해요.
 */
export type RoomChatPreview = 'may-run-reserve' | 'may-run-rent' | 'ask' | 'cancel';

export function roomChatPreview(text: string): RoomChatPreview {
  if (CANCEL_WORD.test(text)) return 'cancel';
  if (!isCommand(text)) return 'ask';
  return RENT_VERB.test(text) && loanKindsIn(text).length > 0 && !/잡아|잡고|예약/.test(text) ? 'may-run-rent' : 'may-run-reserve';
}
