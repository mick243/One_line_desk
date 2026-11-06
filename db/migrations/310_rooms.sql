-- 회의실(ADR-05·06·17·19). 10/30: 옛 001의 회의실 표와 300~303을 한 파일로 합쳤어요.
-- 11/6: 320(인덱스)·340(여러 팀 회의)·350(초대 "못 가요"·대신 부탁)·360(매주 반복 예약)을 이 파일로 합쳤어요(최종 구조는 같아요).
-- 모의 장부가 원본이고, 같은 방·겹치는 시간은 DB가 막아요.

-- 방. equipment(정해진 목록)는 찾기 조건이고, facilities는 화면에 보여 주는 설명이에요.
-- photo_url·facilities는 장부가 주는 값이에요(시연은 그림 주소와 가상 설비, 10/26 회의실 둘러보기).
create table rooms (
  id text primary key,
  name text not null,
  floor text not null,
  capacity integer not null check (capacity > 0),
  equipment text[] not null default '{}',
  photo_url text,
  facilities text[] not null default '{}'
);

-- 예약(모의 장부).
-- - 'ledger': 모의 장부 어댑터가 가져온 남의 예약. 예약자 이름·회의 제목은 어댑터에서 버리고 가명 값만 넣어요. plan이 없어요.
-- - 'app': 사람이 확인 시트에서 확인한 plan으로만 생겨요. plan_id가 꼭 있어요.
-- series_no(11/5 사용자 결정, ADR-19 보강): 매주 반복 예약. 확인 시트 한 번(plan 하나)으로 같은 방을 매주 같은 시간에 여러 번 잡아요.
--   한 번 한 번은 따로 된 예약 줄이고 따로 취소해요. 몇 번째 주인지(0부터)로 줄을 나눠 "plan 하나·주 하나에 예약 하나"예요
--   (room_reservations_plan_series). 같은 plan을 두 번 실행해도 주마다 한 줄뿐이에요(멱등).
create table room_reservations (
  id bigserial primary key,
  room_id text not null references rooms (id),
  slot tstzrange not null check (not isempty(slot)),
  pseudonym_id text not null,
  plan_id uuid,
  created_at timestamptz not null default now(),
  source text not null default 'app' check (source in ('app', 'ledger')),
  series_no smallint not null default 0 check (series_no between 0 and 11),
  exclude using gist (room_id with =, slot with &&),
  constraint room_reservations_plan_by_source check ((source = 'app') = (plan_id is not null)),
  constraint room_reservations_plan_series unique (plan_id, series_no)
);
create index room_reservations_pseudonym on room_reservations (pseudonym_id);

-- 확인되지 않은 plan으로 생긴 예약 0건(F2 완료 기준)을 DB에서도 지켜요.
-- 앱 예약은 같은 사람의 회의실 예약 plan이 실행 중일 때만 들어가요. 실행 중 = 확인 버튼이 이긴 plan이에요(ADR-03).
create function rooms_require_confirmed_plan() returns trigger
language plpgsql as $$
begin
  if new.source = 'app' and not exists (
    select 1
      from plans p
     where p.id = new.plan_id
       and p.pseudonym_id = new.pseudonym_id
       and p.module = 'rooms'
       and p.action = 'reserve'
       and p.state = 'executing'
  ) then
    raise exception 'room reservation needs a confirmed plan' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger room_reservations_confirmed_plan
  before insert on room_reservations
  for each row execute function rooms_require_confirmed_plan();

-- 취소한 예약은 여기로 옮겨요. 그래서 겹침 제약에 조건을 달지 않아요.
create table room_reservation_history (
  id bigint primary key,
  room_id text not null,
  slot tstzrange not null,
  pseudonym_id text not null,
  plan_id uuid not null,
  created_at timestamptz not null,
  cancelled_at timestamptz not null default now()
);
-- 보관 기간(7일, RECORD_KEEP_DAYS)이 지난 취소 이력 지우기(11/3, modules/rooms/repo.ts: cancelled_at < $1).
create index room_reservation_history_cancelled on room_reservation_history (cancelled_at);

