import type { AppDestination, Card } from '../cards';

// 홈 AI 채팅 "나에게 해당하는 일"(11/3 사용자 결정, ADR-27, 개선 회의 D8 해제).
// AI는 질문 뜻(구조 값)만 해석하고, 내 일은 서버가 각 모듈 서비스에서 규칙으로 모아요. 내 자료는 AI에 가지 않아요.
// 홈 칸은 예약·신청을 하지 않아요. 다른 일이면 맞는 기능 페이지로 옮기는 카드만 줘요(D8 조건).

/** 홈이 모으는 내 일 종류 */
export const HOME_KINDS = ['reservations', 'loans', 'invites', 'inquiries', 'leave', 'pantry', 'inbox'] as const;
export type HomeKind = (typeof HOME_KINDS)[number];

/** 물은 때. recent는 기간을 말하지 않았을 때예요(일정은 앞으로 7일, 요청은 보관 중인 7일). */
export const HOME_PERIODS = ['today', 'tomorrow', 'this-week', 'next-week', 'recent'] as const;
export type HomePeriod = (typeof HOME_PERIODS)[number];

/** 다른 일이면 옮겨 갈 기능 페이지 */
export const HOME_MOVE_TO = ['rooms', 'navi', 'notices', 'board'] as const;
export type HomeMoveTo = (typeof HOME_MOVE_TO)[number];

export const HOME_INTENTS = ['mine', 'move', 'unknown'] as const;
export type HomeIntent = (typeof HOME_INTENTS)[number];

/** 홈 질문 글 최대 길이. 원문은 POST 본문·요청 메모리에서만 다뤄요. */
export const HOME_ASK_MAX = 1000;

export const HOME_PERIOD_LABEL: Record<HomePeriod, string> = {
  today: '오늘',
  tomorrow: '내일',
  'this-week': '이번 주',
  'next-week': '다음 주',
  recent: '요즘',
};

export const HOME_KIND_LABEL: Record<HomeKind, string> = {
  reservations: '내 예약',
  loans: '장비 대여',
  invites: '초대받은 회의',
  inquiries: '내 문의',
  leave: '휴가 요청',
  pantry: '같이 채워요',
  inbox: '받은 문의',
};

/**
 * 기능 페이지로 가는 버튼. 쓰기 버튼은 없어요.
 * handoff는 서버가 정한 고정 문장(사람이 쓴 글 아님)이고, 앱 메모리로만 그 페이지에 넘겨요. auto면 그 페이지가 바로 찾아요(읽기만).
 */
export interface HomeOpen {
  text: string;
  to: AppDestination;
  handoff?: string;
  auto?: boolean;
}

/** 내 일 한 줄. 남의 이름은 없어요(초대받은 회의의 부른 사람만 예외, ADR-17). 글·연차 숫자도 없어요. */
export interface HomeItem {
  /** 화면 key. 행 ID나 사람을 가리키는 값을 넣지 않아요. */
  id: string;
  kind: HomeKind;
  title: string;
  /** "11월 3일(화) 15:00~16:00", "11월 2일 보냄" */
  when: string;
  detail: string | null;
  open: HomeOpen;
}

/** POST /api/home/ask 응답. 질문 글은 돌려주지 않아요. */
export interface HomeAskResponse {
  intent: HomeIntent;
  period: HomePeriod;
  kinds: HomeKind[];
  /** 실제 모델이 질문을 해석했으면 'ai'(무보관 계약 확인 + 실제 공급자). 아니면 규칙이에요. "AI 정리"는 ai일 때만 붙여요. */
  by: 'ai' | 'rule';
  headline: string;
  items: HomeItem[];
  /** 남은 연차 보기처럼 본인 화면의 기존 카드로 가는 버튼(숫자는 그 화면이 열 때 계산해요) */
  links: HomeOpen[];
  /** 옮기기·모름 카드(move/unknown일 때) */
  cards: Card[];
}

/** GET /api/home/today: 홈 첫 화면 "오늘·이번 주 내 일". 열 때 한 번 불러요(폴링 아님). */
export interface HomeTodayResponse {
  enabled: boolean;
  items: HomeItem[];
}

/** 홈 칸 아래 문구(D8 조건) */
export const HOME_ASK_NOTE = '나에게 해당하는 일을 찾아요. 여기서는 예약·신청을 하지 않아요';
