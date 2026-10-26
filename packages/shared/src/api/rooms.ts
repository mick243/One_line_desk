import type { Card, CardAction } from '../cards';
import { EQUIPMENT, type Equipment } from './slots';

/** 빈 회의실 찾기 조건. MCP rooms_find_free 입력과 같아요(ADR-14). */
export interface RoomQuery {
  date: string;
  start: string;
  minutes: number;
  people: number;
  equipment: Equipment[];
  floor?: string;
}

/** 화면용 회의실 후보. 예약자·회의 제목 칸은 타입에 아예 없어요(ADR-06). */
export interface RoomCandidate {
  roomId: string;
  roomName: string;
  floor: string;
  /** ISO 시각(+09:00) */
  start: string;
  end: string;
  matched: string[];
}

export interface RoomSearchResult {
  /** 현황 조회 시각(ISO). 화면에 "현황 HH:MM 기준"으로 보여 줘요(D6). */
  checkedAt: string;
  mock: boolean;
  /** 최대 3개 */
  candidates: RoomCandidate[];
  /** 후보가 없을 때 가까운 시간 대안 최대 2개(R5) */
  alternatives: RoomCandidate[];
}

/** POST /api/rooms/search 본문. 조건 칩을 고친 뒤 다시 찾아요. 아무것도 쓰지 않아요. */
export interface RoomSearchRequest {
  query: Partial<RoomQuery>;
}

/** POST /api/rooms/recheck 본문(M3 앱 확인 링크). 링크를 연 것만으로는 아무것도 쓰지 않아요. */
export interface RoomRecheckRequest {
  proposalToken: string;
}

/** POST /api/rooms/search · /api/rooms/recheck 응답. 첫 카드는 조건 칩 카드예요. */
export interface RoomCardsResponse {
  /** 현황 조회 시각(ISO) */
  checkedAt: string;
  cards: Card[];
}

/** S1·S6 "내 예약" 한 줄. 내 예약만 와요. */
export interface MyReservation {
  id: string;
  roomName: string;
  floor: string;
  /** ISO 시각(+09:00) */
  start: string;
  end: string;
  /** "10월 27일(화) 15:00~16:00" */
  when: string;
  /** [취소]. 확인 시트를 먼저 띄우는 고정 버튼이에요(ADR-03). */
  cancel: CardAction;
}

/** GET /api/rooms/my-reservations. enabled가 거짓이면(회의실 끔·링크만·쓰기 끔) 내 예약 칸을 숨겨요(R4). */
export interface MyReservationsResponse {
  enabled: boolean;
  items: MyReservation[];
}

/** DELETE /api/rooms/reservations/:id 응답. 확정 카드가 "취소됨"으로 바뀌어요. */
export interface RoomCancelResponse {
  status: 'done';
  card: Card;
}

// 조건 칩 카드(S2 "조건 칩 줄"). 서버가 칸에 값을 넣고, 웹이 칩으로 그려 고치게 해요.
export const ROOM_CONDITIONS_VARIANT = 'rooms-conditions';
export const ROOM_CONDITION_MISSING = '알려 주세요';
const ANY_EQUIPMENT = '없어도 돼요';
const ANY_FLOOR = '상관없어요';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 조건을 카드 칸으로 바꿔요. 빠진 값은 "알려 주세요"예요. */
export function roomConditionFields(query: Partial<RoomQuery>): { name: string; value: string }[] {
  const day = query.date ? WEEKDAYS.at(new Date(`${query.date}T00:00:00Z`).getUTCDay()) : undefined;
  return [
    { name: '날짜', value: query.date ? `${query.date}(${day ?? ''})` : ROOM_CONDITION_MISSING },
    { name: '시작', value: query.start ?? ROOM_CONDITION_MISSING },
    { name: '길이', value: query.minutes ? `${query.minutes}분` : ROOM_CONDITION_MISSING },
    { name: '인원', value: query.people ? `${query.people}명` : ROOM_CONDITION_MISSING },
    { name: '장비', value: query.equipment?.length ? query.equipment.join(', ') : ANY_EQUIPMENT },
    { name: '층', value: query.floor ?? ANY_FLOOR },
  ];
}

/** 조건 칩 카드의 칸을 다시 조건으로 읽어요. 알아볼 수 없는 값은 빠진 값으로 봐요. */
export function parseRoomConditionFields(fields: { name: string; value: string }[]): Partial<RoomQuery> {
  const get = (name: string) => fields.find((f) => f.name === name)?.value ?? '';
  const query: Partial<RoomQuery> = {};
  const date = get('날짜').match(/^(\d{4}-\d{2}-\d{2})/);
  if (date) query.date = date[1]!;
  const start = get('시작').match(/^(\d{2}:\d{2})$/);
  if (start) query.start = start[1]!;
  const minutes = get('길이').match(/^(\d+)분$/);
  if (minutes) query.minutes = Number(minutes[1]);
  const people = get('인원').match(/^(\d+)명$/);
  if (people) query.people = Number(people[1]);
  query.equipment = EQUIPMENT.filter((e) =>
    get('장비')
      .split(',')
      .map((s) => s.trim())
      .includes(e),
  );
  const floor = get('층').match(/^(\d{1,2}층)$/);
  if (floor) query.floor = floor[1]!;
  return query;
}
