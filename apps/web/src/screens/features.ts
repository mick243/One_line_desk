import type { AppDestination, Kind, ModuleKind, ModuleSwitch, RouterModule } from '@one-line-desk/shared';

// 기능 목록 하나를 홈 목록과 기능 페이지가 같이 써요(10/26 화면 구조 변경).
// 페이지 제목은 그 화면에서 묻는 질문 하나예요. 버튼은 누르면 무엇을 하는지 적어요(10/26 디자인 정리).
// 예시 문장은 누르면 그 페이지 입력 칸에 채우기만 해요. 보내지는 않아요.

export interface Feature {
  /** 묻기 페이지가 있는 기능만이에요. 카페(cafeteria)는 따로 그리는 페이지예요(modules/cafe, ADR-29). */
  module: RouterModule;
  page: AppDestination;
  title: string;
  /** 기능 페이지 큰 제목: 이 화면이 묻는 질문 하나 */
  question: string;
  /** 홈 목록 한 줄: 무엇을 쓰면 무엇을 해 주는지 */
  short: string;
  summary: string;
  placeholder: string;
  submit: string;
  /** 없으면 "이렇게 써 보세요" 줄을 그리지 않아요. 문의함은 중요한 일이라 예시 없이 자기 상황을 쓰게 해요(10/28). */
  examples?: string[];
}

export const FEATURES: Feature[] = [
  {
    module: 'navi',
    page: 'navi',
    title: '문의함',
    question: '무엇을 문의할까요?',
    short: '문의를 쓰면 받을 팀과 지금 할 일을 찾고, 그 팀에 바로 문의해요',
    summary: '업무 분장표에서 받을 팀과 지금 할 일을 찾아 줘요. [○○에 문의하기]를 누르면 문의 양식이 열려요. 받는 곳은 보내기 전에 보고 바꿀 수 있어요.',
    placeholder: '예) 법인카드를 잃어버렸어요. 정지는 어떻게 해요?',
    submit: '받을 팀 찾기',
  },
  {
    module: 'rooms',
    page: 'rooms',
    title: '회의실',
    question: '회의실, 무엇을 할까요?',
    short: '빈 회의실 찾기·예약·장비 대여를 한 줄로 해요',
    summary: '물어보면 빈 회의실을 찾고, "잡아 줘"처럼 시키면 바로 예약해요. 회의실 현황을 물으면 아래에 회의실 카드가 펼쳐져요.',
    placeholder: '예) 내일 3시 6명',
    submit: '빈 회의실 찾기',
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

// "링크만"·회의실 쓰기 끔일 때 소개 글(L-50, QA-13). 이 일은 그룹웨어에서 한다고 먼저 알려요.
const LINK_COPY: Record<ModuleKind, Pick<Feature, 'short' | 'summary'>> = {
  navi: { short: '담당 안내는 그룹웨어에서 봐요', summary: '지금은 담당 안내를 그룹웨어에서 봐요. 한 줄로 쓰면 그룹웨어로 가는 길을 알려 줘요.' },
  rooms: { short: '회의실 예약은 그룹웨어에서 해요', summary: '지금은 회의실 예약을 그룹웨어에서 해요. 한 줄로 쓰면 그룹웨어로 가는 길을 알려 줘요.' },
  notices: { short: '공지는 그룹웨어 게시판에서 봐요', summary: '지금은 공지를 그룹웨어 게시판에서 봐요. 한 줄로 쓰면 게시판으로 가는 길을 알려 줘요.' },
  pantry: { short: '비품 요청은 그룹웨어에서 해요', summary: '지금은 비품 요청을 그룹웨어에서 해요. 한 줄로 쓰면 그룹웨어로 가는 길을 알려 줘요.' },
  cafeteria: { short: '카페 주문은 안내 링크에서 해요', summary: '지금은 카페 주문을 앱에서 받지 않아요. 아래 링크에서 카페 안내를 봐요.' },
};

/** "링크만"일 때 그 기능 페이지 머리 글(카페 페이지도 써요). */
export function linkSummary(module: ModuleKind): string {
  return LINK_COPY[module].summary;
}
const ROOMS_READ_ONLY: Pick<Feature, 'short' | 'summary'> = {
  short: '빈 회의실을 찾아 줘요. 예약은 그룹웨어에서 해요',
  summary: '한 줄로 쓰면 빈 회의실과 장비 현황을 찾아요. 예약·대여는 그룹웨어에서 해요.',
};
/** 채팅 자동 실행이 꺼졌을 때(ADR-19): 시켜도 바로 예약하지 않고 카드에서 확인해요. */
const ROOMS_CONFIRM: Pick<Feature, 'short' | 'summary'> = {
  short: '빈 회의실을 찾고 확인 한 번으로 예약해요',
  summary: '한 줄로 쓰면 빈 회의실을 찾아요. 카드에서 확인 한 번이면 예약돼요. 회의실 현황을 물으면 아래에 회의실 카드가 펼쳐져요.',
};

/**
 * 문의함(11/5 사용자 결정, ADR-26 보강): 홈 채팅이 켜져 있으면 받을 팀 찾기는 홈이 앞문이라, 이 페이지는 문의를 주고받고 처리하는 곳이에요.
 * 우리 팀에 온 문의 → 내 문의 → 휴가 신청 → 받을 팀 찾기 순서예요. 홈 채팅을 끈 회사는 지금처럼 찾기가 맨 위예요.
 */
const NAVI_INBOX: Pick<Feature, 'question' | 'short' | 'summary'> = {
  question: '주고받은 문의를 여기서 봐요',
  short: '받은 문의를 처리하고, 내 문의·휴가 요청의 처리 상태와 답장을 봐요',
  summary: '우리 팀에 온 문의를 처리하고, 내가 보낸 문의·휴가 요청의 처리 상태와 답장을 봐요. 받을 팀은 홈 채팅이나 맨 아래 칸에서 찾아요.',
};

/** 지금 스위치에 맞춘 기능 소개. 켬이면 그대로, 링크만·회의실 쓰기 끔이면 "그룹웨어에서 해요", 채팅 자동 실행 끔이면 "확인 한 번으로"로 바꿔요. */
export function featureFor(
  feature: Feature,
  switches: { modules: Record<ModuleKind, ModuleSwitch>; roomsWrite: boolean; autoActions?: boolean; homeAsk?: boolean },
): Feature {
  const value = switches.modules[feature.module];
  if (value === 'link') return { ...feature, ...LINK_COPY[feature.module] };
  if (feature.module === 'navi' && value === 'on' && switches.homeAsk === true) return { ...feature, ...NAVI_INBOX };
  if (feature.module === 'rooms' && value === 'on' && !switches.roomsWrite) return { ...feature, ...ROOMS_READ_ONLY };
  if (feature.module === 'rooms' && value === 'on' && switches.autoActions === false) return { ...feature, ...ROOMS_CONFIRM };
  return feature;
}

/** 다른 기능으로 옮길 때 갈 페이지. "모름"은 문의함으로 가요. */
export function pageOfKind(kind: Kind): AppDestination {
  return FEATURES.find((f) => f.module === kind)?.page ?? 'navi';
}
