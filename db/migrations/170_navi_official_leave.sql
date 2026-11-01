-- 공가 요청(11/1). 휴가 요청(kind = 'leave')에 종류(연차·공가)와 공가 사유 코드를 더해요.
-- 공가 사유는 정해진 코드만 받아요. 공가는 연차에서 빠지지 않고, 승인하면 근태 기록에 공가로 들어가요.
-- 같은 navi_inquiries 줄이라 7일 보관·지우기(ADR-21)는 그대로예요. 병가는 결정 뒤 새 마이그레이션으로 더해요.
-- 기본값 없는 칸이라 표를 다시 쓰지 않아요. 두 칸을 문장 하나로 더하고, 이미 있는 휴가 요청(7일 안)만 연차로 채워요.
-- leave_type 값 검사는 아래 모양 검사 하나가 같이 해요(칸마다 검사를 따로 두지 않아요).
-- check는 결과가 null이면 통과라서, 휴가 요청은 leave_type is not null을 맨 앞에 둬요(빈 종류가 빠져나가지 않게).

alter table navi_inquiries
  add column leave_type text,
  add column leave_reason_code text check (leave_reason_code in ('reserve', 'vote', 'summons', 'duty'));

update navi_inquiries set leave_type = 'annual' where kind = 'leave';

alter table navi_inquiries add constraint navi_inquiries_leave_type_shape check (
  case kind
    when 'leave' then leave_type is not null and leave_type in ('annual', 'official') and (leave_type = 'annual') = (leave_reason_code is null)
    else leave_type is null and leave_reason_code is null
  end
);
