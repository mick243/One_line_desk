import type { AppDestination, Kind, ModuleKind } from '@one-line-desk/shared';

// 기능 목록 하나를 홈 목록과 기능 페이지가 같이 써요(10/26 화면 구조 변경).
// 페이지 제목은 그 화면에서 묻는 질문 하나예요. 버튼은 누르면 무엇을 하는지 적어요(10/26 디자인 정리).
// 예시 문장은 누르면 그 페이지 입력 칸에 채우기만 해요. 보내지는 않아요.

export interface Feature {
  module: ModuleKind;
  page: AppDestination;
  title: string;
  /** 기능 페이지 큰 제목: 이 화면이 묻는 질문 하나 */
  question: string;
  /** 홈 목록 한 줄: 무엇을 쓰면 무엇을 해 주는지 */
  short: string;
  summary: string;
  placeholder: string;
  submit: string;
  examples: string[];
}

export const FEATURES: Feature[] = [
  {
    module: 'navi',
    page: 'navi',
    title: '담당 찾기',
    question: '어떤 일인지 한 줄로 알려 주세요',
    short: '어느 부서에 물어볼지 바로 알려 줘요',
    summary: '업무 분장표에서 담당 부서와 지금 할 일을 찾아 줘요.',
    placeholder: '예) 법인카드를 잃어버렸어요',
    submit: '담당 찾기',
    examples: ['법인카드 잃어버렸어요', '명함 새로 만들고 싶어요', '재직증명서 어디서 떼요?'],
  },
  {
    module: 'rooms',
    page: 'rooms',
    title: '회의실',
    question: '언제, 몇 명이 쓰나요?',
    short: '빈 방을 찾고 확인 한 번으로 예약해요',
    summary: '한 줄로 쓰면 빈 방을 찾아요. 확인 한 번이면 예약돼요.',
    placeholder: '예) 내일 3시 6명',
    submit: '빈 방 찾기',
    examples: ['내일 3시 6명', '다음 주 화요일 10시부터 2시간 4명', '금요일 오전 11시 화상회의 8명'],
  },
  {
    module: 'notices',
    page: 'notices',
    title: '공지',
    question: '어떤 공지를 찾나요?',
    short: '공지 제목과 원문 링크를 찾아 줘요',
    summary: '제목·게시일·원문 링크를 찾아 줘요. 본문은 원문에서 봐요.',
    placeholder: '예) 연말정산',
    submit: '공지 찾기',
    examples: ['연말정산', '건강검진', '재택근무'],
  },
  {
    module: 'pantry',
    page: 'board',
    title: '같이 채워요',
    question: '우리 층 탕비실에 뭐가 필요해요?',
    short: '필요한 간식·비품을 올리고 +1해요',
    summary: '올리고 +1하면 총무가 모아서 예산 안에서 주문해요.',
    placeholder: '예) 제로콜라',
    submit: '미리 보기',
    examples: ['제로콜라', '녹차 티백', '포스트잇'],
  },
];

/** 다른 기능으로 옮길 때 갈 페이지. "모름"은 담당 찾기로 가요. */
export function pageOfKind(kind: Kind): AppDestination {
  return FEATURES.find((f) => f.module === kind)?.page ?? 'navi';
}
