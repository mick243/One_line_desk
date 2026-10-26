import type { CardAction } from '../cards';

// 회의 참석자 초대(10/26, ADR-17). 예약한 사람이 고른 사람에게만 알려요.
// 받는 길: 앱 안 알림(늘) · 그룹웨어 캘린더 초대(고르면) · Slack DM(고르면). 캘린더 파일(.ics)은 예약한 사람과 초대받은 사람이 받아요.

/** 한 예약에 부를 수 있는 사람 수 */
export const INVITE_MAX = 20;
/** 직원 검색 한 번에 보여 주는 사람 수. 명단을 통째로 주지 않아요. */
export const PEOPLE_SEARCH_LIMIT = 8;

/** 직원 검색 결과 한 사람. ref는 서버가 서명한 값이라 그대로 돌려보내요. 이름·부서·층만 보여요. */
export interface PersonHit {
  ref: string;
  name: string;
  department: string;
  floor: string;
}

export interface PeopleSearchResponse {
  items: PersonHit[];
}

/** POST /api/rooms/reservations/:id/invites 본문. 같은 requestId로 두 번 와도 한 번만 보내요. */
export interface InviteRequest {
  people: string[];
  calendar: boolean;
  slack: boolean;
  requestId: string;
}

export type InviteResponse = 'pending' | 'accepted' | 'declined';

export const INVITE_RESPONSE_LABEL: Record<InviteResponse, string> = {
  pending: '답 기다리는 중',
  accepted: '참석',
  declined: '못 가요',
};

/** 예약한 사람이 보는 참석자 한 사람 */
export interface ReservationAttendee {
  name: string;
  department: string;
  response: InviteResponse;
}

/** 초대받은 회의 한 줄(초대받은 사람만 봐요) */
export interface InvitedMeeting {
  reservationId: string;
  roomName: string;
  floor: string;
  when: string;
  start: string;
  end: string;
  inviter: { name: string; department: string };
  response: InviteResponse;
  /** 캘린더 파일 받기 주소 */
  icsPath: string;
  actions: CardAction[];
}

export interface InvitedMeetingsResponse {
  enabled: boolean;
  items: InvitedMeeting[];
}

/** 초대에 쓸 수 있는 바깥 길. 이름 뒤 "(모의)"면 시연용이에요. 없으면 그 길을 고를 수 없어요. */
export interface InviteChannels {
  calendar: string | null;
  slack: string | null;
}

/** 시연용 모의 그룹웨어 캘린더·모의 Slack에서 나에게 온 것(GET /api/demo/inbox) */
export interface DemoInboxResponse {
  enabled: boolean;
  calendar: { uid: string; title: string; when: string; location: string; cancelled: boolean }[];
  messages: { id: string; text: string; sentAt: string }[];
}
