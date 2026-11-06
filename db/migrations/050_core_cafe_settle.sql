-- 사내 카페 2묶음(11/6 사용자 결정, PRD F4·ADR-29): 청구·입금 확인·한도. 공통 알림 표만 넓혀요(카페 표는 620_cafe_billing.sql).
-- 010_core.sql·040_core_cafeteria.sql은 이미 적용돼서 고치지 않고 새 파일로 바꿔요.

-- 역할에게 가는 알림: 직원이 카페 한도를 늘려 달라고 하면 총무(역할 facilities)에게 "카페 한도 요청이 왔어요"가 가요.
-- 총무는 IdP 그룹이라 사람 목록을 들고 있지 않아요. 받는 쪽 역할은 읽을 때마다 다시 계산해서(R17), 역할이 빠지면 더는 보이지 않아요.
-- 알림 글에는 이름·금액이 없어요(ADR-16).
alter table notifications add column audience_role text check (audience_role in ('facilities'));
alter table notifications drop constraint notifications_check;
alter table notifications add constraint notifications_audience_check check (num_nonnulls(audience_pseudonym, audience_department, audience_role) = 1);
create index notifications_role on notifications (audience_role, created_at desc) where audience_role is not null;

-- 알림을 누르면 가는 곳: 카페 정산(S9, 총무)
alter table notifications drop constraint notifications_page_check;
alter table notifications add constraint notifications_page_check check (page in ('home', 'navi', 'rooms', 'notices', 'board', 'mine', 'ops', 'chart', 'cafe', 'cafe-settle'));
