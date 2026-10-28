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
