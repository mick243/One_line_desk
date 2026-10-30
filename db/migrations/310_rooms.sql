-- 회의실(ADR-05·06·17·19). 10/30: 옛 001의 회의실 표와 300~303을 한 파일로 합쳤어요.
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
create table room_reservations (
  id bigserial primary key,
  room_id text not null references rooms (id),
  slot tstzrange not null check (not isempty(slot)),
  pseudonym_id text not null,
  plan_id uuid unique,
  created_at timestamptz not null default now(),
  source text not null default 'app' check (source in ('app', 'ledger')),
  exclude using gist (room_id with =, slot with &&),
  constraint room_reservations_plan_by_source check ((source = 'app') = (plan_id is not null))
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
