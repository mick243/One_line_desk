-- 사내 카페 3묶음(11/6 사용자 결정, PRD F4-5·ADR-29, 출시 기본 끔): [못 받았어요].
-- 직원이 자기 주문이 나왔어요·가져감인 그날 [못 받았어요](고정 버튼, 사유 글 없음)를 누르면 주문에 신고 표시가 붙고,
-- 총무가 S9에서 [청구에서 빼기]·[그대로 두기](고정 버튼)로 처리해요. 자유 글 칸은 없어요.
-- 청구에서 뺀 주문(removed)은 청구 합계·한 달 한도·매출 합계에서 빠져요. 아직 입금 확인 전 청구서가 있으면 그 청구서 합계를 주문 행에서 다시 세요.
-- 보관(ADR-21 예외, 기존 주문 규칙): 신고만 한 주문·그대로 둔 주문은 다른 주문처럼 [입금 확인] 7일 뒤 지워져요.
-- 청구에서 뺀 주문은 어느 청구서에도 들지 않아서 취소한 주문처럼 처리하고 7일 뒤 지워요.

alter table cafe_orders add column missed_status text check (missed_status in ('reported', 'removed', 'kept'));
alter table cafe_orders add column missed_at timestamptz;
alter table cafe_orders add column missed_decided_at timestamptz;
alter table cafe_orders add constraint cafe_orders_missed_at check ((missed_status is null) = (missed_at is null));
alter table cafe_orders add constraint cafe_orders_missed_decided check ((coalesce(missed_status, '') in ('removed', 'kept')) = (missed_decided_at is not null));

-- 총무 S9 "못 받았어요 확인"(처리를 기다리는 것과 처리한 것)
create index cafe_orders_missed on cafe_orders (missed_at) where missed_status is not null;
-- 보관 지우기: 청구에서 빼고 7일 지난 주문
create index cafe_orders_missed_removed on cafe_orders (missed_decided_at) where missed_status = 'removed';
