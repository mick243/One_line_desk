-- 회의 참석자 초대(10/26, ADR-17). 예약한 사람이 고른 사람에게만 알려요.
-- 사람은 IdP 주체(직원 명단 열쇠)와 가명 ID로 적어요. 이름·메일은 적지 않고 그때그때 직원 명단에서 찾아요.
-- 예약이 취소되면(예약 표에서 이력 표로 옮기면) 참석자에게 알린 뒤 함께 지워져요.
create table room_invites (
  reservation_id bigint not null references room_reservations (id) on delete cascade,
  attendee_pseudonym text not null,
  attendee_subject text not null,
  inviter_pseudonym text not null,
  inviter_subject text not null,
  response text not null default 'pending' check (response in ('pending', 'accepted', 'declined')),
  via_calendar boolean not null default false,
  via_slack boolean not null default false,
  invited_at timestamptz not null,
  responded_at timestamptz,
  primary key (reservation_id, attendee_pseudonym)
);
create index room_invites_attendee on room_invites (attendee_pseudonym);
