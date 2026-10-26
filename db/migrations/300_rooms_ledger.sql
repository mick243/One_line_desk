-- 회의실 장부(ADR-05·06). 001의 room_reservations를 모의 장부로 써요.
-- - 'ledger': 모의 장부 어댑터가 가져온 남의 예약. 예약자 이름·회의 제목은 어댑터에서 버리고 가명 값만 넣어요. plan이 없어요.
-- - 'app': 사람이 확인 시트에서 확인한 plan으로만 생겨요. plan_id가 꼭 있어요.
alter table room_reservations add column source text not null default 'app' check (source in ('app', 'ledger'));
alter table room_reservations alter column plan_id drop not null;
alter table room_reservations add constraint room_reservations_plan_by_source check ((source = 'app') = (plan_id is not null));
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
