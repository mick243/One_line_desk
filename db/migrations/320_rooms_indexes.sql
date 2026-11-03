-- 회의실 표 인덱스(11/3). 310_rooms.sql은 이미 적용돼서 고치지 않고 새 파일로 더해요.

-- 보관 기간(7일, RECORD_KEEP_DAYS)이 지난 취소 이력 지우기(modules/rooms/repo.ts: cancelled_at < $1).
create index room_reservation_history_cancelled on room_reservation_history (cancelled_at);
