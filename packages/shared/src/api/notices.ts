/** 공지 찾기 결과. 이번 2주는 제목·게시일·원문 링크만이고 본문·요약은 없어요(M6, ADR-14). */
export interface NoticeHit {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  postedOn: string;
  url: string;
  board: string;
}

/** 검색어 길이 상한(ADR-14: 들어오는 값은 남의 입력으로 보고 길이를 제한해요). */
export const NOTICE_QUERY_MAX_LENGTH = 100;
/** 한 번에 돌려주는 공지 수 상한 */
export const NOTICE_SEARCH_MAX_HITS = 10;
/** 내보내는 제목 길이 상한. 넘으면 잘라요. */
export const NOTICE_TITLE_MAX_LENGTH = 120;

// ── 새 공지 알림 대상(11/6 사용자 요청, ADR-09 개정·ADR-16 보강) ──
// 새 공지 사본이 들어오면 AI가 공지 글만 보고 대상 조건(부서·층·역할 또는 모두)을 제안하고, 총무가 확인해야 알림이 가요.
// AI는 제안만 해요. 보내기는 총무의 고정 버튼 [알리기]이고(ADR-03), 자동 보내기 스위치(noticeAutoSend, 기본 끔)를 켰을 때만 확인 없이 가요.
// 알림 글에는 공지 제목·본문을 넣지 않아요. 대상 수는 서버가 직원 명단으로 세서 수만 보여 줘요(이름 목록 없음).

/** 알림 대상으로 고를 수 있는 역할(IdP 역할 그룹). 모델에는 한글 이름만 보내요. */
export const NOTICE_AUDIENCE_ROLES = ['team-lead', 'facilities'] as const;
export type NoticeAudienceRole = (typeof NOTICE_AUDIENCE_ROLES)[number];
export const NOTICE_AUDIENCE_ROLE_LABEL: Record<NoticeAudienceRole, string> = { 'team-lead': '팀장', facilities: '총무' };

/** 대상 조건. 칸끼리는 "또는"이에요(어느 하나에 맞으면 받아요, 놓치는 사람이 없게). everyone이면 다른 칸은 비어요. */
export interface NoticeAudience {
  everyone: boolean;
  departments: string[];
  floors: string[];
  roles: NoticeAudienceRole[];
}

export const NOTICE_AUDIENCE_LIMITS = {
  /** 부서·층 칸마다 고를 수 있는 수 */
  maxEach: 30,
  /** 부서·층 이름 길이 */
  nameMax: 40,
  /** 근거 말 수와 길이(공지 글에 그대로 있는 말만) */
  evidenceMax: 3,
  evidenceLength: 20,
} as const;

/** 확인 대기 · 보냄 · 알리지 않음 */
export type NoticeAudienceState = 'pending' | 'sent' | 'skipped';

/** 총무 확인 화면의 공지 한 건 */
export interface NoticeAudienceItem {
  id: string;
  /** 제목·게시일·원문 링크·게시판(본문 없음) */
  notice: NoticeHit;
  /** 제안한 조건(보냈으면 보낸 조건) */
  audience: NoticeAudience;
  /** 조건에 맞는 재직자 수. 서버가 직원 명단으로 세요. 이름은 내보내지 않아요. 보냈으면 보낸 수예요. */
  count: number;
  /**
   * 제안의 근거: 공지 글에 고치지 않고 그대로 있는 말(최대 3개). 모델이 낸 말도 서버가 원문과 대조해 없는 말은 버려요(ADR-09).
   * 비어 있으면 공지 글에서 부서·층·역할 이름을 찾지 못해 모두에게 보내는 안이에요.
   */
  evidence: string[];
  /** 실제 모델이 제안했는지("AI 정리"). 규칙이면 거짓이에요. */
  byModel: boolean;
  state: NoticeAudienceState;
  /** 자동 보내기 스위치로 확인 없이 보냈는지 */
  auto: boolean;
  /** "11월 6일(금) 10:02" */
  createdAt: string;
  decidedAt?: string;
}

/** GET /api/notices/audience(총무). 최근 7일, 확인 대기 먼저예요. */
export interface NoticeAudienceListResponse {
  items: NoticeAudienceItem[];
  /** 칩으로 고를 수 있는 이름들(재직자 명단의 부서·층, 정해진 역할) */
  options: { departments: string[]; floors: string[]; roles: { code: NoticeAudienceRole; label: string }[] };
  /** 자동 보내기 스위치(운영, 기본 끔) */
  autoSend: boolean;
}

/** POST /api/notices/audience/count(총무): [대상 바꾸기]에서 고친 조건의 대상 수만 */
export interface NoticeAudienceCountRequest {
  audience: NoticeAudience;
}
export interface NoticeAudienceCountResponse {
  count: number;
}

/**
 * POST /api/notices/audience/:id/send(총무 [알리기], 고정 버튼). audience가 있으면 [대상 바꾸기]로 고친 조건으로 보내요.
 * 공지 한 건에 한 번만 가요: 같은 사람이 두 번 누르면 처음 결과를, 다른 총무가 이미 처리했으면 409예요.
 * [알리지 않기]는 POST /api/notices/audience/:id/skip(본문 없음)이에요.
 */
export interface NoticeAudienceSendRequest {
  audience?: NoticeAudience;
}
export interface NoticeAudienceDecisionResponse {
  id: string;
  state: Exclude<NoticeAudienceState, 'pending'>;
  /** 알림을 보낸 사람 수(알리지 않기면 0) */
  sent: number;
}

/** 공지 탭 "새 공지" 한 줄. forMe는 나에게 알림이 간 공지예요. */
export interface NewNoticeItem extends NoticeHit {
  forMe: boolean;
}
/** GET /api/notices/new: 최근 7일 들어온 새 공지(제목·게시일·원문 링크만). 알림 대상이 아닌 사람도 그대로 봐요. */
export interface NewNoticesResponse {
  items: NewNoticeItem[];
}

/** 화면·알림 문구(화면설계 "보안이 보이는 문구" 표 그대로) */
export const NOTICE_AUDIENCE_TEXT = {
  /** 총무(역할 facilities)에게 가는 알림 */
  notifyReview: '새 공지 알림 대상을 확인해 주세요',
  /** 대상자 각자에게 가는 알림. 공지 제목·본문은 넣지 않아요. */
  notifyTarget: '나에게 해당할 수 있는 새 공지가 있어요',
  reviewHead: '새 공지 알림 대상 확인',
  reviewHint: 'AI가 공지 글만 보고 대상을 제안했어요. 맞는지 보고 [알리기]를 눌러야 알림이 가요. 대상자 이름은 보여 주지 않고 수만 세요.',
  noEvidence: '공지 글에서 부서·층·역할 이름을 찾지 못해 모두에게 보내는 안이에요',
  sendTitle: '이 공지를 대상자에게 알릴까요?',
  sendLine: '대상자 각자에게 "나에게 해당할 수 있는 새 공지가 있어요" 알림이 가요. 알림에는 공지 제목·내용이 들어가지 않아요.',
  sendKeep: '대상이 아닌 사람도 공지 탭에서는 이 공지를 그대로 봐요.',
  skipTitle: '이 공지는 알리지 않을까요?',
  skipLine: '알림은 가지 않아요. 공지는 공지 탭에서 그대로 보여요.',
  newHead: '새 공지',
  forMe: '나에게 해당할 수 있어요',
  newHint: '알림은 공지 내용을 보고 고른 사람에게만 가요. 모든 공지는 여기서 누구나 봐요.',
} as const;