-- 회의 참석자 초대(10/26, ADR-17). 예약한 사람이 고른 사람에게만 알려요.
-- 사람은 IdP 주체(직원 명단 열쇠)와 가명 ID로 적어요. 이름·메일은 적지 않고 그때그때 직원 명단에서 찾아요.
-- 예약이 취소되면(예약 표에서 이력 표로 옮기면) 참석자에게 알린 뒤 함께 지워져요.
-- "못 가요" 사유와 대신 부탁(11/4 사용자 결정, ADR-17 보강):
-- - decline_reason: 못 간다고 할 때 꼭 적는 사유(공통 입력 검사를 지난 글, 200자까지). 부른 사람에게만 보여요.
-- - delegated_by_*·delegate_reason: 초대받은 사람이 같은 팀 다른 사람에게 대신 가 달라고 부탁해서 생긴 초대예요.
--   부탁한 사람(가명 ID·IdP 주체, 이름은 보여 줄 때 디렉터리로 찾아요)과 꼭 적는 사유. 부탁받은 사람과 부른 사람에게만 보여요.
-- 글은 알림·감사 로그·AI로 보내지 않아요. 예약과 함께 끝난 지 7일 뒤 지워져요(ADR-21, room_reservations on delete cascade).
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
  decline_reason text check (decline_reason is null or char_length(decline_reason) between 1 and 200),
  delegated_by_pseudonym text,
  delegated_by_subject text,
  delegate_reason text check (delegate_reason is null or char_length(delegate_reason) between 1 and 200),
  primary key (reservation_id, attendee_pseudonym)
);
create index room_invites_attendee on room_invites (attendee_pseudonym);

-- 회의실 장비 대여·설비 상태(10/28, ADR-19).
-- - room_equipment: 빌릴 수 있는 이동식 장비 재고(빔프로젝터·노트북 등). 총무 보관함에 있어요.
-- - room_equipment_loans: 대여. 같은 장비 같은 시간 겹침은 DB가 막아요. 회의에 붙여 빌리면 회의를 취소할 때 함께 지워져요.
-- - room_facility_status: 방에 붙은 설비(화면·화상회의·화이트보드)의 점검 상태. 줄이 없으면 정상이에요.
create table room_equipment (
  id text primary key,
  kind text not null,
  name text not null,
  home text not null,
  status text not null default 'ok' check (status in ('ok', 'repair'))
);

create table room_equipment_loans (
  id bigserial primary key,
  item_id text not null references room_equipment (id),
  slot tstzrange not null check (not isempty(slot)),
  pseudonym_id text not null,
  plan_id uuid not null unique,
  reservation_id bigint references room_reservations (id) on delete cascade,
  created_at timestamptz not null default now(),
  exclude using gist (item_id with =, slot with &&)
);
create index room_equipment_loans_pseudonym on room_equipment_loans (pseudonym_id);
create index room_equipment_loans_reservation on room_equipment_loans (reservation_id);

-- 대여도 같은 사람의 실행 중인 회의실 plan(장비 대여)으로만 들어가요(ADR-03·19).
create function rooms_loan_require_plan() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1
      from plans p
     where p.id = new.plan_id
       and p.pseudonym_id = new.pseudonym_id
       and p.module = 'rooms'
       and p.action = 'rent'
       and p.state = 'executing'
  ) then
    raise exception 'equipment loan needs a confirmed plan' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger room_equipment_loans_plan
  before insert on room_equipment_loans
  for each row execute function rooms_loan_require_plan();

create table room_facility_status (
  room_id text not null references rooms (id),
  facility text not null,
  status text not null check (status in ('ok', 'repair')),
  updated_at timestamptz not null default now(),
  primary key (room_id, facility)
);

-- 여러 팀 회의 참석자 고르기(11/4 사용자 결정, ADR-28).
-- - room_team_delegates: 팀장이 마이 페이지에서 정한 "팀 회의 담당자"(자기 대신 참석자를 고를 같은 부서 사람, 최대 2명).
--   팀장은 IdP 역할(team-lead)로 정해지고 이 표에 넣지 않아요. 가명 ID와 IdP 주체(팀장에게 이름을 보여 줄 때 디렉터리로 찾으려고)만 두고
--   이름·메일은 넣지 않아요. 설정이라 쌓이지 않아요. 퇴사·부서 이동한 사람은 읽을 때 걸러요.
-- - room_joint_requests: 여러 팀 회의를 예약하면 팀마다 한 줄. 그 팀 팀장·담당자 중 먼저 답한 사람이 참석자를 골라요.
--   부서 이름·수·상태와 부른 사람(IdP 주체, 참석자에게 부른 사람 이름을 보여 주려고)만 두고, 고른 사람은 초대(room_invites)로 남아요.
--   예약이 지워지면 같이 지워지고, 만든 지 7일 지난 줄은 한 시간 보관 회차가 지워요(ADR-21, rooms 모듈 retention).
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
