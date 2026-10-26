/** 앞문 라우터가 뽑는 슬롯(ADR-02). rooms는 날짜·시작·길이·인원·장비·층, pantry는 품목 이름이에요. */
export interface Slots {
  /** YYYY-MM-DD (한국 날짜) */
  date?: string;
  /** HH:MM (한국 시각) */
  start?: string;
  minutes?: number;
  people?: number;
  equipment?: Equipment[];
  /** '3층'처럼 */
  floor?: string;
  itemName?: string;
}

// 회의실 장비는 정해진 목록이에요(ADR-14 입력 검증).
export const EQUIPMENT = ['화면', '화상회의', '화이트보드'] as const;
export type Equipment = (typeof EQUIPMENT)[number];
