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
