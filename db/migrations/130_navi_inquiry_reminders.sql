-- 미처리 문의 다시 알림(11/25): 받은 팀에 "아직 확인하지 않은 문의 N건", "곧 지워질 문의 N건"을 한 번씩만 보내려고 보낸 시각을 남겨요.
-- 문의와 같이 7일 뒤 지워져요. 칸 더하기만이라 앞 판도 그대로 떠요(장애런북 3절).
alter table navi_inquiries add column unseen_reminded_at timestamptz;
alter table navi_inquiries add column expiry_warned_at timestamptz;
