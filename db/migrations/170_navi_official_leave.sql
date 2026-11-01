-- 공가 요청(11/1). 휴가 요청(kind = 'leave')에 종류(연차·공가)와 공가 사유 코드를 더해요.
-- 공가 사유는 정해진 코드만 받아요. 공가는 연차에서 빠지지 않고, 승인하면 근태 기록에 공가로 들어가요.
-- 같은 navi_inquiries 줄이라 7일 보관·지우기(ADR-21)는 그대로예요. 병가는 결정 뒤 새 마이그레이션으로 더해요.

alter table navi_inquiries add column leave_type text check (leave_type in ('annual', 'official'));
alter table navi_inquiries add column leave_reason_code text check (leave_reason_code in ('reserve', 'vote', 'summons', 'duty'));
update navi_inquiries set leave_type = 'annual' where kind = 'leave';
alter table navi_inquiries add constraint navi_inquiries_leave_type_shape check (
  (kind = 'leave' and leave_type = 'annual' and leave_reason_code is null)
  or (kind = 'leave' and leave_type = 'official' and leave_reason_code is not null)
  or (kind = 'general' and leave_type is null and leave_reason_code is null)
);
