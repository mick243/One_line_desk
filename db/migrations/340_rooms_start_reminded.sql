-- 회의 시작 10분 전 알림(11/25): 예약마다 한 번만 보내려고 보낸 시각을 남겨요. 예약과 같이 7일 뒤 지워져요. 칸 더하기만이에요.
alter table room_reservations add column start_reminded_at timestamptz;
