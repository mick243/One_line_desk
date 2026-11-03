-- 보관 회차 인덱스(11/3, ADR-21 개정). 문의를 열 때 지우던 것을 빼고 한 시간 보관 회차에서만 지워요.
-- 보관 회차는 navi_inquiries.created_at·navi_feedback.at로 7일 지난 행을 찾아요. 앞 칸이 부서·보낸 사람인 기존 인덱스로는 찾지 못해서 더해요.
create index if not exists navi_inquiries_created on navi_inquiries (created_at);
create index if not exists navi_feedback_at on navi_feedback (at);
