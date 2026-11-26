-- [답 안 한 사람에게 다시 알리기](11/25): 예약한 사람이 누르면 아직 답하지 않은 사람에게 앱 알림을 한 번 더 보내요.
-- 한 사람에게 한 회의마다 한 번만 보내려고 보낸 시각을 남겨요. 초대 줄과 같이 예약과 함께 7일 뒤 지워져요. 칸 더하기만이에요.
alter table room_invites add column reminded_at timestamptz;
