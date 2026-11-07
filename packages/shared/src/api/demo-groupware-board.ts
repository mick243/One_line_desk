// 시연 전용 가상 그룹웨어 게시판(11/6 사용자 요청, 공지 알림 대상 시연). 가상 그룹웨어 전자결재(demo-groupware.ts)와 같은 시연 전용 장치예요.
// 11/6 사용자 결정: 가상 그룹웨어는 "시연 무대"로만 두고 키우지 않아요. 게시판은 제목·본문을 올리면 앱의 공지 사본에 들어오는 것까지만이에요
// (게시판 고르기·댓글·첨부·수정·삭제·권한 없음).
// 시연 설정에서만 경로가 열려요(/api/demo/groupware/board*, 화면 /demo/groupware/board). 운영에는 경로가 없어요(404).
// 게시 글은 가상 그룹웨어 메모리에만 있어요(상한·7일, 서버가 다시 뜨면 비워짐). 올린 사람 이름은 두지 않아요.

/** 가상 게시판 글이 들어가는 게시판. 한 줄 데스크가 사본을 가져오는 허용 게시판이에요. */
export const DEMO_BOARD_NAME = '전사 공지';
/** 가상 게시판 글 ID 앞머리. 공지 사본에서 방문자가 올린 글을 가려 7일 뒤 지우는 데 써요(11/7). */
export const DEMO_BOARD_ID_PREFIX = 'GB-';
export const DEMO_BOARD_TITLE_MAX = 100;
export const DEMO_BOARD_BODY_MAX = 2000;

/** 게시 글 한 건 */
export interface DemoBoardPost {
  id: string;
  title: string;
  /** 본문(공통 입력 검사를 지난 글). 가상 그룹웨어 메모리에만 있어요. */
  body: string;
  /** YYYY-MM-DD */
  postedOn: string;
  /** "11월 6일(금) 10:02" */
  createdAt: string;
}

/** GET /api/demo/groupware/board: 새 글 먼저 */
export interface DemoBoardResponse {
  posts: DemoBoardPost[];
}

/** POST /api/demo/groupware/board/posts */
export interface DemoBoardPostRequest {
  title: string;
  body: string;
  requestId: string;
}

export interface DemoBoardPostResponse {
  post: DemoBoardPost;
  /**
   * 한 줄 데스크 공지 사본에 들어갔는지와 알림 대상 상태.
   * pending = 총무 확인 대기, sent = 자동 보내기로 보냄, null = 공지 기능이 꺼져 제안하지 않음
   */
  copy: { copied: boolean; audience: 'pending' | 'sent' | null };
}

/** 화면 문구 */
export const DEMO_BOARD_TEXT = {
  copied: '한 줄 데스크 공지 사본에 들어갔어요. AI가 알림 대상을 제안했고, 총무가 확인하면 대상자에게 알림이 가요.',
  copiedAuto: '한 줄 데스크 공지 사본에 들어갔어요. 자동 보내기가 켜져 있어서 AI가 제안한 대상자에게 바로 알림이 갔어요.',
  copiedOff: '한 줄 데스크 공지 사본에 들어갔어요. 공지 기능이 꺼져 있어서 알림 대상은 제안하지 않았어요.',
  notCopied: '한 줄 데스크 공지 사본에 들어가지 않았어요.',
  hint: '시연에서는 다른 사람도 이 글을 봐요. 진짜 회사 공지·이름·연락처는 쓰지 마세요.',
} as const;
