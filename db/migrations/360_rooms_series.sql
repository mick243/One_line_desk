-- 회의실 매주 반복 예약(11/5 사용자 결정, ADR-19 보강).
-- 확인 시트 한 번(plan 하나)으로 같은 회의실을 매주 같은 시간에 여러 번 잡아요. 한 번 한 번은 따로 된 예약 줄이고,
-- 따로 취소해요. 같은 plan의 몇 번째 주인지(series_no, 0부터)로 줄을 나눠서 "plan 하나에 예약 하나"였던 제약을
-- "plan 하나·주 하나에 예약 하나"로 바꿔요. 같은 plan을 두 번 실행해도 주마다 한 줄뿐이에요(멱등은 그대로).
-- 보관은 그대로예요: 끝나고 7일 뒤 지워져요(ADR-21).
alter table room_reservations add column series_no smallint not null default 0 check (series_no between 0 and 11);
alter table room_reservations drop constraint room_reservations_plan_id_key;
alter table room_reservations add constraint room_reservations_plan_series unique (plan_id, series_no);
