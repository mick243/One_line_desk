-- 보관 지우기 감시(11/25): 같은 보관 단계가 3번 연달아 실패하면 운영자(역할 operator)에게 앱 알림이 가요.
-- 알림 글에는 단계 이름도 넣지 않고 "계속 실패하고 있어요"와 운영 페이지만 가요. 역할 알림이라 사람 목록은 들지 않아요.
alter table notifications drop constraint notifications_audience_role_check;
alter table notifications add constraint notifications_audience_role_check check (audience_role in ('facilities', 'operator'));
