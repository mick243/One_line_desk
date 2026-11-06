-- 사내 카페 주문(11/6 사용자 결정, PRD F4·ADR-29, 출시 기본 끔). 새 모듈 종류 cafeteria를 공통 표가 받게 넓혀요.
-- 010_core.sql은 이미 적용돼서 고치지 않고 새 파일로 제약만 바꿔요. 카페 모듈 표는 610_cafe.sql에 있어요.
-- plans: 주문은 확인 시트(plan 'cafeteria:order')로만 들어가요(ADR-03).
alter table plans drop constraint plans_module_check;
alter table plans add constraint plans_module_check check (module in ('navi', 'notices', 'rooms', 'pantry', 'cafeteria'));

-- notifications: 음료가 나오면 주문한 사람에게 "새 알림이 있어요"가 가고, 누르면 카페 페이지(cafe)로 가요. 알림 글에 메뉴·금액은 없어요(ADR-16).
alter table notifications drop constraint notifications_module_check;
alter table notifications add constraint notifications_module_check check (module in ('navi', 'notices', 'rooms', 'pantry', 'cafeteria', 'core'));
alter table notifications drop constraint notifications_page_check;
alter table notifications add constraint notifications_page_check check (page in ('home', 'navi', 'rooms', 'notices', 'board', 'mine', 'ops', 'chart', 'cafe'));
