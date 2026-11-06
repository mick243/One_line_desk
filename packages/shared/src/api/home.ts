import type { AppDestination, Card } from '../cards';
import type { ReadNote } from './read-note';

// 홈 AI 채팅 "나에게 해당하는 일"(11/3 사용자 결정, ADR-27, 개선 회의 D8 해제).
// AI는 질문 뜻(구조 값)만 해석하고, 내 일은 서버가 각 모듈 서비스에서 규칙으로 모아요. 내 자료는 AI에 가지 않아요.
// 홈 칸은 예약·신청을 하지 않아요. 다른 일이면 맞는 기능 페이지로 옮기는 카드만 줘요(D8 조건).
// 11/5 사용자 결정(ADR-27 보강): 마이 페이지의 내 예약·내 요청·나에게 온 요청·자리비움 알리기를 홈 채팅으로 옮겼어요.
// 답 아래에서 그 칸을 펼쳐 바로 취소·답하기·자리비움 알리기를 해요(새 예약·신청은 여전히 그 페이지에서 해요).

/**
 * 홈이 모으는 내 일 종류. cafe(11/6 3묶음, ADR-29)는 "이번 달 커피값 얼마야?"처럼 내 카페 값을 묻는 말이에요.
 * 카페 값은 목록 항목이 아니라 서버가 계산한 본인 카드 하나로 와요(물었을 때만, AI에는 질문 글만 가요).
 */
export const HOME_KINDS = ['reservations', 'loans', 'invites', 'inquiries', 'leave', 'pantry', 'inbox', 'cafe'] as const;
export type HomeKind = (typeof HOME_KINDS)[number];

/** 물은 때. recent는 기간을 말하지 않았을 때예요(일정은 앞으로 7일, 요청은 보관 중인 7일). */
export const HOME_PERIODS = ['today', 'tomorrow', 'this-week', 'next-week', 'recent'] as const;
export type HomePeriod = (typeof HOME_PERIODS)[number];

/**
 * 다른 일이면 옮겨 갈 기능 페이지. away는 "자리비움 알리기" 양식이에요(11/3). 11/5부터 홈 답 아래에 바로 펼쳐요.
 * cafe(11/6 3묶음): 사내 카페 주문 문장("2시에 아아 하나 연하게"). 홈 답에 [확인하고 주문하기] 카드가 붙고, 누르면 확인 시트예요(자동 실행 없음).
 */
export const HOME_MOVE_TO = ['rooms', 'navi', 'notices', 'board', 'away', 'cafe'] as const;
export type HomeMoveTo = (typeof HOME_MOVE_TO)[number];

/**
 * mine: 내 일 · move: 기능 페이지로 옮기기 · team-schedule: 같은 팀 일정(11/3, 같은 부서만. 팀 전체 또는 같은 팀 한 사람) · unknown: 그 밖
 */
export const HOME_INTENTS = ['mine', 'move', 'team-schedule', 'unknown'] as const;
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
  cafe: '카페 값',
};

/** 옮겨 갈 곳 이름("알아들은 것" 라벨, 11/5 시험) */
export const HOME_MOVE_LABEL: Record<HomeMoveTo, string> = {
  rooms: '회의실',
  navi: '문의함',
  notices: '공지',
  board: '같이 채워요',
  away: '자리비움 알리기',
  cafe: '카페',
};

/** 홈 질문을 해석한 구조 값(AI든 낱말 규칙이든 같은 모양) */
export interface HomeRead {
  intent: HomeIntent;
  period: HomePeriod;
  kinds: readonly HomeKind[];
  moveTo: HomeMoveTo | null;
}

/**
 * "알아들은 것" 라벨(11/5 시험, AI 보완 2번). 질문 글은 넣지 않고 해석 값만 말로 바꿔요.
 * 예: "이번 주 · 내 일(내 예약·초대받은 회의)", "하려는 일 · 회의실에서 해요", "오늘 · 같은 팀 일정", "모르는 말"
 */
