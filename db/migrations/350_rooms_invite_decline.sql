-- 초대받은 회의 "못 가요" 사유와 대신 부탁(11/4 사용자 결정, ADR-17 보강).
-- - decline_reason: 못 간다고 할 때 꼭 적는 사유(공통 입력 검사를 지난 글, 200자까지). 부른 사람에게만 보여요.
-- - delegated_by_*·delegate_reason: 초대받은 사람이 같은 팀 다른 사람에게 대신 가 달라고 부탁해서 생긴 초대예요.
--   부탁한 사람(가명 ID·IdP 주체, 이름은 보여 줄 때 디렉터리로 찾아요)과 꼭 적는 사유. 부탁받은 사람과 부른 사람에게만 보여요.
-- 글은 알림·감사 로그·AI로 보내지 않아요. 예약과 함께 끝난 지 7일 뒤 지워져요(ADR-21, room_reservations on delete cascade).
alter table room_invites add column decline_reason text check (decline_reason is null or char_length(decline_reason) between 1 and 200);
alter table room_invites add column delegated_by_pseudonym text;
alter table room_invites add column delegated_by_subject text;
alter table room_invites add column delegate_reason text check (delegate_reason is null or char_length(delegate_reason) between 1 and 200);
