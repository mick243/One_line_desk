-- 병가 요청(11/3, ADR-24 개정, docs/병가준비_2026-11-01.md).
-- 휴가 요청 종류에 병가(sick)를 더하고, 병가 사유 코드 칸을 더해요. 병가 사유는 정해진 선택지만 받아요(자유 글 없음, 사용자 결정 1).
-- 사유는 건강 정보를 드러내지 않는 일반 표현의 코드예요: unwell(몸이 안 좋아요)·clinic(병원 진료)·family(가족 돌봄). 병명·증상 칸은 없어요.
-- 병가는 연차에서 빠지지 않고, 승인하면 근태 기록(어댑터)에 병가로 들어가요. 병가 쓴 날 수는 저장하지 않고 열 때마다 계산해요(ADR-18).
-- 같은 navi_inquiries 표라 7일 보관·지우기(ADR-21)는 그대로예요.

alter table navi_inquiries
  add column sick_reason_code text check (sick_reason_code in ('unwell', 'clinic', 'family'));

-- 모양 검사를 바꿔요: 공가 사유는 공가일 때만, 병가 사유는 병가일 때만 있어요(둘 다 그때는 꼭 있어요).
-- check는 결과가 null이면 통과라서 휴가 요청은 leave_type is not null을 맨 앞에 둬요(110과 같아요).
alter table navi_inquiries drop constraint navi_inquiries_leave_type_shape;
alter table navi_inquiries add constraint navi_inquiries_leave_type_shape check (
  case kind
    when 'leave' then leave_type is not null
      and leave_type in ('annual', 'official', 'sick')
      and (leave_type = 'official') = (leave_reason_code is not null)
      and (leave_type = 'sick') = (sick_reason_code is not null)
    else leave_type is null and leave_reason_code is null and sick_reason_code is null
  end
);