export function homeReadLabel(r: HomeRead): string {
  switch (r.intent) {
    case 'mine':
      return `${HOME_PERIOD_LABEL[r.period]} · 내 일(${r.kinds.length ? r.kinds.map((k) => HOME_KIND_LABEL[k]).join('·') : '전부'})`;
    case 'move':
      // 자리비움은 홈 답 아래에서 바로 알려요(11/5). 다른 곳은 그 기능 페이지에서 해요.
      if (r.moveTo === 'away') return `하려는 일 · ${HOME_MOVE_LABEL.away}`;
      // 카페 주문(11/6)은 홈 답에서 카드로 바로 이어져요(확인 시트는 사람이 눌러야 떠요).
      if (r.moveTo === 'cafe') return '하려는 일 · 카페 주문';
      return r.moveTo ? `하려는 일 · ${HOME_MOVE_LABEL[r.moveTo]}에서 해요` : '하려는 일';
    case 'team-schedule':
      return `${HOME_PERIOD_LABEL[r.period]} · 같은 팀 일정`;
    default:
      return '모르는 말';
  }
}

/** 두 해석이 화면에서 같은 답이 되는지. 라벨이 같으면 같아요(종류 순서는 보지 않아요). */
export function sameHomeRead(a: HomeRead, b: HomeRead): boolean {
  const norm = (r: HomeRead) => homeReadLabel({ ...r, kinds: HOME_KINDS.filter((k) => r.kinds.includes(k)) });
  return norm(a) === norm(b);
}

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
  /** 같은 팀 일정(team-schedule일 때). 그 밖에는 null이에요. */
  team: HomeTeamSchedule | null;
  /** 알아들은 것(11/5 시험). 해석 라벨만이에요. */
  read?: ReadNote;
  /** 자리비움 알리기 미리 채움(11/5). 문장에서 서버가 규칙으로 뽑은 종류·날·시각만이에요(글 없음, 저장 안 함). */
  away?: AwayDraft;
}

/** 홈 문장("내일 오후 외근이에요")에서 뽑은 자리비움 양식 값. 말하지 않은 칸은 비어 있고 양식 기본값을 써요. 사람이 [알리기]를 눌러야 정해져요. */
export interface AwayDraft {
  kind?: AwayKind;
  /** YYYY-MM-DD(한국 날짜), 오늘부터 AWAY_MAX_DAYS 안 */
  date?: string;
  /** HH:MM */
  start?: string;
  end?: string;
}

/**
 * 휴가 칸(11/3 사용자 결정): 하루/오전/오후만이에요. 휴가 종류(연차·병가·공가)·사유·남은 연차 칸은 일부러 없어요.
 * half는 근태 기록에 오전·오후가 없는 반차예요("반나절"로 보여요).
 */
export type AbsencePart = 'full' | 'am' | 'pm' | 'half';

/** 자리비움 종류(정해진 코드만, 자유 글 없음). 직원이 자기 것만 정해요(11/3). */
export const AWAY_KINDS = ['outside', 'trip', 'remote', 'away'] as const;
export type AwayKind = (typeof AWAY_KINDS)[number];
export const AWAY_KIND_LABEL: Record<AwayKind, string> = { outside: '외근', trip: '출장', remote: '재택', away: '자리비움' };
/** 자리비움은 오늘부터 이만큼 뒤까지만 정해요. 7일 보관(ADR-21)과 같아요. */
export const AWAY_MAX_DAYS = 7;
/** 한 사람이 한꺼번에 둘 수 있는 자리비움 수 */
export const AWAY_MAX_ITEMS = 20;

/**
 * 같은 팀 일정 한 칸(11/3 사용자 결정). 이름·날과, 종류마다 정해진 칸만 있어요.
 * - leave: 근태 기록에 들어간(승인된) 휴가. 하루/오전/오후만(종류·사유 없음).
 * - meeting: 그 사람이 앱에서 예약했거나 초대받아 "참석할게요"로 답한 회의. 시간·회의실 이름만(제목·참석자·부른 사람 없음).
 * - away: 그 사람이 스스로 알린 자리비움(외근·출장·재택·자리비움). 시간·종류만.
 * start·end는 그날 안의 "HH:MM"(한국 시간)이고, 하루를 다 덮으면 allDay예요.
 */
