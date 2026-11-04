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

// ── 여러 팀 회의 참석자 고르기(11/4 사용자 결정, ADR-28) ─────────────────────────
// 여러 팀 회의를 예약하면 팀마다 그 팀 팀장·회의 담당자에게 "참석자를 골라 주세요"가 가요. 먼저 고른 사람의 선택이 초대가 돼요.

/** 팀장이 마이 페이지에서 정하는 회의 담당자 수 상한(팀장 다음 순서) */
export const TEAM_DELEGATE_MAX = 2;

/** 고르는 사람(팀장·담당자)에게 보이는 요청 하나. 같은 부서 사람 목록(이름·고르기용 ref)이 같이 와요. */
export interface JointPickRequest {
  id: string;
  /** 부른 사람 이름(부서). 초대처럼 고르는 사람에게만 보여요(ADR-17). */
  requester: string;
  department: string;
  /** "11월 5일(수) 15:00~16:00" */
  when: string;
  /** "회의실 5C · 5층" */
  room: string;
  /** 예약할 때 짐작한 이 팀 인원 */
  estimate: number;
  /** 이때까지 고르지 않으면 짐작한 인원 그대로예요(한국 시각 ISO). */
  deadline: string;
  members: { ref: string; name: string }[];
}

export interface JointRequestsResponse {
  items: JointPickRequest[];
}

export interface JointPickBody {
  /** 같은 부서 사람 ref(이 요청 목록에서 받은 것). 비우면 "우리 팀은 안 가요"예요. */
  people: string[];
  /** 그룹웨어 캘린더 초대·Slack DM도 보낼지(공개 설정의 알릴 길이 있을 때만). 앱 알림은 늘 가요. */
  calendar?: boolean;
  slack?: boolean;
  requestId: string;
}

/** 마이 페이지 "팀 회의 담당자". 팀장에게만 와요. */
export interface TeamDelegatesResponse {
  isLead: boolean;
  department: string;
  delegates: { position: number; name: string }[];
}

export interface TeamDelegatesBody {
  /** 직원 검색 ref, 순서대로 최대 TEAM_DELEGATE_MAX명. 비우면 모두 지워요. */
  people: string[];
  requestId: string;
}
