-- 여러 팀 회의 참석자 고르기(11/4 사용자 결정, ADR-28).
-- - room_team_delegates: 팀장이 마이 페이지에서 정한 "팀 회의 담당자"(자기 대신 참석자를 고를 같은 부서 사람, 최대 2명).
--   팀장은 IdP 역할(team-lead)로 정해지고 이 표에 넣지 않아요. 가명 ID와 IdP 주체(초대처럼, 팀장에게 이름을 보여 줄 때 디렉터리로 찾으려고)만 두고 이름·메일은 넣지 않아요.
--   설정이라 쌓이지 않아요. 퇴사·부서 이동한 사람은 읽을 때 걸러요.
-- - room_joint_requests: 여러 팀 회의를 예약하면 팀마다 한 줄. 그 팀 팀장·담당자 중 먼저 답한 사람이 참석자를 골라요.
--   부서 이름·수·상태와 부른 사람(초대처럼 IdP 주체, 참석자에게 부른 사람 이름을 보여 주려고)만 두고, 고른 사람은 초대(room_invites)로 남아요. 예약이 지워지면 같이 지워지고,
--   만든 지 7일 지난 줄은 한 시간 보관 회차가 지워요(ADR-21, rooms 모듈 retention).
create table room_team_delegates (
  department text not null,
  position smallint not null check (position in (1, 2)),
  delegate_pseudonym text not null,
  delegate_subject text not null,
  set_by_pseudonym text not null,
  set_at timestamptz not null,
  primary key (department, position)
);

create table room_joint_requests (
  id bigserial primary key,
  reservation_id bigint not null references room_reservations (id) on delete cascade,
  department text not null,
  requester_pseudonym text not null,
  requester_subject text not null,
  status text not null default 'open' check (status in ('open', 'picked', 'expired')),
  picked_by_pseudonym text,
  picked_count integer check (picked_count is null or picked_count between 0 and 200),
  estimate integer not null check (estimate between 0 and 200),
  created_at timestamptz not null,
  deadline_at timestamptz not null,
  picked_at timestamptz,
  unique (reservation_id, department)
);
create index room_joint_requests_department on room_joint_requests (department, status);
create index room_joint_requests_created on room_joint_requests (created_at);
create index room_joint_requests_deadline on room_joint_requests (status, deadline_at);