export type TeamEntry =
  | { name: string; date: string; what: 'leave'; part: AbsencePart }
  | { name: string; date: string; what: 'meeting'; start: string; end: string; room: string }
  | { name: string; date: string; what: 'away'; start: string; end: string; allDay: boolean; away: AwayKind };

/**
 * 같은 팀 일정 답. 같은 부서 사람에게만 보여요. shown이 false면 entries는 비어 있고 headline이 이유(다른 팀·꺼짐·연결 안 됨)예요.
 */
export interface HomeTeamSchedule {
  shown: boolean;
  /** 묻는 사람의 부서 이름(본인 부서). 다른 팀 이름은 넣지 않아요. */
  team: string;
  /** 같은 팀 한 사람을 물었으면 그 사람 이름, 팀 전체면 null */
  person: string | null;
  entries: TeamEntry[];
  /** 근태 기록을 읽었는지. 거짓이면 휴가 칸이 빠졌다고 알려요(회의·자리비움만 보여요). */
  leaveConnected: boolean;
  /** 그룹웨어 팀 일정 주소(11/4). 보여 주지 못한 답(shown 거짓)에만, 운영 설정에 주소가 있을 때만 와요. */
  link: string | null;
}

export const ABSENCE_PART_LABEL: Record<AbsencePart, string> = { full: '하루', am: '오전', pm: '오후', half: '반나절' };

/** 같은 팀 일정 문구(화면설계 "보안이 보이는 문구"에 올릴 후보, 11/3) */
export const TEAM_SCHEDULE_TEXT = {
  tail: '같은 팀에게만 보여요. 휴가 종류·사유, 회의 참석자는 보이지 않아요',
  otherTeam: '다른 팀의 일정은 볼 수 없어요. 그룹웨어 팀 일정에서 확인해 주세요',
  otherPerson: '다른 팀 사람의 일정은 볼 수 없어요. 그룹웨어 팀 일정에서 확인해 주세요',
  off: '이 회사에서는 팀 일정을 여기서 보여 주지 않아요. 그룹웨어 팀 일정에서 확인해 주세요',
  notConnected: '근태 기록이 연결되지 않아 팀 일정을 볼 수 없어요. 그룹웨어 팀 일정에서 확인해 주세요',
  noTeam: '내 부서를 알 수 없어서 팀 일정을 볼 수 없어요',
  awayMove: '자리비움은 여기서 알려요',
  leaveMissing: '근태 기록이 연결되지 않아 휴가는 보이지 않아요',
} as const;

/** GET /api/navi/away: 내 자리비움(본인 것만). enabled가 거짓이면 양식을 숨겨요(팀 일정이나 담당 찾기가 꺼짐). */
interface AwayItem {
  id: string;
  kind: AwayKind;
  /** ISO 시각 */
  start: string;
  end: string;
}
export interface AwayListResponse {
  enabled: boolean;
  items: AwayItem[];
}
/** POST /api/navi/away: 종류·시작·끝·멱등 키만. 자유 글 칸은 없어요. */
export interface AwaySetRequest {
  kind: AwayKind;
  start: string;
  end: string;
  requestId: string;
}

/** 홈 칸 아래 문구(D8 조건, 11/5 보강: 답 아래에서 바로 처리하는 일이 생겼어요) */
export const HOME_ASK_NOTE = '내 예약·요청·나에게 온 요청을 찾고, 답 아래에서 바로 처리해요. 새 예약·신청은 그 페이지에서 해요';

/** 마이 페이지 안내(11/5 사용자 결정): 옮긴 칸 대신 보여 줘요. 버튼은 홈 채팅에 정해진 문장을 넣어 바로 찾아요(읽기만). */
export const mineMovedNote = (away: boolean) => `내 예약·내 요청·나에게 온 요청${away ? '·자리비움 알리기' : ''}는 이제 홈 채팅에서 해요`;
export const MINE_MOVED_ASKS = [
  { text: '내 예약 보기', ask: '내 예약 보여 줘' },
  { text: '내 요청 보기', ask: '내가 보낸 요청 어떻게 됐어?' },
  { text: '나에게 온 요청 보기', ask: '나한테 온 요청 있어?' },
  { text: '자리비움 알리기', ask: '자리비움 알릴게요' },
] as const;
