import type { Card } from '@one-line-desk/shared';

// 카드 머리의 종류 이름(R7). 그룹웨어 링크 카드도 그 모듈 이름이에요("회의실 · 안내", QA-13).
export const KIND_TITLE: Record<Card['kind'], string> = {
  navi: '담당',
  notices: '공지',
  rooms: '회의실',
  pantry: '탕비실',
};
